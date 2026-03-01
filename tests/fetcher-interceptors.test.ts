import assert from 'node:assert/strict';
import diagnosticsChannel from 'node:diagnostics_channel';
import { afterEach, describe, it } from 'node:test';

import { runWithRequestContext } from '../dist/lib/core.js';
import {
  recordFetchError,
  recordFetchResponse,
  startFetchTelemetry,
} from '../dist/lib/http.js';

type FetchEvent = Record<string, unknown>;

function isFetchEventWithType(
  value: unknown,
  type: string
): value is FetchEvent {
  return (
    !!value && typeof value === 'object' && Reflect.get(value, 'type') === type
  );
}

function findFetchEvent(events: readonly unknown[], type: string): FetchEvent {
  const event = events.find((candidate) =>
    isFetchEventWithType(candidate, type)
  );
  assert.ok(event, `${type} event should be published`);
  return event;
}

function createCapture() {
  const channel = diagnosticsChannel.channel('fetch-url-mcp.fetch');
  const events: unknown[] = [];
  const listener = (event: unknown) => {
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

    const startEvent = findFetchEvent(capture.events, 'start');
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

    const endEvent = findFetchEvent(capture.events, 'end');
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

    const errorEvent = findFetchEvent(capture.events, 'error');
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

    const startEvent = findFetchEvent(capture.events, 'start');
    assert.equal(startEvent.contextRequestId, 'context-request');
    assert.equal(startEvent.operationId, 'context-operation');
    assert.notEqual(startEvent.requestId, 'context-request');

    const endEvent = findFetchEvent(capture.events, 'end');
    assert.equal(endEvent.contextRequestId, 'context-request');
    assert.equal(endEvent.operationId, 'context-operation');
  });
});
