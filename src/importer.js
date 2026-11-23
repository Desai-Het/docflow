'use strict';

const path = require('path');
const { Parser } = require('htmlparser2');
const { marked } = require('marked');
const mammoth = require('mammoth');
const { textToDelta, validateDelta, emptyDelta } = require('./delta');

const SUPPORTED_EXTENSIONS = ['.txt', '.md', '.markdown', '.docx'];
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MB

class ImportError extends Error {}

/**
 * Converts a restricted subset of HTML into a Quill Delta.
 * Only headings, paragraphs, bold/italic/underline and lists survive; every other tag,
 * attribute, script or style is dropped. This is an allow-list converter, not a sanitizer
 * that tries to remove bad things, so unknown input can only lose formatting.
 */
function htmlToDelta(html) {
  const ops = [];
  const inline = { bold: 0, italic: 0, underline: 0 };
  const listStack = [];
  const blockStack = [];
  let skipDepth = 0;
  let lineOpen = false;

  const currentBlockAttrs = () => {
    const top = blockStack[blockStack.length - 1];
    return top ? top.attrs : {};
  };
  const endLine = (attrs) => {
    ops.push(Object.keys(attrs).length ? { insert: '\n', attributes: { ...attrs } } : { insert: '\n' });
    lineOpen = false;
  };
  const pushText = (text) => {
    const attrs = {};
    if (inline.bold) attrs.bold = true;
    if (inline.italic) attrs.italic = true;
    if (inline.underline) attrs.underline = true;
    ops.push(Object.keys(attrs).length ? { insert: text, attributes: attrs } : { insert: text });
    lineOpen = true;
    const top = blockStack[blockStack.length - 1];
    if (top) top.hadText = true;
  };

  const BLOCKS = new Set(['p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre']);
  const SKIP = new Set(['script', 'style', 'head', 'title', 'noscript', 'template', 'iframe', 'object', 'svg']);

  const parser = new Parser(
    {
      onopentag(name) {
        if (SKIP.has(name)) { skipDepth++; return; }
        if (skipDepth) return;
        if (name === 'strong' || name === 'b') inline.bold++;
        else if (name === 'em' || name === 'i') inline.italic++;
        else if (name === 'u' || name === 'ins') inline.underline++;
        else if (name === 'ul' || name === 'ol') {
          if (lineOpen) endLine(currentBlockAttrs());
          listStack.push(name === 'ol' ? 'ordered' : 'bullet');
        } else if (name === 'br') {
          endLine(currentBlockAttrs());
        } else if (BLOCKS.has(name)) {
          if (lineOpen) endLine(currentBlockAttrs());
          const attrs = {};
          const h = /^h([1-6])$/.exec(name);
          if (h) attrs.header = Math.min(Number(h[1]), 3);
          if (name === 'li' && listStack.length) attrs.list = listStack[listStack.length - 1];
          blockStack.push({ name, attrs, hadText: false });
        }
      },
      ontext(raw) {
        if (skipDepth) return;
        // Collapse HTML whitespace the way a browser would (\s also matches &nbsp;).
        let text = raw.replace(/\s+/g, ' ');
        if (!lineOpen) text = text.replace(/^ +/, '');
        if (!text) return;
        // Whitespace between blocks (e.g. "\n" between </p> and <p>) is not content.
        if (!blockStack.length && !text.trim()) return;
        pushText(text);
      },
      onclosetag(name) {
        if (SKIP.has(name)) { skipDepth = Math.max(0, skipDepth - 1); return; }
        if (skipDepth) return;
        if (name === 'strong' || name === 'b') inline.bold = Math.max(0, inline.bold - 1);
        else if (name === 'em' || name === 'i') inline.italic = Math.max(0, inline.italic - 1);
        else if (name === 'u' || name === 'ins') inline.underline = Math.max(0, inline.underline - 1);
        else if (name === 'ul' || name === 'ol') listStack.pop();
        else if (BLOCKS.has(name)) {
          const block = blockStack[blockStack.length - 1];
          if (!block || block.name !== name) return; // malformed HTML: ignore stray close tag
          if (lineOpen) endLine(block.attrs);
          else if (!block.hadText && block.name === 'p') endLine({});
          blockStack.pop();
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true }
  );
  parser.write(String(html));
  parser.end();
  if (lineOpen) endLine({});

  // Trim trailing spaces at the end of each line and drop empty inserts.
  const cleaned = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.insert !== '\n' && ops[i + 1] && ops[i + 1].insert === '\n') {
      op.insert = op.insert.replace(/ +$/, '');
    }
    if (op.insert) cleaned.push(op);
  }
  return cleaned.length ? validateDelta({ ops: cleaned }) : emptyDelta();
}

function looksBinary(buffer) {
  return buffer.subarray(0, Math.min(buffer.length, 8000)).includes(0);
}

/** Turns an uploaded file into { title, content (Delta), source }. */
async function importFile({ originalname, buffer }) {
  const ext = path.extname(originalname || '').toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new ImportError('Unsupported file type. Please upload a .txt, .md or .docx file.');
  }
  if (!buffer || buffer.length === 0) throw new ImportError('The uploaded file is empty.');

  const title = titleFromFilename(originalname);
  let content;

  if (ext === '.docx') {
    // .docx is a zip archive: it must start with the "PK" signature.
    if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
      throw new ImportError('This file is not a valid .docx document.');
    }
    let html;
    try {
      ({ value: html } = await mammoth.convertToHtml({ buffer }, { ignoreEmptyParagraphs: false, styleMap: ['u => u'] }));
    } catch {
      throw new ImportError('Could not read this .docx file. It may be corrupted or password-protected.');
    }
    content = htmlToDelta(html);
  } else {
    if (looksBinary(buffer)) throw new ImportError('This file does not look like a text file.');
    const text = buffer.toString('utf8').replace(/^﻿/, '');
    if (ext === '.txt') {
      content = textToDelta(text);
    } else {
      // Markdown: render with raw HTML disabled, then run through the allow-list converter.
      const html = marked.parse(text, {
        async: false,
        gfm: true,
        breaks: false,
        renderer: Object.assign(new marked.Renderer(), { html: () => '' }),
      });
      content = htmlToDelta(html);
    }
  }
  return { title, content, source: ext.slice(1) };
}

function titleFromFilename(name) {
  const base = path.basename(String(name || 'Untitled'), path.extname(String(name || '')));
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[_]+/g, ' ').trim();
  return (cleaned || 'Imported document').slice(0, 120);
}

module.exports = { importFile, htmlToDelta, ImportError, SUPPORTED_EXTENSIONS, MAX_UPLOAD_BYTES };
