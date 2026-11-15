'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const { getCollection, searchGranules } = require('./nasa-client');
const { downloadGranule } = require('./earthdata');
const { createStore } = require('./store');

function cliOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const match = argv[index].match(/^--([^=]+)(?:=(.*))?$/);
    if (!match) continue;
    const key = match[1].replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    options[key] = match[2] ?? argv[index + 1];
    if (match[2] === undefined && argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) index += 1;
    else if (match[2] === undefined) options[key] = true;
  }
  return options;
}

function pythonMap() {
  const value = process.env.ISS_LIS_VARIABLE_MAP;
  if (!value) {
    throw new Error('Set ISS_LIS_VARIABLE_MAP after inspecting an authorized granule. See README.md; the extractor will not guess science variables.');
  }
  const map = JSON.parse(value);
  for (const role of ['timestamp', 'latitude', 'longitude']) {
    if (typeof map[role] !== 'string' || !map[role]) {
      throw new Error(`ISS_LIS_VARIABLE_MAP must define the actual ${role} variable path.`);
    }
  }
  if (map.measurements !== undefined && !Array.isArray(map.measurements)) {
    throw new Error('ISS_LIS_VARIABLE_MAP.measurements must be an array of actual variable paths.');
  }
  return map;
}

function validateCliFilters(options) {
  const startDate = options['start-date'];
  const endDate = options['end-date'];
  for (const [name, value] of [['start-date', startDate], ['end-date', endDate]]) {
    const parsed = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(`${value}T00:00:00Z`)
      : null;
    if (value !== undefined && (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value)) {
      throw new Error(`--${name} must use YYYY-MM-DD.`);
    }
  }
  if (startDate && endDate && startDate > endDate) {
    throw new Error('--start-date must be on or before --end-date.');
  }

  const keys = ['min-lat', 'max-lat', 'min-lon', 'max-lon'];
  const provided = keys.filter((key) => options[key] !== undefined);
  if (provided.length > 0 && provided.length !== keys.length) {
    throw new Error('Provide all geographic bounds: --min-lat, --max-lat, --min-lon, and --max-lon.');
  }
  const bounds = Object.fromEntries(provided.map((key) => [key, Number(options[key])]));
  if (provided.length && Object.values(bounds).some((value) => !Number.isFinite(value))) {
    throw new Error('Geographic bounds must be finite numbers.');
  }
  if (provided.length && (bounds['min-lat'] < -90 || bounds['max-lat'] > 90 ||
      bounds['min-lat'] >= bounds['max-lat'] || bounds['min-lon'] < -180 ||
      bounds['max-lon'] > 180 || bounds['min-lon'] >= bounds['max-lon'])) {
    throw new Error('Geographic bounds must be ordered and within latitude [-90, 90] and longitude [-180, 180].');
  }
  return {
    startDate,
    endDate,
    minLat: bounds['min-lat'],
    maxLat: bounds['max-lat'],
    minLon: bounds['min-lon'],
    maxLon: bounds['max-lon']
  };
}

function extractFile(file, granule, store, map) {
  const python = process.env.PYTHON_EXECUTABLE || 'python3';
  const helper = path.resolve(__dirname, '../scripts/read_lis.py');
  const child = spawn(python, [helper, '--extract', file, '--map', JSON.stringify(map)], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const lines = readline.createInterface({ input: child.stdout });
  let helperError = '';
  let parseError;
  let validRecords = 0;
  let schemaSummary;

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { helperError += chunk; });
  lines.on('line', (line) => {
    if (parseError) return;
    try {
      const message = JSON.parse(line);
      if (message.type === 'schema') {
        schemaSummary = message.variables;
      } else if (message.type === 'observation') {
        store.insertObservation(granule.name, message.record);
        validRecords += 1;
      } else if (message.type === 'error') {
        parseError = new Error(message.message);
      }
    } catch (error) {
      parseError = new Error(`Could not read extractor output: ${error.message}`);
    }
  });

  return new Promise((resolve, reject) => {
    child.on('error', (error) => reject(new Error(`Unable to start ${python}: ${error.message}`)));
    child.on('close', (code) => {
      if (parseError) return reject(parseError);
      if (code !== 0) {
        return reject(new Error(helperError.trim() || `Scientific file reader exited with code ${code}.`));
      }
      if (!schemaSummary) return reject(new Error('Scientific file reader returned no variable inventory.'));
      resolve({ validRecords, schemaSummary });
    });
  });
}

