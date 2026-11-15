'use strict';

const dotenv = require('dotenv');
const path = require('node:path');
const { createStore } = require('./store');
const { createApp } = require('./app');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer from 1 to 65535.');
}

const store = createStore();
const server = createApp(store).listen(port, host, () => {
  console.log(`NASA ISS LIS API listening at http://${host}:${port}`);
});

function shutdown() {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
