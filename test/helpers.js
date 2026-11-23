'use strict';

const request = require('supertest');
const { createDb, seed, DEMO_PASSWORD } = require('../src/db');
const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');

/** Fresh app backed by an in-memory Postgres (PGlite) for each test file. */
async function setup() {
  const config = loadConfig({ NODE_ENV: 'test', AUTH_RATE_LIMIT: '1000' });
  const db = await createDb({}); // no url + no dataDir => in-memory
  await seed(db);
  const app = createApp(db, config);
  return { app, db };
}

/** Logs in and returns a supertest agent that keeps the session cookie. */
async function login(app, email, password = DEMO_PASSWORD) {
  const agent = request.agent(app);
  await agent
    .post('/api/auth/login')
    .set('X-Requested-With', 'DocFlow')
    .send({ email, password })
    .expect(200);
  return agent;
}

const CSRF = ['X-Requested-With', 'DocFlow'];

module.exports = { setup, login, CSRF };
