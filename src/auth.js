'use strict';

const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'docflow_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function issueSession(res, user, config) {
  const token = jwt.sign({ sub: String(user.id) }, config.jwtSecret, {
    expiresIn: SESSION_TTL_SECONDS,
    algorithm: 'HS256',
  });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true, // not readable from JS -> XSS cannot steal the session
    sameSite: 'lax',
    secure: config.secureCookies,
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: '/',
  });
}

function clearSession(res, config) {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/' });
}

/** Returns the signed-in user for this request, or null (missing/invalid/expired cookie). */
async function getSessionUser(db, config, req) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return null;
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
  const id = Number(payload.sub);
  if (!Number.isInteger(id)) return null;
  const { rows } = await db.query('SELECT id, email, name FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

/** Loads req.user from the session cookie. Rejects with 401 when missing/invalid. */
function requireAuth(db, config) {
  return async (req, res, next) => {
    try {
      const user = await getSessionUser(db, config, req);
      if (!user) {
        if (req.cookies && req.cookies[COOKIE_NAME]) clearSession(res, config);
        return res.status(401).json({ error: 'Please sign in.' });
      }
      req.user = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * CSRF defence: the session cookie is SameSite=Lax, and every state-changing API call
 * must also carry a custom header. Browsers will not send custom headers cross-origin
 * without a CORS preflight, which this server never approves.
 */
function requireCsrfHeader(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'DocFlow') {
    return res.status(403).json({ error: 'Missing request header.' });
  }
  next();
}

module.exports = { issueSession, clearSession, requireAuth, getSessionUser, requireCsrfHeader, COOKIE_NAME };
