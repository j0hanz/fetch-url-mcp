import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createToolErrorResponse,
  FetchError,
  handleToolError,
  tryReadToolErrorPayload,
} from '../src/lib/error/index.js';
import {
  acceptsEventStream,
  acceptsJsonAndEventStream,
  isJsonRpcBatchRequest,
  isMcpMessageBody,
  isMcpRequestBody,
} from '../src/lib/mcp-interop.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertRecord(
  value: unknown,
  message: string
): asserts value is Record<string, unknown> {
  assert.ok(isRecord(value), message);
}

function parseToolPayload(result: {
  content: readonly unknown[];
}): Record<string, unknown> {
  const [block] = result.content;
  assertRecord(block, 'Expected first content block to be an object');
  assert.equal(block['type'], 'text');
  const text = block['text'];
  if (typeof text !== 'string') {
    assert.fail('Expected text payload');
  }

  const parsed: unknown = JSON.parse(text);
  assertRecord(parsed, 'Expected tool payload to be a JSON object');
  return parsed;
}

function getOptionalRecord(
  value: unknown
): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

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
    assert.equal('structuredContent' in result, false);

    const parsed = parseToolPayload(result);
    assert.equal(parsed['error'], 'Something failed');
    assert.equal(parsed['url'], 'https://example.com');
  });

  it('includes code and statusCode when provided', () => {
    const result = createToolErrorResponse('Not found', 'https://example.com', {
      category: 'upstream_http_error',
      code: 'NOT_FOUND',
      statusCode: 404,
      upstreamMessage: 'HTTP 404: Not Found',
    });
    const parsed = parseToolPayload(result);
    assert.equal(parsed['category'], 'upstream_http_error');
    assert.equal(parsed['code'], 'NOT_FOUND');
    assert.equal(parsed['statusCode'], 404);
    assert.equal(parsed['upstreamMessage'], 'HTTP 404: Not Found');
  });
});

