'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { requireCsrfHeader } = require('./auth');
const { HttpError } = require('./validate');
const { ImportError } = require('./importer');
const authRoutes = require('./routes/auth');
const docRoutes = require('./routes/docs');

function createApp(db, config) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1); // correct client IPs behind Render's proxy

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"], // no inline scripts, no CDNs: Quill is served from node_modules
          styleSrc: ["'self'", "'unsafe-inline'"], // Quill sets inline style attributes
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: config.secureCookies ? [] : null,
        },
      },
    })
  );

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.use('/api', express.json({ limit: '2mb' }), cookieParser(), requireCsrfHeader);
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api/auth', authRoutes(db, config));
  app.use('/api/docs', docRoutes(db, config));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  const quillDist = path.dirname(require.resolve('quill/dist/quill.js'));
  app.use('/vendor/quill', express.static(quillDist, { maxAge: '7d', index: false }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'], index: 'index.html' }));
  app.use((req, res) => res.status(404).sendFile(path.join(__dirname, '..', 'public', 'index.html')));

  // Central error handler: predictable JSON errors, never leaks stack traces.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err instanceof ImportError) return res.status(400).json({ error: err.message });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body.' });
    if (config.logErrors) console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  return app;
}

module.exports = { createApp };
