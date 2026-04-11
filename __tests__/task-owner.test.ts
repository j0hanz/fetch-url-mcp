import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { tryReadToolErrorMessage } from '../src/lib/error/index.js';
import {
  buildAuthenticatedOwnerKey,
  isServerResult,
  resolveOwnerKeyFromContext,
} from '../src/tasks/manager.js';

// ── resolveOwnerKeyFromContext (ServerContext-native) ────────────────

describe('resolveOwnerKeyFromContext', () => {
  const baseCtx = {
    mcpReq: {
      signal: new AbortController().signal,
      id: 'r-1',
      notify: async () => {},
      log: () => {},
      _meta: {},
    },
  };

  it('returns auth-based key when authInfo is present', () => {
    const ctx = {
      ...baseCtx,
      sessionId: 'sess-1',
      http: { authInfo: { clientId: 'c-1', token: 'tok-1', scopes: [] } },
    };
    const key = resolveOwnerKeyFromContext(ctx as never);
    assert.ok(key.startsWith('auth:'));
  });

  it('returns session-based key when auth is absent', () => {
    const ctx = { ...baseCtx, sessionId: 'sess-1' };
    const key = resolveOwnerKeyFromContext(ctx as never);
    assert.equal(key, 'session:sess-1');
  });

  it('returns "default" when no auth or session', () => {
    const ctx = { ...baseCtx };
    const key = resolveOwnerKeyFromContext(ctx as never);
    assert.equal(key, 'default');
  });

  it('matches buildAuthenticatedOwnerKey for same auth identity', () => {
    const ctx = {
      ...baseCtx,
      sessionId: 'sess-1',
      http: { authInfo: { clientId: 'c-1', token: 'tok-1', scopes: [] } },
    };
    const fromCtx = resolveOwnerKeyFromContext(ctx as never);
    const fromBuild = buildAuthenticatedOwnerKey({
      clientId: 'c-1',
      token: 'tok-1',
    });
    assert.equal(fromCtx, fromBuild);
  });

  it('uses stable subject from extra claims', () => {
    const ctx = {
      ...baseCtx,
      http: {
        authInfo: {
          clientId: 'oauth',
          token: 'alpha',
          scopes: [],
          extra: { sub: 'user-99' },
        },
      },
    };
    const a = resolveOwnerKeyFromContext(ctx as never);
    ctx.http.authInfo.token = 'beta';
    const b = resolveOwnerKeyFromContext(ctx as never);
    assert.equal(a, b);
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
