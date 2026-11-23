'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateDelta, deltaToMarkdown, textToDelta, DeltaValidationError } = require('../src/delta');
const { htmlToDelta } = require('../src/importer');

test('validateDelta strips nothing valid and appends trailing newline', () => {
  const out = validateDelta({ ops: [{ insert: 'Hi', attributes: { bold: true } }] });
  assert.deepEqual(out, { ops: [{ insert: 'Hi', attributes: { bold: true } }, { insert: '\n' }] });
});

test('validateDelta rejects unknown keys and formats', () => {
  assert.throws(() => validateDelta({ ops: [{ insert: 'x', retain: 1 }] }), DeltaValidationError);
  assert.throws(() => validateDelta({ ops: [{ insert: 'x', attributes: { color: 'red' } }] }), DeltaValidationError);
  assert.throws(() => validateDelta({ ops: [{ insert: 'x', attributes: { bold: 'yes' } }] }), DeltaValidationError);
  assert.throws(() => validateDelta(null), DeltaValidationError);
});

test('validateDelta enforces size limits', () => {
  assert.throws(() => validateDelta({ ops: [{ insert: 'a'.repeat(200001) }] }), /too large/);
});

test('htmlToDelta drops scripts, attributes and unknown tags', () => {
  const delta = htmlToDelta('<p onclick="x()">Hi <a href="javascript:1">there</a><script>bad()</script><img src=x onerror=alert(1)></p>');
  assert.deepEqual(delta, { ops: [{ insert: 'Hi ' }, { insert: 'there' }, { insert: '\n' }] });
});

test('htmlToDelta handles nested lists and h4+ headings', () => {
  const delta = htmlToDelta('<h5>Small</h5><ul><li>a<ul><li>b</li></ul></li></ul>');
  assert.deepEqual(delta.ops, [
    { insert: 'Small' },
    { insert: '\n', attributes: { header: 3 } },
    { insert: 'a' },
    { insert: '\n', attributes: { list: 'bullet' } },
    { insert: 'b' },
    { insert: '\n', attributes: { list: 'bullet' } },
  ]);
});

test('deltaToMarkdown escapes markdown characters and numbers lists', () => {
  const md = deltaToMarkdown({
    ops: [
      { insert: 'a*b' },
      { insert: '\n' },
      { insert: 'one' },
      { insert: '\n', attributes: { list: 'ordered' } },
      { insert: 'two' },
      { insert: '\n', attributes: { list: 'ordered' } },
      { insert: 'under', attributes: { underline: true } },
      { insert: '\n' },
    ],
  });
  assert.equal(md, 'a\\*b\n\n1. one\n2. two\n\n<u>under</u>\n');
});

test('textToDelta normalises line endings', () => {
  assert.deepEqual(textToDelta('a\r\nb'), { ops: [{ insert: 'a\nb\n' }] });
  assert.deepEqual(textToDelta(''), { ops: [{ insert: '\n' }] });
});
