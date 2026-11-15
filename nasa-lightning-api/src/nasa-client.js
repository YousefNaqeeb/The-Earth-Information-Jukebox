'use strict';

const CMR_BASE = 'https://cmr.earthdata.nasa.gov/search';

function collectionId() {
  return process.env.NASA_CMR_COLLECTION_ID || 'C3838944284-GHRC_DAAC';
}

async function cmrGet(path, params = {}) {
  const url = new URL(`${CMR_BASE}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: { Accept: 'application/vnd.nasa.cmr.umm+json' },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) {
    throw new Error(`NASA CMR request failed (${response.status} ${response.statusText})`);
  }
  return response.json();
}

async function getCollection() {
  const result = await cmrGet('collections.umm_json', { concept_id: collectionId() });
  const item = result.items?.[0];
  if (!item) throw new Error(`NASA CMR collection not found: ${collectionId()}`);
  return {
    id: item.meta['concept-id'],
    title: item.umm.EntryTitle,
    version: item.umm.Version,
    shortName: item.umm.ShortName,
    doi: item.umm.DOI?.DOI,
    temporalExtent: item.umm.TemporalExtents?.[0]?.RangeDateTimes?.[0],
    formats: item.umm.ArchiveAndDistributionInformation?.FileDistributionInformation?.map((f) => f.Format) || []
  };
}

function normalizeGranule(item) {
  const umm = item.umm || {};
  const urls = umm.RelatedUrls || [];
  const direct = urls.find((link) =>
    link.Type === 'GET DATA VIA DIRECT ACCESS' &&
    typeof link.URL === 'string' &&
    link.URL.startsWith('s3://')
  );
  const download = urls.find((link) =>
    link.Type === 'GET DATA' &&
    typeof link.URL === 'string' &&
    new URL(link.URL).hostname === 'data.ghrc.earthdata.nasa.gov'
  );
  const rectangle = umm.SpatialExtent?.HorizontalSpatialDomain?.Geometry?.BoundingRectangles?.[0];
  const temporal = umm.TemporalExtent?.RangeDateTime || {};

  return {
    id: item.meta?.['concept-id'],
    name: umm.GranuleUR,
    version: umm.CollectionReference?.Version,
    shortName: umm.CollectionReference?.ShortName,
    collectionId: item.meta?.['collection-concept-id'],
    startDate: temporal.BeginningDateTime,
    endDate: temporal.EndingDateTime,
    bbox: rectangle ? {
      west: rectangle.WestBoundingCoordinate,
      east: rectangle.EastBoundingCoordinate,
      south: rectangle.SouthBoundingCoordinate,
      north: rectangle.NorthBoundingCoordinate
    } : null,
    size: umm.DataGranule?.ArchiveAndDistributionInformation?.[0]?.Size,
    sizeUnit: umm.DataGranule?.ArchiveAndDistributionInformation?.[0]?.SizeUnit,
    format: umm.DataGranule?.ArchiveAndDistributionInformation?.[0]?.Format ||
      (umm.GranuleUR?.toLowerCase().endsWith('.nc') ? 'NETCDF-4' : 'HDF4'),
    s3Url: direct?.URL || null,
    downloadUrl: download?.URL || null
  };
}

function makeSearchParams({ page = 1, pageSize = 25, startDate, endDate, minLat, maxLat, minLon, maxLon }) {
  const params = {
    collection_concept_id: collectionId(),
    page_num: page,
    page_size: pageSize
  };
  if (startDate || endDate) {
    params.temporal = `${startDate || ''},${endDate || ''}`;
  }
  if ([minLat, maxLat, minLon, maxLon].every((v) => v !== undefined)) {
    params.bounding_box = `${minLon},${minLat},${maxLon},${maxLat}`;
  }
  return params;
}

async function getGranulePage(filters = {}) {
  const pageSize = Math.min(Number(filters.pageSize) || 25, 2000);
  const page = Math.max(Number(filters.page) || 1, 1);
  const result = await cmrGet('granules.umm_json', makeSearchParams({ ...filters, page, pageSize }));
  return {
    totalHits: result.hits || 0,
    page,
    pageSize,
    granules: (result.items || []).map(normalizeGranule)
  };
}

async function * searchGranules(filters = {}, { maxGranules = 0, format = 'nc' } = {}) {
  const pageSize = Math.min(Number(filters.pageSize || process.env.NASA_CMR_PAGE_SIZE) || 2000, 2000);
  let page = 1;
  let yielded = 0;
  let totalHits = Infinity;

  while ((page - 1) * pageSize < totalHits) {
    const result = await getGranulePage({ ...filters, page, pageSize });
    totalHits = result.totalHits;
    for (const granule of result.granules) {
      const extension = granule.name?.split('.').pop()?.toLowerCase();
      if (format && extension !== format.toLowerCase()) continue;
      yield granule;
      yielded += 1;
      if (maxGranules > 0 && yielded >= maxGranules) return;
    }
    if (result.granules.length < pageSize) return;
    page += 1;
  }
}

module.exports = { collectionId, getCollection, getGranulePage, normalizeGranule, searchGranules };
