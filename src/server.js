'use strict';

require('dotenv').config({ quiet: true });
const fs = require('fs');
const { loadConfig } = require('./config');
const { createDb, seed } = require('./db');
const { createApp } = require('./app');

async function main() {
  const config = loadConfig();
  if (!config.databaseUrl) fs.mkdirSync(config.dataDir, { recursive: true });

  const db = await createDb({ databaseUrl: config.databaseUrl, dataDir: config.dataDir });
  await seed(db);

  const app = createApp(db, config);
  const server = app.listen(config.port, () => {
    console.log(`DocFlow running at http://localhost:${config.port} (database: ${db.kind})`);
  });

  const shutdown = async () => {
    server.close();
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
