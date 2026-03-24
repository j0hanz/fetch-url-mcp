import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  acceptsEventStream,
  acceptsJsonAndEventStream,
  createToolErrorResponse,
  handleToolError,
  isJsonRpcBatchRequest,
  isJsonRpcResponseBody,
  isMcpMessageBody,
  isMcpRequestBody,
} from '../dist/lib/mcp-tools.js';
import { FetchError } from '../dist/lib/utils.js';

// ── JSON-RPC body validation ────────────────────────────────────────

describe('isJsonRpcBatchRequest', () => {
  it('returns true for an array', () => {
    assert.equal(isJsonRpcBatchRequest([{}]), true);
  });

  it('returns false for an object', () => {
    assert.equal(isJsonRpcBatchRequest({}), false);
  });

  it('returns false for null', () => {
    assert.equal(isJsonRpcBatchRequest(null), false);
  });
});

describe('isMcpRequestBody', () => {
  it('accepts valid JSON-RPC request', () => {
    const body = {
      jsonrpc: '2.0',
      method: 'tools/call',
      id: 1,
      params: {},
    };
    assert.equal(isMcpRequestBody(body), true);
  });

  it('rejects request without jsonrpc field', () => {
    assert.equal(isMcpRequestBody({ method: 'test', id: 1 }), false);
  });

  it('rejects request with empty method', () => {
    assert.equal(isMcpRequestBody({ jsonrpc: '2.0', method: '' }), false);
  });

  it('rejects non-object', () => {
    assert.equal(isMcpRequestBody('not an object'), false);
  });
});

describe('isJsonRpcResponseBody', () => {
  it('accepts result response', () => {
    const body = { jsonrpc: '2.0', id: 1, result: {} };
    assert.equal(isJsonRpcResponseBody(body), true);
  });

  it('accepts error response', () => {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32600, message: 'Invalid Request' },
    };
    assert.equal(isJsonRpcResponseBody(body), true);
  });

  it('rejects request body', () => {
    assert.equal(
      isJsonRpcResponseBody({ jsonrpc: '2.0', method: 'test', id: 1 }),
      false
    );
  });
});

describe('isMcpMessageBody', () => {
  it('accepts a request', () => {
    assert.equal(
      isMcpMessageBody({ jsonrpc: '2.0', method: 'test', id: 1 }),
      true
    );
  });

  it('accepts a response', () => {
    assert.equal(isMcpMessageBody({ jsonrpc: '2.0', id: 1, result: {} }), true);
  });

  it('rejects invalid object', () => {
    assert.equal(isMcpMessageBody({ foo: 'bar' }), false);
  });
});

// ── Accept header parsing ───────────────────────────────────────────

describe('acceptsEventStream', () => {
  it('returns true for text/event-stream', () => {
    assert.equal(acceptsEventStream('text/event-stream'), true);
  });

  it('returns true when event-stream is one of multiple', () => {
    assert.equal(
      acceptsEventStream('application/json, text/event-stream'),
      true
    );
  });

  it('returns false for application/json only', () => {
    assert.equal(acceptsEventStream('application/json'), false);
  });

  it('returns false for null/undefined', () => {
    assert.equal(acceptsEventStream(null), false);
    assert.equal(acceptsEventStream(undefined), false);
  });
});

describe('acceptsJsonAndEventStream', () => {
  it('returns true for both json and event-stream', () => {
    assert.equal(
      acceptsJsonAndEventStream('application/json, text/event-stream'),
      true
    );
  });

  it('returns true for wildcard accept', () => {
    assert.equal(acceptsJsonAndEventStream('*/*'), true);
  });

  it('returns false when missing json', () => {
    assert.equal(acceptsJsonAndEventStream('text/event-stream'), false);
  });

  it('returns false when missing event-stream', () => {
    assert.equal(acceptsJsonAndEventStream('application/json'), false);
  });
});

// ── createToolErrorResponse ─────────────────────────────────────────

describe('createToolErrorResponse', () => {
  it('returns isError: true with message and url', () => {
    const result = createToolErrorResponse(
      'Something failed',
      'https://example.com'
    );
    assert.equal(result.isError, true);
    assert.equal(result.content.length, 1);

    const parsed = JSON.parse(
      (result.content[0] as { text: string }).text
    ) as Record<string, unknown>;
    assert.equal(parsed.error, 'Something failed');
    assert.equal(parsed.url, 'https://example.com');
  });

  it('includes code and statusCode when provided', () => {
    const result = createToolErrorResponse('Not found', 'https://example.com', {
      code: 'NOT_FOUND',
      statusCode: 404,
    });
    const parsed = JSON.parse(
      (result.content[0] as { text: string }).text
    ) as Record<string, unknown>;
    assert.equal(parsed.code, 'NOT_FOUND');
    assert.equal(parsed.statusCode, 404);
  });
});

// ── handleToolError ─────────────────────────────────────────────────

describe('handleToolError', () => {
  it('handles FetchError with status code', () => {
    const error = new FetchError(
      'HTTP 404: Not Found',
      'https://example.com',
      404
    );
    const result = handleToolError(error, 'https://example.com');
    assert.equal(result.isError, true);

    const parsed = JSON.parse(
      (result.content[0] as { text: string }).text
    ) as Record<string, unknown>;
    assert.equal(parsed.statusCode, 404);
  });

  it('handles FetchError with timeout details', () => {
    const error = new FetchError(
      'Request timeout',
      'https://example.com',
      504,
      { reason: 'timeout', timeout: 15000 }
    );
    const result = handleToolError(error, 'https://example.com');
    const parsed = JSON.parse(
      (result.content[0] as { text: string }).text
    ) as Record<string, unknown>;
    assert.equal(parsed.statusCode, 504);
    const details = parsed.details as Record<string, unknown> | undefined;
    assert.equal(details?.reason, 'timeout');
    assert.equal(details?.timeout, 15000);
  });

  it('handles AbortError with ABORTED code', () => {
    const error = new Error('Request was canceled');
    error.name = 'AbortError';
    const result = handleToolError(error, 'https://example.com');
    const parsed = JSON.parse(
      (result.content[0] as { text: string }).text
    ) as Record<string, unknown>;
    assert.equal(parsed.code, 'ABORTED');
  });

  it('handles generic Error with fallback message', () => {
    const error = new Error('Something broke');
    const result = handleToolError(
      error,
      'https://example.com',
      'Fetch failed'
    );
    const parsed = JSON.parse(
      (result.content[0] as { text: string }).text
    ) as Record<string, unknown>;
    assert.ok(
      (parsed.error as string).includes('Fetch failed'),
      'Should include fallback message'
    );
    assert.ok(
      (parsed.error as string).includes('Something broke'),
      'Should include original message'
    );
  });

  it('handles non-Error values', () => {
    const result = handleToolError(
      'string error',
      'https://example.com',
      'Op failed'
    );
    assert.equal(result.isError, true);
    const parsed = JSON.parse(
      (result.content[0] as { text: string }).text
    ) as Record<string, unknown>;
    assert.equal(parsed.code, 'FETCH_ERROR');
  });

  it('handles FetchError with queue_full reason', () => {
    const error = new FetchError('Queue full', 'https://example.com', 503, {
      reason: 'queue_full',
    });
    const result = handleToolError(error, 'https://example.com');
    const parsed = JSON.parse(
      (result.content[0] as { text: string }).text
    ) as Record<string, unknown>;
    assert.equal(parsed.code, 'queue_full');
    const details = parsed.details as Record<string, unknown> | undefined;
    assert.equal(details?.reason, 'queue_full');
  });
});
