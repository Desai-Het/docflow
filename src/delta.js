'use strict';

/**
 * Documents are stored as Quill Deltas (JSON), not HTML.
 *
 * Why: a Delta is structured data. We validate it against a strict allow-list of
 * formats below, so nothing executable (scripts, links, images, inline styles)
 * can ever be persisted. Quill renders Delta text as text, which removes the
 * stored-XSS risk that comes with saving and re-rendering user HTML.
 */

const MAX_OPS = 20000;
const MAX_TEXT_CHARS = 200000;

const ALLOWED_ATTRS = {
  bold: (v) => v === true,
  italic: (v) => v === true,
  underline: (v) => v === true,
  header: (v) => v === 1 || v === 2 || v === 3,
  list: (v) => v === 'ordered' || v === 'bullet',
};

class DeltaValidationError extends Error {}

/** Returns a clean copy of the delta or throws DeltaValidationError. */
function validateDelta(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.ops)) {
    throw new DeltaValidationError('Content must be an object with an "ops" array.');
  }
  if (input.ops.length > MAX_OPS) {
    throw new DeltaValidationError('Document is too large.');
  }
  let chars = 0;
  const ops = input.ops.map((op, i) => {
    if (!op || typeof op !== 'object' || Array.isArray(op)) {
      throw new DeltaValidationError(`Invalid operation at index ${i}.`);
    }
    for (const key of Object.keys(op)) {
      if (key !== 'insert' && key !== 'attributes') {
        throw new DeltaValidationError(`Unsupported operation "${key}" at index ${i}.`);
      }
    }
    if (typeof op.insert !== 'string' || op.insert.length === 0) {
      throw new DeltaValidationError(`Only text content is supported (index ${i}).`);
    }
    chars += op.insert.length;
    if (chars > MAX_TEXT_CHARS) throw new DeltaValidationError('Document is too large.');

    const clean = { insert: op.insert };
    if (op.attributes !== undefined) {
      if (!op.attributes || typeof op.attributes !== 'object' || Array.isArray(op.attributes)) {
        throw new DeltaValidationError(`Invalid attributes at index ${i}.`);
      }
      const attrs = {};
      for (const [k, v] of Object.entries(op.attributes)) {
        if (!ALLOWED_ATTRS[k] || !ALLOWED_ATTRS[k](v)) {
          throw new DeltaValidationError(`Unsupported formatting "${k}" at index ${i}.`);
        }
        attrs[k] = v;
      }
      if (Object.keys(attrs).length) clean.attributes = attrs;
    }
    return clean;
  });

  // Quill requires a document to end with a newline.
  if (ops.length === 0 || !ops[ops.length - 1].insert.endsWith('\n')) {
    ops.push({ insert: '\n' });
  }
  return { ops };
}

function emptyDelta() {
  return { ops: [{ insert: '\n' }] };
}

/** Plain text -> Delta (one paragraph per line). */
function textToDelta(text) {
  const normalized = String(text).replace(/\r\n?/g, '\n');
  const body = normalized.endsWith('\n') ? normalized : normalized + '\n';
  return body.length > 1 ? { ops: [{ insert: body }] } : emptyDelta();
}

/**
 * Split a delta into lines: [{ segments: [{text, attrs}], attrs: blockAttrs }].
 * In Quill, block formats (header/list) live on the "\n" that ends the line.
 */
function deltaToLines(delta) {
  const lines = [];
  let segments = [];
  for (const op of delta.ops) {
    const parts = op.insert.split('\n');
    parts.forEach((part, idx) => {
      if (part) segments.push({ text: part, attrs: op.attributes || {} });
      if (idx < parts.length - 1) {
        lines.push({ segments, attrs: op.attributes || {} });
        segments = [];
      }
    });
  }
  if (segments.length) lines.push({ segments, attrs: {} });
  return lines;
}

function escapeMarkdown(text) {
  return text.replace(/([\\`*_[\]#<>|])/g, '\\$1');
}

/** Delta -> Markdown (used by the "Export .md" feature). */
function deltaToMarkdown(delta) {
  const out = [];
  let orderedIndex = 0;
  let prevType = null;
  for (const line of deltaToLines(delta)) {
    const inline = line.segments
      .map(({ text, attrs }) => {
        let t = escapeMarkdown(text);
        // Keep surrounding whitespace outside of the markers so Markdown parses them.
        const m = t.match(/^(\s*)(.*?)(\s*)$/s);
        let core = m[2];
        if (!core) return t;
        if (attrs.underline) core = `<u>${core}</u>`;
        if (attrs.italic) core = `*${core}*`;
        if (attrs.bold) core = `**${core}**`;
        return m[1] + core + m[3];
      })
      .join('');

    let type = 'p';
    let text;
    if (line.attrs.header) {
      type = 'h';
      text = `${'#'.repeat(line.attrs.header)} ${inline}`;
    } else if (line.attrs.list === 'bullet') {
      type = 'ul';
      text = `- ${inline}`;
    } else if (line.attrs.list === 'ordered') {
      type = 'ol';
      orderedIndex = prevType === 'ol' ? orderedIndex + 1 : 1;
      text = `${orderedIndex}. ${inline}`;
    } else {
      text = inline;
    }
    // Blank line between blocks, except between consecutive items of the same list.
    const sameList = (type === 'ul' || type === 'ol') && type === prevType;
    if (out.length && !sameList) out.push('');
    out.push(text);
    prevType = type;
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

module.exports = {
  validateDelta,
  emptyDelta,
  textToDelta,
  deltaToMarkdown,
  DeltaValidationError,
  MAX_TEXT_CHARS,
};
