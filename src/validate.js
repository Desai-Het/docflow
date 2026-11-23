'use strict';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// local@domain.tld: no spaces, no consecutive dots, domain labels of letters/digits/hyphens, TLD of 2+ letters.
const EMAIL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._%+-]*[A-Za-z0-9_%+-])?@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeEmail(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'Email is required.');
  const email = value.trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email) || email.includes('..')) {
    throw new HttpError(400, 'Please enter a valid email address.');
  }
  return email;
}

/** Password rules (same list is shown live on the sign-up form). Returns unmet rules. */
const PASSWORD_RULES = [
  { test: (v) => v.length >= 8 && v.length <= 128, message: 'be 8 to 128 characters long' },
  { test: (v) => /[A-Za-z]/.test(v), message: 'contain at least one letter' },
  { test: (v) => /[0-9]/.test(v), message: 'contain at least one number' },
  { test: (v) => /[^A-Za-z0-9\s]/.test(v), message: 'contain at least one special character (e.g. ! @ # $)' },
  { test: (v) => !/\s/.test(v), message: 'not contain spaces' },
];

function validatePassword(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'Password is required.');
  const failed = PASSWORD_RULES.filter((r) => !r.test(value)).map((r) => r.message);
  if (failed.length) throw new HttpError(400, `Password must ${failed.join(', ')}.`);
  return value;
}

function validateName(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'Name is required.');
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name || name.length > 80) throw new HttpError(400, 'Name must be between 1 and 80 characters.');
  return name;
}

function validateTitle(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'Title must be text.');
  const title = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!title) throw new HttpError(400, 'Title cannot be empty.');
  if (title.length > 120) throw new HttpError(400, 'Title must be 120 characters or fewer.');
  return title;
}

function validateDocId(value) {
  // Unknown or malformed IDs look exactly like missing documents (no existence leak).
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new HttpError(404, 'Document not found.');
  return value.toLowerCase();
}

function validateLinkAccess(value) {
  if (value === null || value === 'viewer' || value === 'editor') return value;
  throw new HttpError(400, 'Link access must be null, "viewer" or "editor".');
}

function validateRole(value) {
  if (value !== 'viewer' && value !== 'editor') throw new HttpError(400, 'Role must be "viewer" or "editor".');
  return value;
}

function validateVersion(value) {
  if (!Number.isInteger(value) || value < 1) throw new HttpError(400, 'A valid document version is required.');
  return value;
}

module.exports = {
  HttpError,
  normalizeEmail,
  validatePassword,
  validateName,
  validateTitle,
  validateDocId,
  validateRole,
  validateLinkAccess,
  validateVersion,
  PASSWORD_RULES,
};
