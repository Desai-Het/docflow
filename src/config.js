'use strict';

const crypto = require('crypto');
const path = require('path');

function loadConfig(env = process.env) {
  const isProd = env.NODE_ENV === 'production';
  let jwtSecret = env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) {
    if (isProd) {
      throw new Error('JWT_SECRET must be set to a random string of at least 32 characters in production.');
    }
    // Dev only: random per process (you will be signed out when the server restarts).
    jwtSecret = crypto.randomBytes(32).toString('hex');
  }
  return {
    port: Number(env.PORT) || 3000,
    isProd,
    jwtSecret,
    databaseUrl: env.DATABASE_URL || '',
    dataDir: env.DATA_DIR || path.join(__dirname, '..', 'data', 'pglite'),
    secureCookies: isProd,
    trustProxy: isProd,
    authRateLimit: Number(env.AUTH_RATE_LIMIT) || 20,
    logErrors: env.NODE_ENV !== 'test',
  };
}

module.exports = { loadConfig };
