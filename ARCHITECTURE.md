# Architecture note

## Goal and scope

The goal was the strongest *working* slice of a collaborative editor in about 4–6 hours. Three things needed to be solid: editing that feels coherent, sharing that is enforced on the server, and data that persists and can't be corrupted or silently overwritten. I chose depth in those areas over breadth.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Server | Node.js + Express 4 (plain JavaScript) | Small, well understood, and a single process serves both the API and the UI. |
| Editor | Quill 2, served from `node_modules` | Stable rich-text editor with a structured document model (Delta). Serving it ourselves means no CDN and a strict CSP. |
| Frontend | Static HTML + vanilla JS, no build step | Three screens don't justify a framework or bundler. There's less to break on deploy, and reviewers can read it directly. |
| Database | Postgres (Neon in production), PGlite locally and in tests | One SQL dialect everywhere. PGlite is real Postgres compiled to WASM, so local setup is just `npm install` and the tests run against real Postgres semantics. |
| Hosting | Render free web service + Neon free Postgres | Free, deployable from a Git repo, and the data outlives redeploys (Render's free disk does not). |

## Key decisions

**1. Store documents as Quill Deltas (JSON), not HTML.**
A Delta is structured data such as `{insert: "Hi", attributes: {bold: true}}`. The server validates every save against a strict allow-list: text only, plus bold, italic, underline, header 1–3 and ordered/bullet lists. Scripts, links, images or inline styles can never be stored, which removes the usual stored-XSS risk of saving and re-rendering user HTML. It also keeps formatting lossless across reloads. (npm audit flags an XSS advisory in Quill's HTML *export* helper. DocFlow never calls it, because content is never stored or rendered as HTML.)

**2. Imports go through an allow-list converter.**
`.docx` is converted with mammoth and `.md` with marked (raw HTML disabled). The result goes through my own HTML-to-Delta converter built on htmlparser2. It understands only headings, paragraphs, bold, italic, underline and lists and drops everything else, so unexpected input can only lose formatting and never inject anything. Uploads are held in memory and never written to disk. The server checks the file extension, the `.docx` zip signature, binary content in text files and a 2 MB size limit.

**3. Authorization lives in one query.**
`loadWithAccess()` joins the document to the caller's share row and returns their *effective* role: the strongest of ownership, a direct share, or the document's general "anyone with the link" setting (`link_access`). The result is `owner`, `editor`, `viewer` or nothing. Every route goes through it. No access returns **404**, not 403, so users can't probe which document IDs exist. Document IDs are UUIDs. Owner-only actions are delete, share, remove access and change link access. Editors can change content and the title. Viewers can read and export.

Link access still requires signing in, with any account. That keeps every edit attributable and lets the save-conflict check work per user. The link is the document URL, and since document IDs are random UUIDs it can't be guessed. Signed-out visitors are sent to sign in and then returned to the document. The return path is checked to be on the same site, which prevents open redirects. Documents opened through a link don't appear under "Shared with me"; only direct shares do.

**4. Optimistic concurrency instead of real-time collaboration.**
Each document has a `version`. A save sends the version it was based on, and the update only applies `WHERE version = $n`. A stale save gets a 409 and a clear "Load latest version" banner instead of silently overwriting someone else's work. Idle editors poll every 10 seconds to pick up other people's changes. This gives safe multi-user editing for a fraction of the cost of CRDTs or WebSockets. The trade-off is that true simultaneous typing ends in a conflict prompt, not a merge.

**5. Simple, stateless auth with defense in depth.**
Passwords are hashed with bcrypt. Sign-up enforces password rules (8+ characters, a letter, a number, a special character, no spaces), a matching confirmation and a strict email format, on both the client and the server. Sessions are a signed JWT in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` in production), so they survive Render restarts without a session store. Other protections:
- Every state-changing request must include a custom `X-Requested-With` header, which cross-site pages can't send. That's the CSRF defense.
- Login and registration are rate-limited, and both failure modes return the same message with the same timing.
- Helmet sets a CSP of `script-src 'self'`.
- All SQL is parameterized, and the UI renders user data with `textContent` only.
- Errors come back as clean JSON, with no stack traces.

## Stretch features

- **Collaboration indicators and live cursors (presence):** each open editor sends a heartbeat. It upserts `(document, user, editing, cursor_index, cursor_length, last_seen)` and gets back everyone else seen in the last 20 seconds, plus the document's current version.
  - **Avatars:** they show who is here, with name, email and viewing/editing on hover. "Is editing" means they typed in the last 10 seconds.
  - **Cursors:** each editor's caret and selection is drawn in an overlay on top of the editor, using `quill.getBounds()`, coloured per user with a name flag. Viewers never send a cursor or appear as editing; the server enforces this.
  - **Adaptive rate:** the heartbeat runs every second while someone else is present and every 4 seconds when you're alone. Moving your cursor sends an extra heartbeat, throttled to 250 ms.
  - **Content sync:** if the version changed and you have no unsaved work, the editor loads the new content. Cursor positions are clamped to the local document, so a cursor can be briefly off by a few characters until the latest save arrives.
  - **Leaving:** closing the page sends a `keepalive` request that removes you immediately.

  It's polling, not WebSockets, which keeps it simple and stateless on Render's free tier. The trade-off is about one second of delay. Two people typing at the very same moment still get the save-conflict prompt; character-level merging (Yjs) is the next step.
- **Version history:** every create, import, save and restore records a snapshot. Autosave fires about every second, so consecutive saves by the *same person within 5 minutes* update one entry instead of creating hundreds. History therefore reads like "Bob edited, 10:42 / Alice edited, 10:31". Up to 50 snapshots are kept per document. Restoring uses the same optimistic version check as saving (409 if stale) and is itself recorded as a new version, so a restore can always be undone. Viewers can browse history. Only editors and owners can restore.
- **PDF export** uses the browser's print engine with a print stylesheet that hides the app chrome. That gives selectable text and correct formatting with no server-side PDF library or headless browser, which would be heavy on a free instance.

## Data model

```
users(id, email UNIQUE, name, password_hash, created_at)
documents(id UUID, owner_id -> users, title, content JSONB (Delta), version, source,
          link_access NULL|'viewer'|'editor', created_at, updated_at)
document_shares(document_id -> documents, user_id -> users, role 'viewer'|'editor', PK(document_id, user_id))
document_versions(id, document_id -> documents, version, title, content JSONB, author_id -> users, kind, created_at, updated_at)
document_presence(document_id -> documents, user_id -> users, editing, cursor_index, cursor_length, last_seen, PK(document_id, user_id))
```

Deleting a document or a user cascades to its shares. The schema is created idempotently on boot, and demo data is seeded only once.

## Testing

`npm test` runs 40 tests with `node:test` and `supertest` against a fresh in-memory Postgres. They cover:

- **Auth:** sign-in required, generic errors, HttpOnly cookie, CSRF header, registration validation.
- **Documents:** create, rename, save and reopen with formatting intact; 409 on stale saves; malicious Delta rejected; title validation.
- **Sharing matrix:** owner, editor, viewer and stranger for every route; revoking access; the owned vs. shared listing; link access as viewer and editor, turning it off, and a direct viewer being upgraded by an editor link.
- **Import:** `.md`, `.docx` (generated in the test) and `.txt`; rejection of PDF, fake `.docx`, binary, empty and over 2 MB files.
- **Units:** the Delta validator, the HTML converter and Markdown export.
- **Stretch:** history grouping by author, restore and its conflict check, viewer and stranger permissions on history, cross-document version IDs, and presence (emails, cursor validation, and viewers never showing as editing or a cursor).

I also ran a scripted headless-browser pass (Playwright) through every UI flow, including a two-user conflict, against both PGlite and a real Postgres 16 server.

## Deliberately left out

- **Live character-by-character co-editing** (CRDT/Yjs over WebSockets) and live cursors. This is the largest piece of work. Presence, a 4-second sync and conflict detection cover correctness for now.
- Comments, suggestion mode, images, tables, links, fonts and colors.
- Email invitations and share links. Sharing requires an existing account. The share endpoint reveals whether an email has an account, which is acceptable for an internal tool and would be revisited for a public product.
- Password reset, email verification and SSO.

## Next 2–4 hours

1. Live co-editing with Yjs + y-quill over WebSockets, which would replace polling and conflict prompts with live merging and cursors.
2. Comments anchored to text selections.
3. An end-to-end browser test in CI (the Playwright flow above) and a GitHub Actions workflow running `npm test`.
4. Pagination and search on the dashboard.