describe('tryReadToolErrorPayload', () => {
  it('prefers structuredContent when present', () => {
    const result = createToolErrorResponse(
      'Something failed',
      'https://example.com',
      {
        category: 'upstream_http_error',
        code: 'HTTP_404',
        statusCode: 404,
        upstreamMessage: 'HTTP 404: Not Found',
      }
    );
    const payload = tryReadToolErrorPayload(result);
    assertRecord(payload, 'Expected parsed tool error payload');
    assert.equal(payload['error'], 'Something failed');
    assert.equal(payload['category'], 'upstream_http_error');
    assert.equal(payload['code'], 'HTTP_404');
    assert.equal(payload['statusCode'], 404);
    assert.equal(payload['upstreamMessage'], 'HTTP 404: Not Found');
  });

  it('falls back to parsing the text block', () => {
    const payload = tryReadToolErrorPayload({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: 'Legacy payload',
            url: 'https://example.com',
            category: 'fetch_error',
          }),
        },
      ],
    });
    assertRecord(payload, 'Expected parsed legacy payload');
    assert.equal(payload['error'], 'Legacy payload');
    assert.equal(payload['url'], 'https://example.com');
    assert.equal(payload['category'], 'fetch_error');
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

    const parsed = parseToolPayload(result);
    assert.equal(
      parsed['error'],
      "We couldn't find the resource at the target URL."
    );
    assert.equal(parsed['category'], 'upstream_http_error');
    assert.equal(parsed['upstreamMessage'], 'HTTP 404: Not Found');
    assert.equal(parsed['statusCode'], 404);
  });

  it('handles FetchError with timeout details', () => {
    const error = new FetchError(
      'Request timeout',
      'https://example.com',
      504,
      { reason: 'timeout', timeout: 15000 }
    );
    const result = handleToolError(error, 'https://example.com');
    const parsed = parseToolPayload(result);
    assert.equal(parsed['error'], 'The request to the target timed out.');
    assert.equal(parsed['category'], 'upstream_timeout');
    assert.equal(parsed['upstreamMessage'], 'Request timeout');
    assert.equal(parsed['statusCode'], 504);
    const details = getOptionalRecord(parsed['details']);
    assert.equal(details?.['reason'], 'timeout');
    assert.equal(details?.['timeout'], 15000);
  });

  it('handles AbortError with SystemErrors.ABORTED code', () => {
    const error = new Error('Request was canceled');
    error.name = 'AbortError';
    const result = handleToolError(error, 'https://example.com');
    const parsed = parseToolPayload(result);
    assert.equal(parsed['category'], 'upstream_aborted');
    assert.equal(parsed['code'], 'ABORTED');
  });

  it('handles generic Error with fallback message', () => {
    const error = new Error('Something broke');
    const result = handleToolError(
      error,
      'https://example.com',
      'Fetch failed'
    );
    const parsed = parseToolPayload(result);
    assert.ok(
      (parsed['error'] as string).includes('Something broke'),
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
    const parsed = parseToolPayload(result);
    assert.equal(parsed['category'], 'fetch_error');
    assert.equal(parsed['code'], 'FETCH_ERROR');
  });

  it('handles FetchError with queue_full reason', () => {
    const error = new FetchError('Queue full', 'https://example.com', 503, {
      reason: 'queue_full',
    });
    const result = handleToolError(error, 'https://example.com');
    const parsed = parseToolPayload(result);
    assert.equal(parsed['category'], 'queue_full');
    assert.equal(parsed['code'], 'queue_full');
    const details = getOptionalRecord(parsed['details']);
    assert.equal(details?.['reason'], 'queue_full');
  });

  it('classifies network FetchError (no httpStatus) as fetch_error, not upstream_http_error', () => {
    const error = new FetchError(
      'Network error',
      'https://example.com',
      undefined,
      { message: 'getaddrinfo ENOTFOUND example.com' }
    );
    const result = handleToolError(error, 'https://example.com');
    const parsed = parseToolPayload(result);
    assert.equal(parsed['category'], 'fetch_error');
    assert.equal(parsed['code'], 'FETCH_ERROR');
    assert.equal(parsed['statusCode'], 502);
    assert.equal(parsed['error'], 'Network error');
  });

  it('classifies real HTTP 404 FetchError as upstream_http_error', () => {
    const error = new FetchError(
      'HTTP 404: Not Found',
      'https://example.com',
      404
    );
    const result = handleToolError(error, 'https://example.com');
    const parsed = parseToolPayload(result);
    assert.equal(parsed['category'], 'upstream_http_error');
    assert.equal(parsed['code'], 'HTTP_404');
    assert.equal(parsed['statusCode'], 404);
    assert.equal(
      parsed['error'],
      "We couldn't find the resource at the target URL."
    );
  });

  it('handles ProtocolError with statusCode and strips SDK prefix', () => {
    const error = new ProtocolError(
      ProtocolErrorCode.InternalError,
      'Task execution failed'
    );
    const result = handleToolError(error, 'https://example.com');
    assert.equal(result.isError, true);
    const parsed = parseToolPayload(result);
    assert.equal(parsed['error'], 'Task execution failed');
    assert.equal(parsed['category'], 'mcp_error');
    assert.equal(parsed['code'], -32603);
    assert.equal(parsed['statusCode'], -32603);
  });

  it('handles ProtocolError and surfaces data payload', () => {
    const error = new ProtocolError(
      ProtocolErrorCode.InternalError,
      'Validation failed',
      {
        issues: ['field required'],
      }
    );
    const result = handleToolError(error, 'https://example.com');
    const parsed = parseToolPayload(result);
    assert.equal(parsed['error'], 'Validation failed');
    assert.equal(parsed['statusCode'], -32603);
    assert.deepEqual(parsed['data'], { issues: ['field required'] });
  });

  it('handles ProtocolError with clean message (no SDK prefix)', () => {
    const error = new ProtocolError(
      ProtocolErrorCode.InternalError,
      'Output validation failed'
    );
    error.message = 'Output validation failed';
    const result = handleToolError(error, 'https://example.com');
    const parsed = parseToolPayload(result);
    assert.equal(parsed['error'], 'Output validation failed');
    assert.equal(parsed['statusCode'], -32603);
  });
});
