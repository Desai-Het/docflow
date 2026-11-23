'use strict';

/** How long consecutive saves by the same person are merged into one history entry. */
const GROUP_WINDOW_MINUTES = 5;
/** Older snapshots beyond this count are pruned per document. */
const MAX_VERSIONS_PER_DOC = 50;

/**
 * Records a snapshot after a successful save/create/restore.
 * Autosave fires every second while typing, so consecutive "edited" snapshots by the same
 * author within GROUP_WINDOW_MINUTES update the latest entry instead of adding a new one.
 * That keeps history meaningful ("Bob edited, 10:42") rather than one row per keystroke burst.
 */
async function recordVersion(db, { documentId, version, title, content, authorId, kind }) {
  const json = JSON.stringify(content);
  if (kind === 'edited') {
    const { rows } = await db.query(
      `UPDATE document_versions
          SET content = $1::jsonb, version = $2, title = $3, updated_at = now()
        WHERE id = (SELECT id FROM document_versions WHERE document_id = $4 ORDER BY id DESC LIMIT 1)
          AND author_id = $5 AND kind = 'edited'
          AND updated_at > now() - ($6 || ' minutes')::interval
        RETURNING id`,
      [json, version, title, documentId, authorId, String(GROUP_WINDOW_MINUTES)]
    );
    if (rows.length) return;
  }
  await db.query(
    `INSERT INTO document_versions (document_id, version, title, content, author_id, kind)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
    [documentId, version, title, json, authorId, kind]
  );
  await db.query(
    `DELETE FROM document_versions
      WHERE document_id = $1
        AND id NOT IN (SELECT id FROM document_versions WHERE document_id = $1 ORDER BY id DESC LIMIT $2)`,
    [documentId, MAX_VERSIONS_PER_DOC]
  );
}

module.exports = { recordVersion, GROUP_WINDOW_MINUTES, MAX_VERSIONS_PER_DOC };
