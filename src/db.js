'use strict';

const bcrypt = require('bcryptjs');

/**
 * Database layer.
 *
 * - If DATABASE_URL is set we connect to a real Postgres (e.g. Neon in production).
 * - Otherwise we run an embedded Postgres (PGlite, Postgres compiled to WASM) so the
 *   app runs locally with zero setup. Pass dataDir = undefined for a pure in-memory DB (tests).
 *
 * Both drivers expose the same `query(text, params) -> { rows }` shape, so the rest of
 * the app is driver-agnostic and uses the same SQL dialect everywhere.
 */
async function createDb({ databaseUrl, dataDir } = {}) {
  let db;
  if (databaseUrl) {
    const { Pool } = require('pg');
    const pool = new Pool({ ...pgConfigFromUrl(databaseUrl), max: 5 });
    pool.on('error', (err) => console.error('Postgres pool error:', err.message));
    db = {
      kind: 'postgres',
      query: (text, params) => pool.query(text, params),
      exec: (text) => pool.query(text),
      close: () => pool.end(),
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = dataDir ? new PGlite(dataDir) : new PGlite();
    await pg.waitReady;
    db = {
      kind: dataDir ? 'pglite-file' : 'pglite-memory',
      query: (text, params) => pg.query(text, params),
      exec: (text) => pg.exec(text),
      close: () => pg.close(),
    };
  }
  await migrate(db);
  return db;
}

/**
 * Hosted Postgres URLs (Neon, Supabase, ...) carry libpq params such as sslmode and
 * channel_binding. We translate them into explicit node-postgres options: TLS with full
 * certificate verification for any non-local host, unless sslmode=disable is requested.
 */
function pgConfigFromUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  const sslmode = url.searchParams.get('sslmode');
  const channelBinding = url.searchParams.get('channel_binding');
  url.searchParams.delete('sslmode');
  url.searchParams.delete('channel_binding');
  const isLocal = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  const ssl = sslmode === 'disable' || (isLocal && !sslmode) ? false : { rejectUnauthorized: true };
  return { connectionString: url.toString(), ssl, enableChannelBinding: channelBinding === 'require' };
}

async function migrate(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS documents (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title      TEXT NOT NULL,
      content    JSONB NOT NULL,
      version    INTEGER NOT NULL DEFAULT 1,
      source     TEXT NOT NULL DEFAULT 'blank',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS documents_owner_idx ON documents(owner_id);

    CREATE TABLE IF NOT EXISTS document_shares (
      document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role        TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (document_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS document_shares_user_idx ON document_shares(user_id);

    -- General access: NULL = restricted, otherwise anyone signed in with the link gets this role.
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS link_access TEXT
      CHECK (link_access IN ('viewer', 'editor'));

    -- Version history: snapshots of document content (consecutive edits by one person are grouped).
    CREATE TABLE IF NOT EXISTS document_versions (
      id          SERIAL PRIMARY KEY,
      document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      version     INTEGER NOT NULL,
      title       TEXT NOT NULL,
      content     JSONB NOT NULL,
      author_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      kind        TEXT NOT NULL CHECK (kind IN ('created', 'imported', 'edited', 'restored')),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS document_versions_doc_idx ON document_versions(document_id, id DESC);

    -- Presence: who has a document open right now (heartbeat-based).
    CREATE TABLE IF NOT EXISTS document_presence (
      document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      editing     BOOLEAN NOT NULL DEFAULT false,
      last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (document_id, user_id)
    );
    -- Remote cursors: where each editor's caret/selection is (null when not focused).
    ALTER TABLE document_presence ADD COLUMN IF NOT EXISTS cursor_index INTEGER;
    ALTER TABLE document_presence ADD COLUMN IF NOT EXISTS cursor_length INTEGER;
  `);
}

const DEMO_PASSWORD = 'Password123!';
const DEMO_USERS = [
  { email: 'alice@demo.test', name: 'Alice Owner' },
  { email: 'bob@demo.test', name: 'Bob Collaborator' },
  { email: 'carol@demo.test', name: 'Carol Outsider' },
];

const p = (text, attrs) => (attrs ? { insert: text, attributes: attrs } : { insert: text });
const line = (attrs) => p('\n', attrs);

const WELCOME_DOC = {
  ops: [
    p('Welcome to DocFlow'), line({ header: 1 }),
    p('This document is owned by '), p('Alice', { bold: true }),
    p(' and shows each access level in DocFlow.\n'),
    p('Who can do what'), line({ header: 2 }),
    p('Alice', { bold: true }), p(' is the owner: she can edit, rename, share, change access and delete.'), line({ list: 'bullet' }),
    p('Bob', { bold: true }), p(' can edit: he can change the content and the title.'), line({ list: 'bullet' }),
    p('Carol', { bold: true }), p(' is view only: she can read and export, but not edit.'), line({ list: 'bullet' }),
    p('Try it out'), line({ header: 2 }),
    p('Format text with '), p('bold', { bold: true }), p(', '), p('italic', { italic: true }), p(' and '), p('underline', { underline: true }), line({ list: 'ordered' }),
    p('Click Share to invite someone by email, or turn on "Anyone with the link"'), line({ list: 'ordered' }),
    p('Open this document as Bob and Alice at the same time to see edits sync'), line({ list: 'ordered' }),
  ],
};

const BOB_DOC = {
  ops: [
    p('Sprint Notes'), line({ header: 1 }),
    p('Owned by '), p('Bob', { bold: true }), p(' and shared with Alice as '), p('view only', { italic: true }), p('.\n'),
    p('Finish the sharing dialog'), line({ list: 'bullet' }),
    p('Test the import flow with a .docx file'), line({ list: 'bullet' }),
  ],
};

/**
 * Idempotent: creates the demo users, then (only on a fresh database) two demo documents:
 *  - "Welcome to DocFlow": owner Alice, Bob = editor, Carol = viewer
 *  - "Sprint Notes": owner Bob, Alice = viewer
 */
async function seed(db) {
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  for (const u of DEMO_USERS) {
    await db.query(
      'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING',
      [u.email, u.name, hash]
    );
  }
  const { rows: users } = await db.query(
    'SELECT id, email FROM users WHERE email = ANY($1)',
    [DEMO_USERS.map((u) => u.email)]
  );
  const id = Object.fromEntries(users.map((u) => [u.email.split('@')[0], u.id]));
  const { rows: existing } = await db.query(`SELECT 1 FROM documents WHERE source = 'seed' LIMIT 1`);
  if (existing.length) return;

  const createDoc = async (ownerId, title, content, shares) => {
    const { rows } = await db.query(
      `INSERT INTO documents (owner_id, title, content, source) VALUES ($1, $2, $3::jsonb, 'seed') RETURNING id`,
      [ownerId, title, JSON.stringify(content)]
    );
    await db.query(
      `INSERT INTO document_versions (document_id, version, title, content, author_id, kind)
       VALUES ($1, 1, $2, $3::jsonb, $4, 'created')`,
      [rows[0].id, title, JSON.stringify(content), ownerId]
    );
    for (const [userId, role] of shares) {
      await db.query(
        `INSERT INTO document_shares (document_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [rows[0].id, userId, role]
      );
    }
  };
  await createDoc(id.alice, 'Welcome to DocFlow', WELCOME_DOC, [[id.bob, 'editor'], [id.carol, 'viewer']]);
  await createDoc(id.bob, 'Sprint Notes', BOB_DOC, [[id.alice, 'viewer']]);
}

module.exports = { createDb, seed, pgConfigFromUrl, DEMO_USERS, DEMO_PASSWORD };