function inspectFile(file) {
  const python = process.env.PYTHON_EXECUTABLE || 'python3';
  const helper = path.resolve(__dirname, '../scripts/read_lis.py');
  const child = spawn(python, [helper, '--inspect', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let errorOutput = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { errorOutput += chunk; });
  return new Promise((resolve, reject) => {
    child.on('error', (error) => reject(new Error(`Unable to start ${python}: ${error.message}`)));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(errorOutput.trim() || `Scientific file inspection exited with code ${code}.`));
      try {
        resolve(JSON.parse(output));
      } catch (error) {
        reject(new Error(`Could not parse scientific file inventory: ${error.message}`));
      }
    });
  });
}

async function main() {
  const options = cliOptions(process.argv.slice(2));
  const format = (options.format || process.env.INGEST_FORMAT || 'nc').replace(/^\./, '').toLowerCase();
  if (!['nc', 'hdf'].includes(format)) throw new Error('--format must be nc or hdf.');

  const filters = validateCliFilters(options);
  const collection = await getCollection();
  if (options.inspect) {
    for await (const granule of searchGranules(filters, { maxGranules: 1, format })) {
      if (!granule.s3Url) throw new Error(`CMR did not provide a direct S3 link for ${granule.name}.`);
      const file = await downloadGranule(granule, path.resolve(process.env.GRANULE_CACHE_DIR || './data/granules'));
      console.log(JSON.stringify(await inspectFile(file), null, 2));
      return;
    }
    throw new Error('NASA CMR returned no granules matching the inspection filters.');
  }

  const map = pythonMap();
  const maxGranules = Number(options.limit ?? process.env.INGEST_MAX_GRANULES ?? 20);
  if (!Number.isInteger(maxGranules) || maxGranules < 0) throw new Error('--limit must be a non-negative integer.');
  const store = createStore();
  const cacheDir = path.resolve(process.env.GRANULE_CACHE_DIR || './data/granules');
  let succeeded = 0;
  let failed = 0;

  try {
    for await (const granule of searchGranules(filters, { maxGranules, format })) {
      if (!granule.s3Url) {
        failed += 1;
        store.upsertGranule(granule, 'failed', { error: 'CMR granule did not include a direct S3 link.' });
        console.error(`Skipping ${granule.name}: no direct S3 link.`);
        continue;
      }
      store.upsertGranule(granule, 'discovered');
      try {
        const file = await downloadGranule(granule, cacheDir);
        store.upsertGranule(granule, 'downloaded', { localPath: file });
        store.db.exec('BEGIN');
        const result = await extractFile(file, granule, store, map);
        store.db.exec('COMMIT');
        store.upsertGranule(granule, 'processed', { localPath: file });
        store.setState('lastSuccessfulRetrieval', new Date().toISOString());
        store.setState('datasetVersion', String(collection.version));
        succeeded += 1;
        console.log(`${granule.name}: extracted ${result.validRecords} valid observations.`);
      } catch (error) {
        try { store.db.exec('ROLLBACK'); } catch (rollbackError) {
          if (!String(rollbackError.message).includes('no transaction is active')) throw rollbackError;
        }
        failed += 1;
        store.upsertGranule(granule, 'failed', { error: error.message });
        console.error(`${granule.name}: ${error.message}`);
      }
    }
  } finally {
    store.close();
  }
  console.log(`Ingestion finished: ${succeeded} granules processed, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Ingestion failed: ${error.message}`);
  process.exitCode = 1;
});
