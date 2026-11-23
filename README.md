# DocFlow: lightweight collaborative documents

DocFlow is a small full-stack document editor inspired by Google Docs, built for the Ajaia AI-Native Full Stack Developer assignment.

**Live app:** `https://docflow-3qfe.onrender.com`. The free tier sleeps when idle, so the first load can take about 50 seconds.

## Demo accounts

All three accounts use the password **`Password123!`**. On the sign-in page, clicking a demo account fills in the form; you then press **Sign in**.

| Account | Email | What it shows |
|---|---|---|
| Alice | `alice@demo.test` | Owns "Welcome to DocFlow". Has view-only access to Bob's "Sprint Notes" |
| Bob | `bob@demo.test` | **Can edit** Alice's welcome doc. Owns "Sprint Notes" |
| Carol | `carol@demo.test` | **View only** on Alice's welcome doc |

To test the no-access case, use any document that hasn't been shared (for example a new one Alice creates), or register a new account.

## What works end to end

- **Documents:** create, rename (click the title), edit in the browser, autosave, reopen, and delete (owner only).
- **Rich text:** bold, italic, underline, headings H1–H3, numbered and bulleted lists, and clear formatting. Shortcuts: Ctrl/Cmd+B, I and U, and Ctrl/Cmd+S to save immediately.
- **File import:** upload **`.txt`, `.md` or `.docx`** (max 2 MB). Each file becomes a new editable document, with headings, bold, italic, underline and lists preserved. Other file types are rejected, both in the UI and on the server.
- **Sharing:** the owner shares by email as **Can edit** or **View only**, can change a role, and can remove access. The dashboard separates **My documents** from **Shared with me**, and each document shows a role badge.
- **General access ("Anyone with the link"):** the owner can turn on link access as **View only** or **Can edit** and use **Copy link**. Anyone signed in to DocFlow with the link gets that role. If someone opens the link while signed out, they're asked to sign in (or create an account) and then taken straight to the document. Turning link access back to *Restricted* removes link-based access immediately.
- **Accounts:** sign-up checks the email format and requires the password to be confirmed. Password rules (8+ characters, a letter, a number, a special character, no spaces) are shown live and also enforced on the server. A profile icon shows your name and email.
- **Confirmations:** deleting a document and signing out both ask for confirmation in a popup.
- **Access control:** checked on the server for every request. Viewers get a read-only editor and the API returns 403 if they try to edit. Users without access get 404, so they can't even tell the document exists.
- **Persistence:** stored in Postgres, so documents, formatting and sharing survive refreshes and restarts.
- **Concurrent edits:** if two people save the same document, the second save is rejected (HTTP 409) and that user sees a "Load latest version" banner, so nothing gets silently overwritten.
- **Stretch features:**
  - **Role-based permissions:** viewer or editor, for direct shares and for link sharing.
  - **Real-time collaboration indicators:** avatars show who else has the document open, and "Bob is editing…" appears while someone types. Hovering an avatar shows the person's name, email, and whether they're viewing or editing.
  - **Live cursors:** each editor's cursor and text selection appears in their own colour with a name flag, for everyone viewing the document. Viewers don't show a cursor. While others are present, cursors and saved changes update about once a second.
  - **Version history:** the **History** button lists versions with author and time. You can preview any version and restore it (editors and owners). A restore is added as a new version, so nothing is lost.
  - **Export:** **Markdown** download or **PDF** (opens the print dialog; choose "Save as PDF").

## Run locally

Requirements: **Node.js 22+** (current LTS). You don't need a database. Locally the app uses an embedded Postgres ([PGlite](https://pglite.dev)) that stores data in `./data`.

```bash
cd docflow #(If not in this path, else skip to 'npm install').
npm install
npm start            # http://localhost:3000
```

Other commands:

```bash
npm test             # 40 automated API and unit tests (in-memory database)
npm run dev          # auto-restart on file changes
```

To run locally against real Postgres instead, copy `.env.example` to `.env` and set `DATABASE_URL`.

To reset local data, stop the server and delete the `data/` folder. Demo users and documents are seeded again on the next start.

## Deploy (free: Render + Neon)

1. Create a free Postgres database at [neon.tech](https://neon.tech) and copy its connection string.
2. Push this repo to GitHub. On [render.com](https://render.com), choose **New → Blueprint**, select the repo, and paste the Neon string into `DATABASE_URL`. `render.yaml` sets everything else, including a generated `JWT_SECRET`.
3. When the deploy finishes, open the URL. Tables and demo users are created automatically on first boot.

## Environment variables

| Name | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | In production | Postgres connection string. If it's empty, the embedded database is used. |
| `JWT_SECRET` | In production (32+ characters) | Signs session cookies. The server won't start in production without it. |
| `PORT` | No | Defaults to 3000. |
| `NODE_ENV` | No | `production` turns on secure cookies and proxy trust. |

## Project layout

```
src/
  server.js        entry point (config, DB, seed, listen)
  app.js           Express app: security headers, routes, error handler
  db.js            Postgres / PGlite driver, schema, demo seed
  auth.js          JWT cookie sessions, auth + CSRF middleware
  delta.js         document format validation, Markdown export
  history.js       version snapshots (grouping + pruning)
  importer.js      .txt / .md / .docx -> document conversion
  validate.js      input validation helpers
  routes/auth.js   login, register, logout, session
  routes/docs.js   documents, import, export, sharing
public/            static frontend (no build step): sign-in, dashboard, editor
test/              node:test + supertest suites
docs/screenshots/  screenshots of the main flows
```

More detail: [ARCHITECTURE.md](ARCHITECTURE.md) · [AI_WORKFLOW.md](AI_WORKFLOW.md) · [SUBMISSION.md](SUBMISSION.md)
