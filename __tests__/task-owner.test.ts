import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { tryReadToolErrorMessage } from '../src/lib/error/index.js';
import {
  compact,
  isServerResult,
  parseHandlerExtra,
  resolveTaskOwnerKey,
  resolveToolCallContext,
  withRequestContextIfMissing,
} from '../src/tasks/manager.js';

// ── compact ─────────────────────────────────────────────────────────

describe('compact', () => {
  it('strips undefined values', () => {
    const result = compact({ a: 1, b: undefined, c: 'x' });
    assert.equal(result.a, 1);
    assert.equal(result.c, 'x');
    assert.equal('b' in result, false);
  });

  it('returns empty object for all-undefined input', () => {
    const result = compact({ a: undefined, b: undefined });
    assert.deepEqual(result, {});
  });

  it('keeps null values', () => {
    const result = compact({ a: null });
    assert.equal(result.a, null);
  });
});

// ── parseHandlerExtra ───────────────────────────────────────────────

describe('parseHandlerExtra', () => {
  it('returns undefined for non-object input', () => {
    assert.equal(parseHandlerExtra(null), undefined);
    assert.equal(parseHandlerExtra('string'), undefined);
    assert.equal(parseHandlerExtra(42), undefined);
  });

  it('extracts sessionId from top-level property', () => {
    const result = parseHandlerExtra({ sessionId: 'sess-1' });
    assert.equal(result?.sessionId, 'sess-1');
  });

  it('extracts sessionId from http.req.headers', () => {
    const result = parseHandlerExtra({
      http: {
        req: new Request('https://example.test/mcp', {
          headers: { 'mcp-session-id': 'sess-from-header' },
        }),
      },
    });
    assert.equal(result?.sessionId, 'sess-from-header');
  });

  it('extracts sessionId from x-mcp-session-id header', () => {
    const result = parseHandlerExtra({
      http: {
        req: new Request('https://example.test/mcp', {
          headers: { 'x-mcp-session-id': 'sess-x' },
        }),
      },
    });
    assert.equal(result?.sessionId, 'sess-x');
  });

  it('extracts signal when it is an AbortSignal', () => {
    const ac = new AbortController();
    const result = parseHandlerExtra({ mcpReq: { signal: ac.signal } });
    assert.ok(result?.signal instanceof AbortSignal);
  });

  it('extracts string requestId', () => {
    const result = parseHandlerExtra({ mcpReq: { id: 'req-1' } });
    assert.equal(result?.requestId, 'req-1');
  });

  it('extracts numeric requestId', () => {
    const result = parseHandlerExtra({ mcpReq: { id: 42 } });
    assert.equal(result?.requestId, 42);
  });

  it('normalizes sendNotification function', () => {
    const fn = async () => {};
    const result = parseHandlerExtra({ mcpReq: { notify: fn } });
    assert.equal(typeof result?.sendNotification, 'function');
  });

  it('ignores non-function sendNotification', () => {
    const result = parseHandlerExtra({ mcpReq: { notify: 'not-a-fn' } });
    assert.equal(result?.sendNotification, undefined);
  });

  it('extracts authInfo clientId', () => {
    const result = parseHandlerExtra({
      http: { authInfo: { clientId: 'client-1' } },
    });
    assert.equal(result?.authInfo?.clientId, 'client-1');
  });

  it('preserves authInfo extra claims', () => {
    const result = parseHandlerExtra({
      http: { authInfo: { clientId: 'client-1', extra: { sub: 'user-123' } } },
    });
    assert.deepEqual(result?.authInfo?.extra, { sub: 'user-123' });
  });

  it('ignores invalid authInfo', () => {
    const result = parseHandlerExtra({ http: { authInfo: 'not-object' } });
    assert.equal(result?.authInfo, undefined);
  });
});

// ── resolveTaskOwnerKey ─────────────────────────────────────────────

