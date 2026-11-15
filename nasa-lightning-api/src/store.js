'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

function createStore(filename = process.env.DATABASE_PATH || './data/lightning.sqlite') {
  const resolved = filename === ':memory:' ? filename : path.resolve(filename);
  if (resolved !== ':memory:') fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS granules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT,
      start_date TEXT,
      end_date TEXT,
      bbox_json TEXT,
      format TEXT,
      s3_url TEXT,
      local_path TEXT,
      status TEXT NOT NULL DEFAULT 'discovered',
      error TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS observations (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      timestamp TEXT,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      measurements_json TEXT NOT NULL,
      source_granule TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS observations_time_idx ON observations(timestamp);
    CREATE INDEX IF NOT EXISTS observations_location_idx ON observations(latitude, longitude);
    CREATE TABLE IF NOT EXISTS state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const upsertGranuleStatement = db.prepare(`
    INSERT INTO granules (id, name, version, start_date, end_date, bbox_json, format, s3_url, local_path, status, error, updated_at)
    VALUES (@id, @name, @version, @startDate, @endDate, @bbox, @format, @s3Url, @localPath, @status, @error, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, version=excluded.version, start_date=excluded.start_date,
      end_date=excluded.end_date, bbox_json=excluded.bbox_json, format=excluded.format,
      s3_url=excluded.s3_url, local_path=COALESCE(excluded.local_path, granules.local_path),
      status=excluded.status, error=excluded.error, updated_at=excluded.updated_at
  `);
  const insertObservationStatement = db.prepare(`
    INSERT OR IGNORE INTO observations
      (id, fingerprint, timestamp, latitude, longitude, measurements_json, source_granule, created_at)
    VALUES (@id, @fingerprint, @timestamp, @latitude, @longitude, @measurements, @sourceGranule, @createdAt)
  `);

  function upsertGranule(granule, status, { localPath = null, error = null } = {}) {
    upsertGranuleStatement.run({
      id: granule.id,
      name: granule.name,
      version: granule.version || null,
      startDate: granule.startDate || null,
      endDate: granule.endDate || null,
      bbox: granule.bbox ? JSON.stringify(granule.bbox) : null,
      format: granule.format || null,
      s3Url: granule.s3Url || null,
      localPath,
      status,
      error,
      updatedAt: new Date().toISOString()
    });
  }

  function insertObservation(sourceGranule, record) {
    const measurements = JSON.stringify(record.lightningMeasurement);
    const canonical = JSON.stringify([
      record.timestamp, record.latitude, record.longitude, record.lightningMeasurement
    ]);
    insertObservationStatement.run({
      id: crypto.createHash('sha256').update(`${sourceGranule}:${record.recordIndex}`).digest('hex'),
      fingerprint: crypto.createHash('sha256').update(canonical).digest('hex'),
      timestamp: record.timestamp,
      latitude: record.latitude,
      longitude: record.longitude,
      measurements,
      sourceGranule,
      createdAt: new Date().toISOString()
    });
  }

  function setState(key, value) {
    db.prepare('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, value);
  }

  function getState(key) {
    return db.prepare('SELECT value FROM state WHERE key = ?').get(key)?.value ?? null;
  }

  function listGranules({ limit, offset }) {
    const totalRecords = db.prepare('SELECT COUNT(*) AS count FROM granules').get().count;
    const rows = db.prepare(`
      SELECT id, name, version, start_date AS startDate, end_date AS endDate,
        bbox_json AS bboxJson, format, status, error, updated_at AS updatedAt
      FROM granules ORDER BY start_date, name LIMIT ? OFFSET ?
    `).all(limit, offset).map((row) => ({
      ...row,
      bbox: row.bboxJson ? JSON.parse(row.bboxJson) : null,
      bboxJson: undefined
    }));
    return { totalRecords, granules: rows };
  }

  function queryObservations({ startDate, endDate, minLat, maxLat, minLon, maxLon, limit, offset }) {
    const where = [];
    const values = [];
    if (startDate) { where.push('timestamp >= ?'); values.push(startDate); }
    if (endDate) { where.push('timestamp < ?'); values.push(endDate); }
    if (minLat !== undefined) { where.push('latitude >= ?'); values.push(minLat); }
    if (maxLat !== undefined) { where.push('latitude <= ?'); values.push(maxLat); }
    if (minLon !== undefined) { where.push('longitude >= ?'); values.push(minLon); }
    if (maxLon !== undefined) { where.push('longitude <= ?'); values.push(maxLon); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const totalRecords = db.prepare(`SELECT COUNT(*) AS count FROM observations ${clause}`).get(...values).count;
    const rows = db.prepare(`
      SELECT id, timestamp, latitude, longitude, measurements_json AS measurementsJson, source_granule AS sourceGranule
      FROM observations ${clause} ORDER BY timestamp, id LIMIT ? OFFSET ?
    `).all(...values, limit, offset);
    return {
      totalRecords,
      observations: rows.map((row) => ({
        id: row.id,
        timestamp: row.timestamp,
        latitude: row.latitude,
        longitude: row.longitude,
        lightningMeasurement: JSON.parse(row.measurementsJson),
        sourceGranule: row.sourceGranule
      }))
    };
  }

  function getObservation(id) {
    const row = db.prepare(`
      SELECT id, timestamp, latitude, longitude, measurements_json AS measurementsJson, source_granule AS sourceGranule
      FROM observations WHERE id = ?
    `).get(id);
    return row ? {
      id: row.id,
      timestamp: row.timestamp,
      latitude: row.latitude,
      longitude: row.longitude,
      lightningMeasurement: JSON.parse(row.measurementsJson),
      sourceGranule: row.sourceGranule
    } : null;
  }

  function statistics() {
    const summary = db.prepare(`
      SELECT COUNT(*) AS count, MIN(timestamp) AS firstTimestamp, MAX(timestamp) AS lastTimestamp,
        MIN(latitude) AS south, MAX(latitude) AS north, MIN(longitude) AS west, MAX(longitude) AS east
      FROM observations
    `).get();
    const grid = db.prepare(`
      SELECT (CAST(latitude / 10 AS INTEGER) -
        CASE WHEN latitude < 0 AND latitude % 10 != 0 THEN 1 ELSE 0 END) * 10 AS latBand,
        (CAST(longitude / 10 AS INTEGER) -
        CASE WHEN longitude < 0 AND longitude % 10 != 0 THEN 1 ELSE 0 END) * 10 AS lonBand,
        COUNT(*) AS count
      FROM observations GROUP BY latBand, lonBand ORDER BY count DESC LIMIT 100
    `).all();
    return {
      observationCount: summary.count,
      dateCoverage: { start: summary.firstTimestamp, end: summary.lastTimestamp },
      geographicBounds: summary.count ? {
        south: summary.south, north: summary.north, west: summary.west, east: summary.east
      } : null,
      geographicDistribution: { gridDegrees: 10, cells: grid }
    };
  }

  return {
    db,
    upsertGranule,
    insertObservation,
    setState,
    getState,
    listGranules,
    queryObservations,
    getObservation,
    statistics,
    close: () => db.close()
  };
}

module.exports = { createStore };
