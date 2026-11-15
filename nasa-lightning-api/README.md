# NASA ISS LIS Lightning Data API

A Node.js/Express service that discovers NASA's historical ISS Lightning Imaging Sensor (LIS) science granules in CMR, downloads the original NetCDF-4 or HDF-4 files from GHRC, extracts configured observations with a Python scientific-data reader, stores them in SQLite, and serves JSON over REST.

This is **historical** data, not a live lightning feed.

## Verified NASA collection

Checked against NASA's data catalog and CMR on 2026-11-15:

- Collection: **Quality Controlled Lightning Imaging Sensor (LIS) on International Space Station (ISS) Science Data V3**
- CMR collection concept ID: `C3838944284-GHRC_DAAC`
- Short name / version / DOI: `isslis_v3_fin` / `3` / `10.5067/LIS/ISSLIS/DATA114`
- Coverage: 2017-03-01 through 2023-11-16
- CMR reported 72,828 granules at the time checked. CMR is authoritative for the current count.
- Distribution includes NetCDF-4 (`.nc`) and HDF-4 (`.hdf`); CMR granule metadata includes HTTPS downloads, direct `s3://ghrcw-protected/...` links, and OPeNDAP links. This implementation uses the CMR-provided S3 links.
- The granule data objects require Earthdata Login. The associated public-access metadata and catalog description do not mean the protected S3 object can be read anonymously.

The NASA Earthdata recipe documents `lightning_flash_lat` and `lightning_flash_lon` for its ISS LIS flash-location workflow. The recipe is not a schema guarantee for every file/version. The actual file could not be downloaded for inspection in the development environment (the protected download returned HTTP 401 without Earthdata credentials), so this project deliberately does not assume a timestamp field or measurement fields. The included reader inspects each authorized file and extraction requires an explicit variable map verified against that file.

## Project structure

```text
nasa-lightning-api/
├── .env.example
├── package.json
├── requirements.txt
├── README.md
├── scripts/
│   └── read_lis.py       # NetCDF-4/HDF-4 inspection and configured extraction
├── src/
│   ├── app.js            # Express REST routes and validation
│   ├── earthdata.js      # Earthdata Login -> temporary GHRC S3 credentials
│   ├── ingest.js         # Bounded CMR discovery/download/extraction pipeline
│   ├── nasa-client.js    # CMR collection/granule discovery and pagination
│   ├── server.js
│   └── store.js          # SQLite cache and observation store
└── test/
    ├── api.test.js
    └── nasa.integration.test.js
```

## Requirements and setup

- Node.js 20+
- Python 3.10+
- NASA Earthdata Login account for downloading granules
- For NetCDF-4: Python `netCDF4` and `numpy`
- For HDF-4: `pyhdf` and the HDF4 system library

