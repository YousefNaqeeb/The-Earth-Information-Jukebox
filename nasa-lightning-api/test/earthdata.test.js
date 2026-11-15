'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatS3ErrorDetails } = require('../src/earthdata');

test('S3 diagnostics report only the HTTP status, AWS code, and request ID', () => {
  const details = formatS3ErrorDetails({
    name: 'AccessDenied',
    message: 'secret-access-key-do-not-print',
    Code: 'AccessDenied',
    $metadata: {
      httpStatusCode: 403,
      requestId: 'aws-request-123'
    },
    $response: {
      headers: { authorization: 'bearer-do-not-print' }
    }
  });

  assert.equal(details, 'HTTP status: 403; AWS error code: AccessDenied; AWS request ID: aws-request-123');
  assert.doesNotMatch(details, /secret-access-key|bearer-do-not-print/);
});

test('S3 diagnostics safely mark missing or malformed metadata unavailable', () => {
  const details = formatS3ErrorDetails({
    name: 'AccessDenied',
    Code: 'not a safe code or secret',
    $metadata: { requestId: 'not a safe request ID' }
  });

  assert.equal(details, 'HTTP status: unavailable; AWS error code: AccessDenied; AWS request ID: unavailable');
});
