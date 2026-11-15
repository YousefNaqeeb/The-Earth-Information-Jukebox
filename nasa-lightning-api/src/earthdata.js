'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { createWriteStream } = require('node:fs');
const got = require('got');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Cookie, CookieJar } = require('tough-cookie');

const REGION = process.env.NASA_S3_REGION || 'us-west-2';
let cachedCredentials;

function formatS3ErrorDetails(error) {
  const metadata = error?.$metadata || {};
  const status = metadata.httpStatusCode;
  const code = (
    typeof error?.name === 'string' &&
    /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
  ) ? error.name : null;
  const safeRequestId = (value) => (
    typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9._:/+-]+$/.test(value)
      ? value
      : null
  );
  const requestId = safeRequestId(metadata.requestId || metadata.extendedRequestId);

  return [
    `HTTP status: ${Number.isInteger(status) && status >= 100 && status <= 599 ? status : 'unavailable'}`,
    `AWS error code: ${code || 'unavailable'}`,
    `AWS request ID: ${requestId || 'unavailable'}`
  ].join('; ');
}

async function getTemporaryCredentials() {
  if (!process.env.EARTHDATA_USERNAME || !process.env.EARTHDATA_PASSWORD) {
    throw new Error('Earthdata Login is required to download science granules. Set EARTHDATA_USERNAME and EARTHDATA_PASSWORD in .env.');
  }

  if (cachedCredentials && cachedCredentials.expiration > Date.now() + 60_000) {
    return cachedCredentials;
  }

  const endpoint = process.env.NASA_S3_CREDENTIALS_URL || 'https://data.ghrc.earthdata.nasa.gov/s3credentials';
  const initial = await got.get(endpoint, { followRedirect: false, retry: { limit: 0 } });
  const authLocation = initial.headers.location;
  if (!authLocation) throw new Error('Earthdata S3 credentials service did not provide an authentication redirect.');

  const authResponse = await got.post(authLocation, {
    form: {
      credentials: Buffer.from(`${process.env.EARTHDATA_USERNAME}:${process.env.EARTHDATA_PASSWORD}`).toString('base64')
    },
    headers: { Origin: endpoint },
    followRedirect: false
  });
  if (!authResponse.headers.location) {
    throw new Error('Earthdata Login did not provide the expected authorization redirect; verify your account and credentials.');
  }

  const tokenResponse = await got.get(authResponse.headers.location, { followRedirect: false, retry: { limit: 0 } });
  const setCookies = tokenResponse.headers['set-cookie'] || [];
  const jar = new CookieJar();
  for (const rawCookie of setCookies) {
    const cookie = Cookie.parse(rawCookie);
    if (cookie) await jar.setCookie(cookie, endpoint);
  }

  const credentialResponse = await got.get(endpoint, {
    cookieJar: jar,
    responseType: 'json',
    retry: { limit: 0 }
  });
  const body = credentialResponse.body;
  if (!body.accessKeyId || !body.secretAccessKey || !body.sessionToken || !body.expiration) {
    throw new Error('Earthdata returned an incomplete temporary S3 credential response.');
  }
  const expiration = Date.parse(body.expiration);
  if (!Number.isFinite(expiration)) throw new Error('Earthdata returned an invalid S3 credential expiration.');

  cachedCredentials = {
    accessKeyId: body.accessKeyId,
    secretAccessKey: body.secretAccessKey,
    sessionToken: body.sessionToken,
    expiration
  };
  return cachedCredentials;
}

function getObjectLocation(s3Url, granule) {
  const url = new URL(s3Url);
  if (url.protocol !== 's3:' || url.hostname !== 'ghrcw-protected') {
    throw new Error('CMR returned an unexpected S3 host; refusing to download outside the configured GHRC bucket.');
  }
  const key = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  const expectedPrefix = `${granule.shortName}__${granule.version}/`;
  if (!granule.shortName || !granule.version || !key.startsWith(expectedPrefix)) {
    throw new Error('CMR returned an unexpected ISS LIS object path; refusing to download it.');
  }
  return { bucket: url.hostname, key };
}

async function downloadGranule(granule, cacheDir) {
  if (!granule.s3Url) throw new Error(`CMR did not provide a direct S3 download URL for ${granule.name}.`);
  const { bucket, key } = getObjectLocation(granule.s3Url, granule);
  const filename = path.basename(granule.name);
  if (!/^[\w.-]+\.(?:nc|hdf)$/i.test(filename)) {
    throw new Error(`Refusing unexpected NASA granule filename: ${filename}`);
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  const destination = path.join(cacheDir, filename);
  if (fs.existsSync(destination) && fs.statSync(destination).size > 0) return destination;

  const temporary = `${destination}.part`;
  const credentials = await getTemporaryCredentials();
  const s3 = new S3Client({
    region: REGION,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken
    }
  });
  try {
    let result;
    try {
      result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    } catch (error) {
      const diagnostics = formatS3ErrorDetails(error);
      if (['ExpiredToken', 'InvalidToken', 'TokenRefreshRequired'].includes(error.name)) {
        cachedCredentials = undefined;
        throw new Error(`Earthdata temporary S3 credentials expired. ${diagnostics}`);
      }
      if (error.name === 'AccessDenied' || error.name === 'InvalidAccessKeyId') {
        throw new Error(`NASA denied access to the granule. ${diagnostics}`);
      }
      throw new Error(`NASA S3 request failed. ${diagnostics}`);
    }

    try {
      await pipeline(result.Body, createWriteStream(temporary, { flags: 'w' }));
      fs.renameSync(temporary, destination);
    } catch (error) {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      throw error;
    }
  } finally {
    s3.destroy();
  }
  return destination;
}

module.exports = { downloadGranule, formatS3ErrorDetails, getTemporaryCredentials };
