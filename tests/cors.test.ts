import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createCorsMiddleware } from '../dist/http.js';

function createNextTracker() {
  let nextCalled = 0;
  const next = () => {
    nextCalled += 1;
  };

  return { next, getCalls: () => nextCalled };
}

function createCorsRequest(method: string) {
  return {
    headers: { origin: 'https://client.test' },
    method,
  };
}

function createCorsResponseCapture() {
  const headers: Record<string, string> = {};
  let statusSent: number | undefined;
  const res = {
    header: (key: string, value: string) => {
      headers[key] = value;
      return res;
    },
    sendStatus: (code: number) => {
      statusSent = code;
      return res;
    },
  };

  return { res, headers, getStatusSent: () => statusSent };
}

function testHandlesOptionsPreflight() {
  const middleware = createCorsMiddleware();
  const { res, getStatusSent } = createCorsResponseCapture();
  const req = createCorsRequest('OPTIONS');
  const { next, getCalls } = createNextTracker();

  middleware(req as never, res as never, next);

  assert.equal(getStatusSent(), 200);
  assert.equal(getCalls(), 0);
}

function testPassesThroughNonOptionsRequests() {
  const middleware = createCorsMiddleware();
  const res = { header: () => res, sendStatus: () => res };
  const req = createCorsRequest('POST');
  const { next, getCalls } = createNextTracker();

  middleware(req as never, res as never, next);

  assert.equal(getCalls(), 1);
}

function registerCorsMiddlewareTests() {
  describe('createCorsMiddleware', () => {
    it('handles OPTIONS preflight', () => {
      testHandlesOptionsPreflight();
    });
    it('passes through non-OPTIONS requests', () => {
      testPassesThroughNonOptionsRequests();
    });
  });
}

registerCorsMiddlewareTests();