describe('resolveTaskOwnerKey', () => {
  it('returns "default" when no extra is provided', () => {
    assert.equal(resolveTaskOwnerKey(), 'default');
    assert.equal(resolveTaskOwnerKey(undefined), 'default');
  });

  it('returns session-based key when auth context is absent', () => {
    assert.equal(
      resolveTaskOwnerKey({ sessionId: 'sess-1' }),
      'session:sess-1'
    );
  });

  it('returns auth-based key when clientId is present', () => {
    const key = resolveTaskOwnerKey({ authInfo: { clientId: 'c-1' } });
    assert.ok(key.startsWith('auth:'));
  });

  it('returns auth-based key when only token is present', () => {
    const key = resolveTaskOwnerKey({ authInfo: { token: 'secret' } });
    assert.ok(key.startsWith('auth:'));
    assert.ok(key.length > 'auth:'.length);
  });

  it('is deterministic for the same auth context', () => {
    const a = resolveTaskOwnerKey({
      authInfo: { clientId: 'client-a', token: 'same' },
    });
    const b = resolveTaskOwnerKey({
      authInfo: { clientId: 'client-a', token: 'same' },
    });
    assert.equal(a, b);
  });

  it('differs for different tokens even when clientId is shared', () => {
    const a = resolveTaskOwnerKey({
      authInfo: { clientId: 'static-token', token: 'alpha' },
    });
    const b = resolveTaskOwnerKey({
      authInfo: { clientId: 'static-token', token: 'beta' },
    });
    assert.notEqual(a, b);
  });

  it('uses a stable subject when available across token rotation', () => {
    const a = resolveTaskOwnerKey({
      authInfo: {
        clientId: 'oauth-client',
        token: 'alpha',
        extra: { sub: 'user-123' },
      },
    });
    const b = resolveTaskOwnerKey({
      authInfo: {
        clientId: 'oauth-client',
        token: 'beta',
        extra: { sub: 'user-123' },
      },
    });
    assert.equal(a, b);
  });

  it('prefers auth context over sessionId', () => {
    const key = resolveTaskOwnerKey({
      sessionId: 'sess-1',
      authInfo: { clientId: 'c-1', token: 'tok-1' },
    });
    assert.equal(
      key,
      resolveTaskOwnerKey({ authInfo: { clientId: 'c-1', token: 'tok-1' } })
    );
  });
});

// ── resolveToolCallContext ───────────────────────────────────────────

describe('resolveToolCallContext', () => {
  it('returns context with ownerKey', () => {
    const ctx = resolveToolCallContext({ sessionId: 'sess-1' });
    assert.equal(ctx.ownerKey, 'session:sess-1');
    assert.equal(ctx.sessionId, 'sess-1');
  });

  it('returns default ownerKey when no extra', () => {
    const ctx = resolveToolCallContext();
    assert.equal(ctx.ownerKey, 'default');
  });
});

// ── isServerResult ──────────────────────────────────────────────────

describe('isServerResult', () => {
  it('returns true for valid result shape', () => {
    assert.equal(
      isServerResult({ content: [{ type: 'text', text: 'ok' }] }),
      true
    );
  });

  it('returns false for non-object', () => {
    assert.equal(isServerResult(null), false);
    assert.equal(isServerResult('string'), false);
  });

  it('returns false when content is not an array', () => {
    assert.equal(isServerResult({ content: 'not-array' }), false);
  });
});

// ── tryReadToolErrorMessage ─────────────────────────────────────────

describe('tryReadToolErrorMessage', () => {
  it('extracts error string from structuredContent first', () => {
    const value = {
      structuredContent: {
        error: 'Structured failure',
        url: 'https://example.com',
        code: 'HTTP_404',
        statusCode: 404,
      },
      content: [
        { type: 'text', text: JSON.stringify({ error: 'Legacy failure' }) },
      ],
    };
    assert.equal(tryReadToolErrorMessage(value), 'Structured failure');
  });

  it('extracts error string from valid error shape', () => {
    const value = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: 'Something failed',
            url: 'https://example.com',
          }),
        },
      ],
    };
    assert.equal(tryReadToolErrorMessage(value), 'Something failed');
  });

  it('returns undefined for non-object input', () => {
    assert.equal(tryReadToolErrorMessage(null), undefined);
    assert.equal(tryReadToolErrorMessage('str'), undefined);
  });

  it('returns undefined for empty content', () => {
    assert.equal(tryReadToolErrorMessage({ content: [] }), undefined);
  });

  it('returns undefined for non-JSON text', () => {
    const value = {
      content: [{ type: 'text', text: 'not json' }],
    };
    assert.equal(tryReadToolErrorMessage(value), undefined);
  });

  it('returns undefined when error key is missing', () => {
    const value = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            message: 'no error key',
            url: 'https://example.com',
          }),
        },
      ],
    };
    assert.equal(tryReadToolErrorMessage(value), undefined);
  });
});

// ── withRequestContextIfMissing ─────────────────────────────────────

describe('withRequestContextIfMissing', () => {
  it('wraps handler and calls it', async () => {
    let called = false;
    const handler = async (params: { x: number }) => {
      called = true;
      return params.x * 2;
    };
    const wrapped = withRequestContextIfMissing(handler);
    const result = await wrapped({ x: 5 });
    assert.equal(result, 10);
    assert.equal(called, true);
  });

  it('forwards extra to handler', async () => {
    let receivedExtra: unknown;
    const handler = async (_params: unknown, extra?: unknown) => {
      receivedExtra = extra;
      return 'ok';
    };
    const wrapped = withRequestContextIfMissing(handler);
    await wrapped({}, { mcpReq: { id: 'req-99' } });
    assert.ok(receivedExtra);
  });
});
