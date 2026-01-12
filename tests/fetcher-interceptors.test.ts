import assert from 'node:assert/strict';
import diagnosticsChannel from 'node:diagnostics_channel';
import { afterEach, describe, it } from 'node:test';

import {
  recordFetchError,
  recordFetchResponse,
  startFetchTelemetry,
} from '../dist/fetch.js';
import { runWithRequestContext } from '../dist/observability.js';

function createCapture() {
  const channel = diagnosticsChannel.channel('superfetch.fetch');
  const events = [];
  const listener = (event) => {
    events.push(event);
  };
  channel.subscribe(listener);

  return {
    events,
    dispose: () => channel.unsubscribe(listener),
  };
}

describe('fetch telemetry interceptors', () => {
  let cleanup = () => {};

  afterEach(() => {
    cleanup();
    cleanup = () => {};
  });

  it('publishes redacted start events', () => {
    const capture = createCapture();
    cleanup = capture.dispose;

    const context = startFetchTelemetry(
      'https://user:pass@example.com/path?query=1#hash',
      'post'
    );

    const startEvent = capture.events.find((event) => event.type === 'start');
    assert.ok(startEvent);
    assert.equal(startEvent.method, 'POST');
    assert.equal(startEvent.requestId, context.requestId);
    assert.equal(startEvent.url, 'https://example.com/path');
    assert.equal(context.url, 'https://example.com/path');
  });

  it('publishes end events with status and duration', () => {
    const capture = createCapture();
    cleanup = capture.dispose;

    const context = startFetchTelemetry('https://example.com', 'get');
    const response = new Response('ok', { status: 201 });

    recordFetchResponse(context, response, 2);

    const endEvent = capture.events.find((event) => event.type === 'end');
    assert.ok(endEvent);
    assert.equal(endEvent.requestId, context.requestId);
    assert.equal(endEvent.status, 201);
    assert.equal(typeof endEvent.duration, 'number');
  });

  it('publishes error events with status and error codes', () => {
    const capture = createCapture();
    cleanup = capture.dispose;

    const context = startFetchTelemetry('https://example.com', 'get');
    const error = Object.assign(new Error('boom'), { code: 'ECONNRESET' });

    recordFetchError(context, error, 502);

    const errorEvent = capture.events.find((event) => event.type === 'error');
    assert.ok(errorEvent);
    assert.equal(errorEvent.requestId, context.requestId);
    assert.equal(errorEvent.status, 502);
    assert.equal(errorEvent.code, 'ECONNRESET');
    assert.equal(errorEvent.error, 'boom');
  });

  it('includes request context correlation fields when available', async () => {
    const capture = createCapture();
    cleanup = capture.dispose;

    await runWithRequestContext(
      { requestId: 'context-request', operationId: 'context-operation' },
      async () => {
        const context = startFetchTelemetry('https://example.com', 'get');
        recordFetchResponse(context, new Response('ok', { status: 200 }));
      }
    );

    const startEvent = capture.events.find((event) => event.type === 'start');
    assert.ok(startEvent);
    assert.equal(startEvent.contextRequestId, 'context-request');
    assert.equal(startEvent.operationId, 'context-operation');
    assert.notEqual(startEvent.requestId, 'context-request');

    const endEvent = capture.events.find((event) => event.type === 'end');
    assert.ok(endEvent);
    assert.equal(endEvent.contextRequestId, 'context-request');
    assert.equal(endEvent.operationId, 'context-operation');
  });
});
