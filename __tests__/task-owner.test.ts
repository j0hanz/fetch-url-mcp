import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildToolHandlerExtra,
  compact,
  isServerResult,
  parseHandlerExtra,
  resolveTaskOwnerKey,
  resolveToolCallContext,
  tryReadToolStructuredError,
  withRequestContextIfMissing,
} from '../src/tasks/owner.js';

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

  it('extracts sessionId from requestInfo.headers', () => {
    const result = parseHandlerExtra({
      requestInfo: {
        headers: { 'mcp-session-id': 'sess-from-header' },
      },
    });
    assert.equal(result?.sessionId, 'sess-from-header');
  });

  it('extracts sessionId from x-mcp-session-id header', () => {
    const result = parseHandlerExtra({
      requestInfo: {
        headers: { 'x-mcp-session-id': 'sess-x' },
      },
    });
    assert.equal(result?.sessionId, 'sess-x');
  });

  it('extracts signal when it is an AbortSignal', () => {
    const ac = new AbortController();
    const result = parseHandlerExtra({ signal: ac.signal });
    assert.ok(result?.signal instanceof AbortSignal);
  });

  it('extracts string requestId', () => {
    const result = parseHandlerExtra({ requestId: 'req-1' });
    assert.equal(result?.requestId, 'req-1');
  });

  it('extracts numeric requestId', () => {
    const result = parseHandlerExtra({ requestId: 42 });
    assert.equal(result?.requestId, 42);
  });

  it('normalizes sendNotification function', () => {
    const fn = async () => {};
    const result = parseHandlerExtra({ sendNotification: fn });
    assert.equal(typeof result?.sendNotification, 'function');
  });

  it('ignores non-function sendNotification', () => {
    const result = parseHandlerExtra({ sendNotification: 'not-a-fn' });
    assert.equal(result?.sendNotification, undefined);
  });

  it('extracts authInfo clientId', () => {
    const result = parseHandlerExtra({
      authInfo: { clientId: 'client-1' },
    });
    assert.equal(result?.authInfo?.clientId, 'client-1');
  });

  it('ignores invalid authInfo', () => {
    const result = parseHandlerExtra({ authInfo: 'not-object' });
    assert.equal(result?.authInfo, undefined);
  });
});

// ── resolveTaskOwnerKey ─────────────────────────────────────────────

describe('resolveTaskOwnerKey', () => {
  it('returns "default" when no extra is provided', () => {
    assert.equal(resolveTaskOwnerKey(), 'default');
    assert.equal(resolveTaskOwnerKey(undefined), 'default');
  });

  it('returns session-based key when sessionId is present', () => {
    assert.equal(
      resolveTaskOwnerKey({ sessionId: 'sess-1' }),
      'session:sess-1'
    );
  });

  it('returns client-based key when clientId is present', () => {
    assert.equal(
      resolveTaskOwnerKey({ authInfo: { clientId: 'c-1' } }),
      'client:c-1'
    );
  });

  it('returns token-based key when only token is present', () => {
    const key = resolveTaskOwnerKey({ authInfo: { token: 'secret' } });
    assert.ok(key.startsWith('token:'));
    assert.ok(key.length > 'token:'.length);
  });

  it('is deterministic for the same token', () => {
    const a = resolveTaskOwnerKey({ authInfo: { token: 'same' } });
    const b = resolveTaskOwnerKey({ authInfo: { token: 'same' } });
    assert.equal(a, b);
  });

  it('differs for different tokens', () => {
    const a = resolveTaskOwnerKey({ authInfo: { token: 'alpha' } });
    const b = resolveTaskOwnerKey({ authInfo: { token: 'beta' } });
    assert.notEqual(a, b);
  });

  it('prefers sessionId over authInfo', () => {
    const key = resolveTaskOwnerKey({
      sessionId: 'sess-1',
      authInfo: { clientId: 'c-1' },
    });
    assert.equal(key, 'session:sess-1');
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

// ── buildToolHandlerExtra ───────────────────────────────────────────

describe('buildToolHandlerExtra', () => {
  it('builds extra from context', () => {
    const ac = new AbortController();
    const extra = buildToolHandlerExtra({
      ownerKey: 'session:x',
      signal: ac.signal,
      requestId: 'req-1',
    });
    assert.ok(extra.signal instanceof AbortSignal);
    assert.equal(extra.requestId, 'req-1');
  });

  it('omits undefined fields', () => {
    const extra = buildToolHandlerExtra({ ownerKey: 'default' });
    assert.equal('signal' in extra, false);
    assert.equal('requestId' in extra, false);
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

// ── tryReadToolStructuredError ──────────────────────────────────────

describe('tryReadToolStructuredError', () => {
  it('extracts error string from valid error shape', () => {
    const value = {
      content: [
        { type: 'text', text: JSON.stringify({ error: 'Something failed' }) },
      ],
    };
    assert.equal(tryReadToolStructuredError(value), 'Something failed');
  });

  it('returns undefined for non-object input', () => {
    assert.equal(tryReadToolStructuredError(null), undefined);
    assert.equal(tryReadToolStructuredError('str'), undefined);
  });

  it('returns undefined for empty content', () => {
    assert.equal(tryReadToolStructuredError({ content: [] }), undefined);
  });

  it('returns undefined for non-JSON text', () => {
    const value = {
      content: [{ type: 'text', text: 'not json' }],
    };
    assert.equal(tryReadToolStructuredError(value), undefined);
  });

  it('returns undefined when error key is missing', () => {
    const value = {
      content: [
        { type: 'text', text: JSON.stringify({ message: 'no error key' }) },
      ],
    };
    assert.equal(tryReadToolStructuredError(value), undefined);
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
    await wrapped({}, { requestId: 'req-99' });
    assert.ok(receivedExtra);
  });
});
