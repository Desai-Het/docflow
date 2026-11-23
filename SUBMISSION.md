# Submission: DocFlow (Het Desai)

## Links

- **Live app:** `https://docflow-3qfe.onrender.com`. The free tier sleeps when idle, so the first load can take about 50 seconds.
- **Walkthrough video:** `https://drive.google.com/file/d/12mtSV5b7gQ1Sf-Dx4aL-_2LgBtZv6dVG/view?usp=sharing` (also in `VIDEO_URL.txt`)
- **Source repository (optional):** `https://github.com/Desai-Het/docflow`

## Test accounts (password for all: `Password123!`)

| Email | Role in the demo |
|---|---|
| `alice@demo.test` | Owner of "Welcome to DocFlow"; view-only on Bob's "Sprint Notes" |
| `bob@demo.test` | **Can edit** the welcome doc; owner of "Sprint Notes" |
| `carol@demo.test` | **View only** on the welcome doc |

**Quick stretch test:** open "Welcome to DocFlow" as Alice in one window and as Bob in another. Click into the text and type as Bob: Alice sees Bob's avatar (hover it for his email), "Bob is editing…", his coloured cursor, and his text within a couple of seconds. As Alice, click **History**, preview the earlier version and click **Restore**.

**Quick sharing tests**
1. **Direct share:** as Alice, create a document, click **Share**, and add `carol@demo.test` as **View only**. Sign in as Carol in a private window: the document is under *Shared with me* and opens read-only.
2. **Link share:** in the same dialog, set *General access* to **Anyone with the link → Can edit** and click **Copy link**. Open the link in a private window and sign in as anyone (or create an account). The document opens and is editable.
3. **No access:** set it back to *Restricted*. The link now shows "Document not found" for anyone who isn't the owner or directly shared.

## What's included in this folder

| Item | Path |
|---|---|
| Source code | `src/` (server), `public/` (frontend), `test/` (tests), `package.json`, `package-lock.json` |
| Setup and run instructions | `README.md` |
| Architecture note | `ARCHITECTURE.md` |
| AI workflow note | `AI_WORKFLOW.md` |
| This file | `SUBMISSION.md` |
| Walkthrough video URL | `VIDEO_URL.txt` |
| Screenshots | `docs/screenshots/` |
| Deployment config | `render.yaml`, `.env.example`, `.nvmrc` |

`node_modules/` and local data are not included. Run `npm install` and then `npm start`.

## Status

**Working end to end**
- Create, rename, edit, autosave, reopen and delete documents.
- Rich text: bold, italic, underline, H1–H3, numbered and bulleted lists.
- Import `.txt`, `.md` and `.docx` (≤ 2 MB) as new editable documents, with formatting preserved.
- Sharing with **editor or viewer** roles; change or remove access; *My documents* and *Shared with me* shown separately.
- **"Anyone with the link"** access (view or edit) with Copy link; signed-out visitors return to the document after signing in.
- Sign-up with email validation, password rules and password confirmation; a profile menu; confirmation popups for delete and sign out.
- Server-side access control on every route.
- Postgres persistence.
- Stale-save conflict detection.
- **Stretch:** real-time collaboration indicators (who's viewing or editing, with name and email on hover), live coloured cursors for each editor, version history with preview and restore, and export to Markdown and PDF.
- 40 automated tests.

**Intentionally not built** (reasons in `ARCHITECTURE.md`)
- Live character-by-character co-editing (CRDT). Presence and fast sync are built.
- Comments and suggestion mode.
- Images, tables and links.
- Email invitations.
- Password reset.

**Next 2–4 hours**
1. Live co-editing with Yjs over WebSockets (replacing polling and conflict prompts).
2. Comments on text selections.
3. A CI pipeline running unit and browser tests.
4. Dashboard search.