Create a free account at [NASA Earthdata Login](https://urs.earthdata.nasa.gov/users/new). Add GHRC to your authorized applications if prompted.

```sh
cd nasa-lightning-api
npm install
python3 -m pip install -r requirements.txt
cp .env.example .env
```

Set `EARTHDATA_USERNAME` and `EARTHDATA_PASSWORD` in `.env`. Keep `.env` private; it is ignored by git. Credentials and temporary S3 tokens are used only by the backend and are never included in API responses. GHRC temporary S3 credentials are refreshed as needed. CMR discovery itself does not require credentials.

### Inspect the actual file schema before extraction

First let the service discover and download one real granule without a variable map:

```sh
npm run ingest -- --inspect --start-date 2023-11-16 --end-date 2023-11-16
```

This prints the inspected file's variable paths, shapes, dimensions, and attributes. You can also inspect a cached file directly:

```sh
python3 scripts/read_lis.py --inspect ./data/granules/ISS_LIS_SC_V3.0_....nc
```

Review the output's variable paths, shapes, dimensions, and attributes. Configure `.env` `ISS_LIS_VARIABLE_MAP` with the actual timestamp, latitude, longitude, and optional measurement variable paths. The selected arrays must represent corresponding observations and have matching lengths. For example, the following is a **shape example only**, not a verified V3 mapping:

```dotenv
ISS_LIS_VARIABLE_MAP={"timestamp":"actual_time_path","latitude":"actual_latitude_path","longitude":"actual_longitude_path","measurements":["actual_measurement_path"]}
```

NASA's recipe identifies `lightning_flash_lat` and `lightning_flash_lon` in its documented workflow, but inspect the V3 granule you are processing and use the exact paths reported by the helper. Include only measurements actually present in your file. Missing/fill coordinates, invalid coordinates, and timestamps that cannot be decoded are skipped; selected fields missing from a subsequent file are reported as failed granules, not silently substituted.

## Discover and ingest

Ingestion runs on demand, not on server start. It defaults to NetCDF-4 and at most 20 granules, to avoid accidentally downloading the whole archive. Select a bounded date range and optional geographic bounds:

```sh
npm run ingest -- --start-date 2023-11-16 --end-date 2023-11-16 --limit 5
npm run ingest -- --start-date 2018-01-04 --end-date 2018-01-04 --format nc --limit 10
```

To select HDF-4, use `--format hdf` after installing its Python support. Set `--limit 0` only when intentionally processing every matching granule. `INGEST_MAX_GRANULES` provides the default bound. CMR discovery paginates through results; the local store and cache prevent duplicate observations and unnecessary repeat downloads.

If extraction fails because a configured variable is not present or aligned, inspect that exact granule and correct the map before retrying. Failed granule details are retained in the local database and the CLI reports the error.

## Start the API

```sh
npm start
```

By default the service listens on `127.0.0.1:3000`. To make it reachable behind a secured public reverse proxy, set `HOST=0.0.0.0`, expose only the proxy's HTTPS port, set `CORS_ORIGINS` to the intended browser origins, and protect the host/database with standard deployment controls. The API is read-only and rate limited. It does not expose Earthdata credentials.

### Endpoints

All responses are JSON:

- `GET /api/lightning/status` — current CMR connection and collection version, stored count, last successful retrieval, and `liveData: false`.
- `GET /api/lightning/granules?page=1&limit=25` — current NASA granule metadata, with CMR date and geographic filters supported.
- `GET /api/lightning/observations?page=1&limit=100` — stored extracted observations.
- `GET /api/lightning/observations?startDate=2023-11-16&endDate=2023-11-16` — inclusive UTC calendar-date filter.
- `GET /api/lightning/observations?minLat=-10&maxLat=10&minLon=-20&maxLon=20` — geographic filter; all four bounds are required together.
- `GET /api/lightning/observations/{id}` — an individual record by its stable generated identifier.
- `GET /api/lightning/statistics` — count, observed date coverage, bounds, and a 10-degree geographic count grid.

Observation IDs are stable hashes of the source granule and record index. Content fingerprints prevent duplicate observation insertions. Each observation preserves configured source variable names and their file-declared units.

### Example requests

```sh
curl 'http://127.0.0.1:3000/api/lightning/status'
curl 'http://127.0.0.1:3000/api/lightning/granules?startDate=2023-11-16&endDate=2023-11-16&limit=10'
curl 'http://127.0.0.1:3000/api/lightning/observations?minLat=-10&maxLat=10&minLon=-20&maxLon=20&limit=25'
curl 'http://127.0.0.1:3000/api/lightning/statistics'
```

Before any authorized granules are processed, the observations endpoint returns `totalRecords: 0`, an empty `observations` array, and a message explaining how to populate the store. A populated response has this shape; values are intentionally omitted here rather than presenting fabricated measurements:

```json
{
  "source": "NASA ISS LIS",
  "dataset": "Quality Controlled Lightning Imaging Sensor (LIS) on International Space Station (ISS) Science Data",
  "datasetVersion": "3",
  "retrievedAt": "ISO 8601 timestamp",
  "totalRecords": 0,
  "page": 1,
  "pageSize": 100,
  "observations": [
    {
      "id": "stable generated identifier",
      "timestamp": "ISO 8601 timestamp read from the configured file variable",
      "latitude": "value read from the configured file variable",
      "longitude": "value read from the configured file variable",
      "lightningMeasurement": {
        "variables": {
          "original/file/variable/path": {
            "value": "value from NASA file",
            "units": "original file units"
          }
        }
      },
      "sourceGranule": "NASA granule filename"
    }
  ]
}
```

`totalRecords` is the count matching the query, not the total archive size. Individual records are only returned after extraction from a NASA science file; CMR metadata is never represented as a lightning observation.

## Tests

Run API and validation tests:

```sh
npm test
```

After authenticating, configuring the verified variable map, and processing at least one real granule, verify the live local API against the stored NASA-derived data:

```sh
npm run test:integration
```

The integration test requires at least one granule with `processed` status and non-empty extracted observations; it fails rather than substituting fixture observations.

## References

- [NASA data catalog](https://data.nasa.gov/dataset/quality-controlled-lightning-imaging-sensor-lis-on-international-space-station-iss-science)
- [Verified Version 3 CMR collection](https://cmr.earthdata.nasa.gov/search/collections.umm_json?concept_id=C3838944284-GHRC_DAAC)
- [CMR granule search API](https://cmr.earthdata.nasa.gov/search/granules)
- [NASA ISS LIS flash-location recipe](https://www.earthdata.nasa.gov/learn/data-recipes/iss-lis-lightning-flash-location-quickview-using-python-2-7-gis)
- [GHRC Earthdata Login S3 credential documentation](https://data.ghrc.earthdata.nasa.gov/s3credentialsREADME)
