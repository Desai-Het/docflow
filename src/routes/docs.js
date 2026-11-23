'use strict';

const express = require('express');
const multer = require('multer');
const { requireAuth } = require('../auth');
const { validateDelta, emptyDelta, deltaToMarkdown, DeltaValidationError } = require('../delta');
const { importFile, MAX_UPLOAD_BYTES } = require('../importer');
const { recordVersion } = require('../history');
const {
  HttpError,
  normalizeEmail,
  validateTitle,
  validateDocId,
  validateRole,
  validateLinkAccess,
  validateVersion,
} = require('../validate');

const upload = multer({
  storage: multer.memoryStorage(), // files are converted then discarded; never written to disk
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 },
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = function docRoutes(db, config) {
  const router = express.Router();
  router.use(requireAuth(db, config));

  /** Loads a document together with the caller's role. 404 if it doesn't exist OR they have no access. */
  async function loadWithAccess(docId, userId) {
    const { rows } = await db.query(
      `SELECT d.id, d.title, d.content, d.version, d.owner_id, d.source, d.link_access, d.created_at, d.updated_at,
              u.name AS owner_name, u.email AS owner_email,
              -- Effective role = the strongest of: ownership, a direct share, or general link access.
              CASE
                WHEN d.owner_id = $2 THEN 'owner'
                WHEN s.role = 'editor' OR d.link_access = 'editor' THEN 'editor'
                WHEN s.role = 'viewer' OR d.link_access = 'viewer' THEN 'viewer'
              END AS role,
              CASE
                WHEN d.owner_id = $2 THEN 'owner'
                WHEN s.role = 'editor' OR (s.role IS NOT NULL AND d.link_access IS DISTINCT FROM 'editor') THEN 'direct'
                ELSE 'link'
              END AS access_via
         FROM documents d
         JOIN users u ON u.id = d.owner_id
         LEFT JOIN document_shares s ON s.document_id = d.id AND s.user_id = $2
        WHERE d.id = $1`,
      [docId, userId]
    );
    const doc = rows[0];
    if (!doc || !doc.role) throw new HttpError(404, 'Document not found.');
    return doc;
  }

  function assertCanEdit(doc) {
    if (doc.role !== 'owner' && doc.role !== 'editor') {
      throw new HttpError(403, 'You have view-only access to this document.');
    }
  }
  function assertOwner(doc) {
    if (doc.role !== 'owner') throw new HttpError(403, 'Only the document owner can do that.');
  }

  async function listShares(docId) {
    const { rows } = await db.query(
      `SELECT u.id AS user_id, u.name, u.email, s.role, s.created_at
         FROM document_shares s JOIN users u ON u.id = s.user_id
        WHERE s.document_id = $1 ORDER BY s.created_at`,
      [docId]
    );
    return rows;
  }

  async function createDocument(ownerId, title, content, source) {
    const { rows } = await db.query(
      `INSERT INTO documents (owner_id, title, content, source)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING id, title, version, source, created_at, updated_at`,
      [ownerId, title, JSON.stringify(content), source]
    );
    const doc = rows[0];
    await recordVersion(db, {
      documentId: doc.id, version: doc.version, title, content, authorId: ownerId,
      kind: source === 'blank' ? 'created' : 'imported',
    });
    return doc;
  }

  // ---- List: owned vs. shared ------------------------------------------------
  router.get('/', wrap(async (req, res) => {
    const owned = await db.query(
      `SELECT d.id, d.title, d.source, d.link_access, d.created_at, d.updated_at,
              (SELECT COUNT(*) FROM document_shares s WHERE s.document_id = d.id)::int AS share_count
         FROM documents d WHERE d.owner_id = $1 ORDER BY d.updated_at DESC`,
      [req.user.id]
    );
    const shared = await db.query(
      `SELECT d.id, d.title, d.source, d.created_at, d.updated_at, s.role,
              u.name AS owner_name, u.email AS owner_email
         FROM document_shares s
         JOIN documents d ON d.id = s.document_id
         JOIN users u ON u.id = d.owner_id
        WHERE s.user_id = $1 ORDER BY d.updated_at DESC`,
      [req.user.id]
    );
    res.json({ owned: owned.rows, shared: shared.rows });
  }));

  // ---- Create blank ----------------------------------------------------------
  router.post('/', wrap(async (req, res) => {
    const raw = req.body && req.body.title;
    const title = raw === undefined || raw === '' ? 'Untitled document' : validateTitle(raw);
    const doc = await createDocument(req.user.id, title, emptyDelta(), 'blank');
    res.status(201).json({ document: doc });
  }));

  // ---- Import a file as a new document --------------------------------------
  router.post('/import', (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, 'File is too large. The limit is 2 MB.'));
        return next(new HttpError(400, 'Please upload exactly one file using the "file" field.'));
      }
      next(err);
    });
  }, wrap(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Please choose a file to upload.');
    const { title, content, source } = await importFile(req.file);
    const doc = await createDocument(req.user.id, title, content, source);
    res.status(201).json({ document: doc });
  }));

  // ---- Read one --------------------------------------------------------------
  router.get('/:id', wrap(async (req, res) => {
    const doc = await loadWithAccess(validateDocId(req.params.id), req.user.id);
    res.json({
      document: {
        id: doc.id,
        title: doc.title,
        content: doc.content,
        version: doc.version,
        source: doc.source,
        role: doc.role,
        access_via: doc.access_via,
        // Only the owner needs to see/manage the general-access setting.
        link_access: doc.role === 'owner' ? doc.link_access : undefined,
        owner: { id: doc.owner_id, name: doc.owner_name, email: doc.owner_email },
        created_at: doc.created_at,
        updated_at: doc.updated_at,
      },
    });
  }));

  // ---- Update title and/or content ------------------------------------------
  router.patch('/:id', wrap(async (req, res) => {
    const id = validateDocId(req.params.id);
    const body = req.body || {};
    const hasTitle = body.title !== undefined;
    const hasContent = body.content !== undefined;
    if (!hasTitle && !hasContent) throw new HttpError(400, 'Nothing to update.');

    const doc = await loadWithAccess(id, req.user.id);
    assertCanEdit(doc);

    const title = hasTitle ? validateTitle(body.title) : undefined;
    let content;
    let version;
    if (hasContent) {
      version = validateVersion(body.version);
      try {
        content = validateDelta(body.content);
      } catch (err) {
        if (err instanceof DeltaValidationError) throw new HttpError(400, err.message);
        throw err;
      }
    }

    let result = { id, title: doc.title, version: doc.version, updated_at: doc.updated_at };

    if (hasContent) {
      // Optimistic concurrency: only save if nobody else saved since this client loaded.
      const { rows } = await db.query(
        `UPDATE documents SET content = $1::jsonb, version = version + 1, updated_at = now()
          WHERE id = $2 AND version = $3
          RETURNING id, title, version, updated_at`,
        [JSON.stringify(content), id, version]
      );
      if (!rows.length) {
        const current = await loadWithAccess(id, req.user.id);
        return res.status(409).json({
          error: 'This document was changed by someone else since you opened it.',
          currentVersion: current.version,
        });
      }
      result = rows[0];
      await recordVersion(db, {
        documentId: id, version: result.version, title: result.title, content, authorId: req.user.id, kind: 'edited',
      });
    }
    if (hasTitle) {
      const { rows } = await db.query(
        `UPDATE documents SET title = $1, updated_at = now() WHERE id = $2
         RETURNING id, title, version, updated_at`,
        [title, id]
      );
      result = rows[0];
    }
    res.json({ document: result });
  }));

  // ---- Delete ----------------------------------------------------------------
  router.delete('/:id', wrap(async (req, res) => {
    const doc = await loadWithAccess(validateDocId(req.params.id), req.user.id);
    assertOwner(doc);
    await db.query('DELETE FROM documents WHERE id = $1', [doc.id]);
    res.json({ ok: true });
  }));

  // ---- Export as Markdown ----------------------------------------------------
  router.get('/:id/export.md', wrap(async (req, res) => {
    const doc = await loadWithAccess(validateDocId(req.params.id), req.user.id);
    const filename = (doc.title.replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-') || 'document').slice(0, 80);
    res.set('Content-Type', 'text/markdown; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}.md"`);
    res.send(deltaToMarkdown(doc.content));
  }));

  // ---- Version history (stretch) ---------------------------------------------
  router.get('/:id/versions', wrap(async (req, res) => {
    const doc = await loadWithAccess(validateDocId(req.params.id), req.user.id);
    const { rows } = await db.query(
      `SELECT v.id, v.version, v.title, v.kind, v.created_at, v.updated_at, u.name AS author_name
         FROM document_versions v LEFT JOIN users u ON u.id = v.author_id
        WHERE v.document_id = $1 ORDER BY v.id DESC`,
      [doc.id]
    );
    res.json({ versions: rows, current_version: doc.version });
  }));

  async function loadVersion(docId, rawVersionId) {
    const versionId = Number(rawVersionId);
    if (!Number.isInteger(versionId) || versionId < 1) throw new HttpError(404, 'Version not found.');
    const { rows } = await db.query(
      `SELECT v.id, v.version, v.title, v.kind, v.content, v.created_at, v.updated_at, u.name AS author_name
         FROM document_versions v LEFT JOIN users u ON u.id = v.author_id
        WHERE v.id = $1 AND v.document_id = $2`,
      [versionId, docId]
    );
    if (!rows.length) throw new HttpError(404, 'Version not found.');
    return rows[0];
  }

  router.get('/:id/versions/:versionId', wrap(async (req, res) => {
    const doc = await loadWithAccess(validateDocId(req.params.id), req.user.id);
    res.json({ version: await loadVersion(doc.id, req.params.versionId) });
  }));

  router.post('/:id/versions/:versionId/restore', wrap(async (req, res) => {
    const doc = await loadWithAccess(validateDocId(req.params.id), req.user.id);
    assertCanEdit(doc);
    const expected = validateVersion(req.body && req.body.version);
    const snapshot = await loadVersion(doc.id, req.params.versionId);
    const { rows } = await db.query(
      `UPDATE documents SET content = $1::jsonb, version = version + 1, updated_at = now()
        WHERE id = $2 AND version = $3
        RETURNING id, title, content, version, updated_at`,
      [JSON.stringify(snapshot.content), doc.id, expected]
    );
    if (!rows.length) {
      return res.status(409).json({ error: 'This document was changed since you opened the history. Please try again.' });
    }
    const restored = rows[0];
    await recordVersion(db, {
      documentId: doc.id, version: restored.version, title: restored.title, content: snapshot.content,
      authorId: req.user.id, kind: 'restored',
    });
    res.json({ document: restored });
  }));

  // ---- Presence: who else has this document open (stretch) -------------------
  const MAX_CURSOR = 1000000;
  /** Accepts { index, length } with small non-negative integers, otherwise null (no cursor). */
  function parseCursor(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const { index, length } = raw;
    const ok = (n) => Number.isInteger(n) && n >= 0 && n <= MAX_CURSOR;
    return ok(index) && ok(length) ? { index, length } : null;
  }

  router.post('/:id/presence', wrap(async (req, res) => {
    const doc = await loadWithAccess(validateDocId(req.params.id), req.user.id);
    const canEdit = doc.role !== 'viewer';
    const editing = Boolean(req.body && req.body.editing) && canEdit;
    // Only people who can edit show a cursor to others.
    const cursor = canEdit ? parseCursor(req.body && req.body.cursor) : null;
    await db.query(
      `INSERT INTO document_presence (document_id, user_id, editing, cursor_index, cursor_length, last_seen)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (document_id, user_id) DO UPDATE
         SET editing = EXCLUDED.editing, cursor_index = EXCLUDED.cursor_index,
             cursor_length = EXCLUDED.cursor_length, last_seen = now()`,
      [doc.id, req.user.id, editing, cursor ? cursor.index : null, cursor ? cursor.length : null]
    );
    await db.query(
      `DELETE FROM document_presence WHERE document_id = $1 AND last_seen < now() - interval '1 hour'`,
      [doc.id]
    );
    const { rows } = await db.query(
      `SELECT u.id AS user_id, u.name, u.email, p.editing, p.cursor_index, p.cursor_length
         FROM document_presence p JOIN users u ON u.id = p.user_id
        WHERE p.document_id = $1 AND p.user_id <> $2 AND p.last_seen > now() - interval '20 seconds'
        ORDER BY u.name`,
      [doc.id, req.user.id]
    );
    const active = rows.map((r) => ({
      user_id: r.user_id,
      name: r.name,
      email: r.email,
      editing: r.editing,
      cursor: r.cursor_index === null ? null : { index: r.cursor_index, length: r.cursor_length },
    }));
    res.json({ active, version: doc.version, title: doc.title, role: doc.role });
  }));

  router.delete('/:id/presence', wrap(async (req, res) => {
    const id = validateDocId(req.params.id);
    await db.query('DELETE FROM document_presence WHERE document_id = $1 AND user_id = $2', [id, req.user.id]);
    res.json({ ok: true });
  }));

  // ---- Sharing (owner only) --------------------------------------------------
  router.get('/:id/shares', wrap(async (req, res) => {
    const doc = await loadWithAccess(validateDocId(req.params.id), req.user.id);
    assertOwner(doc);
    res.json({ shares: await listShares(doc.id), link_access: doc.link_access });
  }));

  // General access: "Restricted" (null) or "Anyone with the link" as viewer/editor.
  router.put('/:id/link-access', wrap(async (req, res) => {
    const doc = await loadWithAccess(validateDocId(req.params.id), req.user.id);
    assertOwner(doc);
    const access = validateLinkAccess(req.body ? req.body.access : undefined);
    const { rows } = await db.query(
      'UPDATE documents SET link_access = $1 WHERE id = $2 RETURNING link_access',
      [access, doc.id]
    );
    res.json({ link_access: rows[0].link_access });
  }));

  router.put('/:id/shares', wrap(async (req, res) => {
    const doc = await loadWithAccess(validateDocId(req.params.id), req.user.id);
    assertOwner(doc);
    const email = normalizeEmail(req.body && req.body.email);
    const role = validateRole(req.body && req.body.role);

    const { rows } = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (!rows.length) throw new HttpError(404, 'No user found with that email. They need an account first.');
    const targetId = rows[0].id;
    if (targetId === doc.owner_id) throw new HttpError(400, 'You already own this document.');

    await db.query(
      `INSERT INTO document_shares (document_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (document_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [doc.id, targetId, role]
    );
    res.json({ shares: await listShares(doc.id) });
  }));

  router.delete('/:id/shares/:userId', wrap(async (req, res) => {
    const doc = await loadWithAccess(validateDocId(req.params.id), req.user.id);
    assertOwner(doc);
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId < 1) throw new HttpError(400, 'Invalid user.');
    await db.query('DELETE FROM document_shares WHERE document_id = $1 AND user_id = $2', [doc.id, userId]);
    res.json({ shares: await listShares(doc.id) });
  }));

  return router;
};
