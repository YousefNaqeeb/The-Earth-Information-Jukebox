'use strict';

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
require('dotenv').config();
const { createStore } = require('../src/store');
const { createApp } = require('../src/app');

const enabled = process.env.RUN_NASA_INTEGRATION === '1';
const store = enabled ? createStore() : null;
let server;
let baseUrl;

before(async () => {
  if (!enabled) return;
  server = createApp(store).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  store?.close();
});

test('the API serves observations extracted from a processed NASA ISS LIS granule', { skip: !enabled }, async () => {
  const granules = store.db.prepare("SELECT name FROM granules WHERE status = 'processed'").all();
  assert.ok(granules.length > 0, 'Run npm run ingest with Earthdata access and a verified variable map first.');

  const response = await fetch(`${baseUrl}/api/lightning/observations?limit=1`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.totalRecords > 0, 'No extracted NASA ISS LIS observations are stored.');
  assert.ok(body.observations.length > 0);
  assert.ok(granules.some(({ name }) => body.observations[0].sourceGranule === name));
  assert.match(body.observations[0].sourceGranule, /^ISS_LIS_SC_V3\.0_/);
  assert.ok(Number.isFinite(body.observations[0].latitude));
  assert.ok(Number.isFinite(body.observations[0].longitude));
  assert.ok(!Number.isNaN(Date.parse(body.observations[0].timestamp)));

  const observation = body.observations[0];
  const date = observation.timestamp.slice(0, 10);
  const nearby = new URLSearchParams({
    startDate: date,
    endDate: date,
    minLat: String(Math.max(-90, observation.latitude - 0.000001)),
    maxLat: String(Math.min(90, observation.latitude + 0.000001)),
    minLon: String(Math.max(-180, observation.longitude - 0.000001)),
    maxLon: String(Math.min(180, observation.longitude + 0.000001)),
    limit: '10'
  });
  const filteredResponse = await fetch(`${baseUrl}/api/lightning/observations?${nearby}`);
  const filtered = await filteredResponse.json();
  assert.equal(filteredResponse.status, 200);
  assert.ok(filtered.observations.some(({ id }) => id === observation.id));
});
