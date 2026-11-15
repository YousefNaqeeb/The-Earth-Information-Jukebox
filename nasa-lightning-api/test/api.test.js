'use strict';

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { createStore } = require('../src/store');

const store = createStore(':memory:');
const nasa = {
  collectionId: () => 'C3838944284-GHRC_DAAC',
  getCollection: async () => ({
    id: 'C3838944284-GHRC_DAAC',
    title: 'Quality Controlled Lightning Imaging Sensor (LIS) on International Space Station (ISS) Science Data V3',
    version: '3'
  }),
  getGranulePage: async () => ({ totalHits: 0, page: 1, pageSize: 10, granules: [] })
};
let server;
let baseUrl;

before(async () => {
  server = createApp(store, nasa).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  store.close();
});

test('observations returns an explicit empty response before real data is ingested', async () => {
  const response = await fetch(`${baseUrl}/api/lightning/observations?limit=1`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.source, 'NASA ISS LIS');
  assert.equal(body.totalRecords, 0);
  assert.deepEqual(body.observations, []);
  assert.match(body.message, /Ingest authorized NASA granules/);
});

test('status reports the verified collection and historical nature of the dataset', async () => {
  const response = await fetch(`${baseUrl}/api/lightning/status`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.collectionId, 'C3838944284-GHRC_DAAC');
  assert.equal(body.datasetVersion, '3');
  assert.equal(body.connection.cmr, 'connected');
  assert.equal(body.liveData, false);
});

test('date and geographic filters accept valid query values', async () => {
  const response = await fetch(`${baseUrl}/api/lightning/observations?startDate=2023-11-16&endDate=2023-11-16&minLat=10&maxLat=11&minLon=20&maxLon=21`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.totalRecords, 0);
});

test('invalid geographic bounds and unknown observation IDs are explicit', async () => {
  const invalidDate = await fetch(`${baseUrl}/api/lightning/observations?startDate=2023-02-29`);
  assert.equal(invalidDate.status, 400);

  const invalid = await fetch(`${baseUrl}/api/lightning/observations?minLat=0&maxLat=1&minLon=1`);
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /all four geographic bounds/);

  const missing = await fetch(`${baseUrl}/api/lightning/observations/not-a-record`);
  assert.equal(missing.status, 404);
});
