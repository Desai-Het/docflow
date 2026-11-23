'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { issueSession, clearSession, requireAuth, getSessionUser } = require('../auth');
const { HttpError, normalizeEmail, validatePassword, validateName } = require('../validate');

// Pre-computed hash so that "unknown email" and "wrong password" take the same time.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

module.exports = function authRoutes(db, config) {
  const router = express.Router();

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.authRateLimit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
  });

  router.post('/login', authLimiter, async (req, res, next) => {
    try {
      const email = normalizeEmail(req.body && req.body.email);
      const password = req.body && req.body.password;
      if (typeof password !== 'string' || !password) throw new HttpError(400, 'Password is required.');

      const { rows } = await db.query('SELECT id, email, name, password_hash FROM users WHERE email = $1', [email]);
      const user = rows[0];
      const ok = await bcrypt.compare(password.slice(0, 128), user ? user.password_hash : DUMMY_HASH);
      if (!user || !ok) throw new HttpError(401, 'Incorrect email or password.');

      issueSession(res, user, config);
      res.json({ user: { id: user.id, email: user.email, name: user.name } });
    } catch (err) {
      next(err);
    }
  });

  router.post('/register', authLimiter, async (req, res, next) => {
    try {
      const name = validateName(req.body && req.body.name);
      const email = normalizeEmail(req.body && req.body.email);
      const password = validatePassword(req.body && req.body.password);
      if (req.body.confirmPassword !== password) throw new HttpError(400, 'Passwords do not match.');
      const hash = await bcrypt.hash(password, 10);
      const { rows } = await db.query(
        `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3)
         ON CONFLICT (email) DO NOTHING RETURNING id, email, name`,
        [email, name, hash]
      );
      if (!rows.length) throw new HttpError(409, 'An account with this email already exists.');
      issueSession(res, rows[0], config);
      res.status(201).json({ user: rows[0] });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', (req, res) => {
    clearSession(res, config);
    res.json({ ok: true });
  });

  // Non-failing session probe for the sign-in page (avoids a noisy 401 in the console).
  router.get('/session', (req, res, next) => {
    getSessionUser(db, config, req)
      .then((user) => res.json({ user }))
      .catch(next);
  });

  router.get('/me', requireAuth(db, config), (req, res) => {
    res.json({ user: req.user });
  });

  return router;
};
