# AI workflow note

## Tools used

- **Claude (Anthropic)** was my main pair programmer: scaffolding, code generation, test writing and drafting docs.
- **Claude Code in VS Code** for local edits, running the app and tests, and small fixes.
- **Playwright (headless Chromium)**, driven by AI-written scripts, to click through the UI flows as real users would.

I set the scope, the priorities and the acceptance bar. The AI wrote first drafts quickly, and every piece was reviewed, run and tested before I kept it.

## Where AI materially sped things up

- **Boilerplate at speed:** the Express routes, validation helpers, the share dialog and the CSS took minutes instead of an hour or more.
- **Test matrix:** generating the 40 API and unit tests, including the full owner/editor/viewer/stranger permission matrix and building a real `.docx` inside a test, would have been the slowest part to write by hand.
- **Format conversion:** a first draft of the HTML-to-Delta converter for imports, which I then tightened and tested on edge cases (nested lists, h4–h6, scripts, stray tags).
- **Docs:** first drafts of the README and this note, which I edited for accuracy.

## What I changed or rejected

| AI suggestion or output | What I did | Why |
|---|---|---|
| Store editor content as HTML and sanitize it | **Rejected.** I store Quill Deltas (JSON) and validate against a format allow-list | Smaller XSS surface and lossless formatting. Quill's HTML export also has a known XSS advisory and replaces spaces with non-breaking spaces. |
| SQLite file on the host | **Rejected for production.** I use Postgres (Neon), with embedded PGlite locally and in tests | Render's free disk is wiped on every deploy, so documents would vanish. PGlite keeps local setup at zero steps with the same SQL. |
| Load Quill from a CDN | **Changed** to serve it from `node_modules` | Allows a strict `script-src 'self'` CSP and has no third-party runtime dependency. |
| A session-check endpoint that copied Express's `res` object to suppress a 401 | **Rejected and refactored** into a shared `getSessionUser()` | The copy dropped prototype methods such as `clearCookie`, so it would have crashed on an expired cookie. I caught it in review. |
| Button handler using `e.currentTarget` after an `await` | **Fixed** | `currentTarget` is null after an await, so the button would never re-enable after an error. |
| Default `pg` SSL handling for Neon URLs | **Changed** to explicit TLS with certificate verification and channel binding | Removed noisy security warnings and made the TLS behavior explicit instead of implicit. |
| Real-time collaboration with WebSockets/CRDT | **Deferred**; built presence indicators on a heartbeat instead | Too much risk for the timebox. A heartbeat gives "who's here / who's typing" and 4-second sync, and optimistic versioning keeps saves safe. |
| Store a version snapshot on every autosave | **Changed** to group one person's consecutive saves within 5 minutes, and keep at most 50 | Autosave runs about every second, so the naive version produced hundreds of useless entries. |
| A first-draft loop for drawing multi-line selection highlights | **Rewritten** as a simple line walk that always moves forward | The draft's index arithmetic could fail to terminate on some selections. I caught it in review before running it. |
| Generate PDFs on the server | **Rejected** in favour of a print stylesheet plus the browser's "Save as PDF" | A headless browser or PDF library is heavy on a free instance; the browser's print engine already gives good PDFs. |

## How I verified correctness, UX and reliability

1. **Automated tests:** `npm test` runs 40 API and unit tests against a fresh in-memory Postgres. They cover auth, CSRF, validation, the permission matrix, conflict detection, import and export.
2. **Browser run-through:** a Playwright script signs in as Alice, Bob and Carol in separate sessions. It creates and formats a document, reloads to confirm formatting survives, and shares with Carol as a viewer (her editor is read-only and has no toolbar). It also checks that Alice sees Bob's edit, that a simultaneous two-user save triggers the conflict banner, and that imports work and bad files are rejected, with screenshots at every step. I reviewed the screenshots myself, which is how I found a toast hidden behind the share dialog's backdrop, and fixed it.
3. **Real database check:** ran the same flow against a real Postgres 16 server, which is the production driver path, and confirmed that seeding is idempotent across restarts.
4. **Security review:** I checked authorization on every route, IDOR (other users' document IDs return 404), upload limits, CSP headers in the browser, that the production server refuses to start without `JWT_SECRET`, and `npm audit` (one low-severity Quill advisory, in code DocFlow never calls).
5. **Manual pass on the live deployment** with the three demo accounts before submitting.
