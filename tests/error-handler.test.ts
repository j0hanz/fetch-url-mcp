import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FetchError } from '../dist/errors.js';
import { errorHandler } from '../dist/http.js';

function createMockResponse() {
  const headers = new Map();
  return {
    headersSent: false,
    statusCode: undefined,
    jsonBody: undefined,
    headerMap: headers,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.jsonBody = value;
      return this;
    },
    set(name, value) {
      this.headerMap.set(name.toLowerCase(), value);
      return this;
    },
  };
}

function createMockRequest() {
  return { method: 'GET', path: '/test' };
}

describe('errorHandler', () => {
  it('delegates to next when headers are already sent', () => {
    const err = new Error('boom');
    const req = createMockRequest();
    const res = createMockResponse();
    res.headersSent = true;

    let nextCalled = false;
    const next = (received) => {
      nextCalled = true;
      assert.equal(received, err);
    };

    errorHandler(err, req, res, next);

    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, undefined);
  });

  it('renders FetchError responses with retry-after header', () => {
    const err = new FetchError('Rate limited', 'https://example.com', 429, {
      retryAfter: 120,
    });
    const req = createMockRequest();
    const res = createMockResponse();

    errorHandler(err, req, res, () => {});

    assert.equal(res.statusCode, 429);
    assert.equal(res.headerMap.get('retry-after'), '120');
    assert.equal(res.jsonBody.error.code, 'HTTP_429');
    assert.equal(res.jsonBody.error.message, 'Rate limited');
    assert.equal(res.jsonBody.error.statusCode, 429);
  });

  it('renders generic errors as internal server errors', () => {
    const err = new Error('boom');
    const req = createMockRequest();
    const res = createMockResponse();

    errorHandler(err, req, res, () => {});

    assert.equal(res.statusCode, 500);
    assert.equal(res.jsonBody.error.code, 'INTERNAL_ERROR');
    assert.equal(res.jsonBody.error.message, 'Internal Server Error');
  });
});
