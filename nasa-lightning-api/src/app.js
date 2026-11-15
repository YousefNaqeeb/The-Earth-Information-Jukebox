'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const nasa = require('./nasa-client');

const DATASET = 'Quality Controlled Lightning Imaging Sensor (LIS) on International Space Station (ISS) Science Data';

function validateDate(value, name) {
  if (value === undefined) return undefined;
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw Object.assign(new Error(`${name} must use YYYY-MM-DD.`), { statusCode: 400 });
  }
  return value;
}

function validateFilters(query, { includePagination = true } = {}) {
  const start = validateDate(query.startDate, 'startDate');
  const end = validateDate(query.endDate, 'endDate');
  if (start && end && start > end) {
    throw Object.assign(new Error('startDate must be on or before endDate.'), { statusCode: 400 });
  }
  const values = {};
  for (const key of ['minLat', 'maxLat', 'minLon', 'maxLon']) {
    if (query[key] === undefined) continue;
    const value = Number(query[key]);
    if (!Number.isFinite(value)) throw Object.assign(new Error(`${key} must be a finite number.`), { statusCode: 400 });
    values[key] = value;
  }
  const geoKeys = ['minLat', 'maxLat', 'minLon', 'maxLon'];
  const hasSomeGeo = geoKeys.some((key) => values[key] !== undefined);
  if (hasSomeGeo && geoKeys.some((key) => values[key] === undefined)) {
    throw Object.assign(new Error('Provide all four geographic bounds: minLat, maxLat, minLon, and maxLon.'), { statusCode: 400 });
  }
  if (hasSomeGeo && (values.minLat < -90 || values.maxLat > 90 || values.minLat >= values.maxLat ||
      values.minLon < -180 || values.maxLon > 180 || values.minLon >= values.maxLon)) {
    throw Object.assign(new Error('Geographic bounds must be ordered and within latitude [-90, 90] and longitude [-180, 180].'), { statusCode: 400 });
  }

  const filters = { startDate: start, endDate: end, ...values };
  if (includePagination) {
    const page = query.page === undefined ? 1 : Number(query.page);
    const limit = query.limit === undefined ? 100 : Number(query.limit);
    if (!Number.isInteger(page) || page < 1) throw Object.assign(new Error('page must be a positive integer.'), { statusCode: 400 });
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw Object.assign(new Error('limit must be an integer from 1 to 1000.'), { statusCode: 400 });
    }
    filters.page = page;
    filters.limit = limit;
    filters.offset = (page - 1) * limit;
  }
  if (filters.startDate) filters.startDate = `${filters.startDate}T00:00:00.000Z`;
  if (filters.endDate) {
    const nextDay = new Date(`${filters.endDate}T00:00:00.000Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    filters.endDate = nextDay.toISOString();
  }
  return filters;
}

function createApp(store, nasaClient = nasa) {
  const app = express();
  const origins = (process.env.CORS_ORIGINS || '*').split(',').map((origin) => origin.trim());
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: origins.includes('*') ? '*' : origins }));
  app.use(express.json({ limit: '16kb' }));
  app.use('/api/', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));

  app.get('/api/lightning/status', async (_req, res) => {
    let collection;
    try {
      collection = await nasaClient.getCollection();
    } catch (error) {
      return res.status(503).json({
        source: 'NASA ISS LIS',
        dataset: DATASET,
        datasetVersion: store.getState('datasetVersion'),
        collectionId: nasaClient.collectionId(),
        connection: {
          cmr: 'unavailable',
          earthdataLoginConfigured: Boolean(process.env.EARTHDATA_USERNAME && process.env.EARTHDATA_PASSWORD)
        },
        lastSuccessfulRetrieval: store.getState('lastSuccessfulRetrieval'),
        liveData: false,
        error: error.message
      });
    }
    return res.json({
      source: 'NASA ISS LIS',
      dataset: collection.title || DATASET,
      datasetVersion: collection.version,
      collectionId: collection.id,
      connection: {
        cmr: 'connected',
        earthdataLoginConfigured: Boolean(process.env.EARTHDATA_USERNAME && process.env.EARTHDATA_PASSWORD)
      },
      lastSuccessfulRetrieval: store.getState('lastSuccessfulRetrieval'),
      storedObservationCount: store.statistics().observationCount,
      liveData: false
    });
  });

  app.get('/api/lightning/granules', async (req, res, next) => {
    try {
      const filters = validateFilters(req.query);
      const page = await nasaClient.getGranulePage({
        ...filters,
        pageSize: filters.limit,
        startDate: filters.startDate?.slice(0, 10),
        endDate: filters.endDate ? new Date(new Date(filters.endDate).getTime() - 1).toISOString().slice(0, 10) : undefined
      });
      res.json({
        source: 'NASA ISS LIS',
        datasetVersion: (await nasaClient.getCollection()).version,
        totalRecords: page.totalHits,
        page: page.page,
        pageSize: page.pageSize,
        granules: page.granules
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/lightning/observations', (req, res, next) => {
    try {
      const filters = validateFilters(req.query);
      const result = store.queryObservations(filters);
      const observations = result.observations.map((observation) => ({
        ...observation,
        sourceGranule: observation.sourceGranule
      }));
      res.json({
        source: 'NASA ISS LIS',
        dataset: DATASET,
        datasetVersion: store.getState('datasetVersion'),
        retrievedAt: store.getState('lastSuccessfulRetrieval'),
        totalRecords: result.totalRecords,
        page: filters.page,
        pageSize: filters.limit,
        observations,
        ...(result.totalRecords === 0 ? {
          message: 'No extracted observations match this query. Ingest authorized NASA granules to populate the local store.'
        } : {})
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/lightning/observations/:id', (req, res) => {
    const observation = store.getObservation(req.params.id);
    if (!observation) return res.status(404).json({ error: 'Observation not found.' });
    return res.json({
      source: 'NASA ISS LIS',
      dataset: DATASET,
      datasetVersion: store.getState('datasetVersion'),
      retrievedAt: store.getState('lastSuccessfulRetrieval'),
      observation
    });
  });

  app.get('/api/lightning/statistics', (_req, res) => {
    res.json({
      source: 'NASA ISS LIS',
      dataset: DATASET,
      datasetVersion: store.getState('datasetVersion'),
      retrievedAt: store.getState('lastSuccessfulRetrieval'),
      ...store.statistics()
    });
  });

  app.use((error, _req, res, _next) => {
    const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
    if (status >= 500) console.error(error);
    res.status(status).json({ error: status === 500 ? 'Internal server error.' : error.message });
  });

  return app;
}

module.exports = { createApp, validateFilters };
