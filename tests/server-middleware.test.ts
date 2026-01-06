import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  attachBaseMiddleware,
  buildCorsOptions,
} from '../dist/http/server-middleware.js';

function captureMiddleware() {
  const uses: unknown[][] = [];
  const routes: Record<string, (req: unknown, res: unknown) => void> = {};
  const app = {
    use: (...args: unknown[]) => {
      uses.push(args);
    },
    get: (path: string, handler: (req: unknown, res: unknown) => void) => {
      routes[path] = handler;
    },
  };
  const jsonParser = () => undefined;
  const rateLimit = () => undefined;
  const auth = () => undefined;
  const cors = () => undefined;

  attachBaseMiddleware(app as never, jsonParser, rateLimit, auth, cors);

  return { uses, routes };
}

describe('buildCorsOptions', () => {
  it('reads allowed origins and allow-all flag', () => {
    const originalOrigins = process.env.ALLOWED_ORIGINS;
    const originalAllowAll = process.env.CORS_ALLOW_ALL;

    process.env.ALLOWED_ORIGINS = 'https://a.test, https://b.test';
    process.env.CORS_ALLOW_ALL = 'true';

    const options = buildCorsOptions();
    assert.deepEqual(options.allowedOrigins, [
      'https://a.test',
      'https://b.test',
    ]);
    assert.equal(options.allowAllOrigins, true);

    process.env.ALLOWED_ORIGINS = originalOrigins;
    process.env.CORS_ALLOW_ALL = originalAllowAll;
  });
});

describe('createJsonParseErrorHandler', () => {
  it('returns JSON-RPC parse error for invalid JSON', () => {
    const { uses } = captureMiddleware();
    const handler = uses[3][0] as (
      err: Error,
      _req: unknown,
      res: {
        status: (code: number) => unknown;
        json: (payload: unknown) => void;
      },
      next: () => void
    ) => void;
    const err = new SyntaxError('bad json') as Error & { body?: string };
    err.body = '{}';

    let statusCode: number | undefined;
    let jsonBody: unknown;
    const res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: (payload: unknown) => {
        jsonBody = payload;
      },
    };
    let nextCalled = 0;
    const next = () => {
      nextCalled += 1;
    };

    handler(err, {} as never, res as never, next);

    assert.equal(statusCode, 400);
    assert.equal(typeof (jsonBody as { jsonrpc?: string }).jsonrpc, 'string');
    assert.equal((jsonBody as { jsonrpc?: string }).jsonrpc, '2.0');
    assert.equal((jsonBody as { id?: unknown }).id, null);
    assert.equal(nextCalled, 0);
  });

  it('delegates to next for non-parse errors', () => {
    const { uses } = captureMiddleware();
    const handler = uses[3][0] as (
      err: Error,
      _req: unknown,
      res: { status: () => unknown; json: () => unknown },
      next: () => void
    ) => void;
    const res = { status: () => res, json: () => res };
    let nextCalled = 0;
    const next = () => {
      nextCalled += 1;
    };

    handler(new Error('other'), {} as never, res as never, next);

    assert.equal(nextCalled, 1);
  });
});

describe('createContextMiddleware', () => {
  it('invokes next handler', () => {
    const { uses } = captureMiddleware();
    const middleware = uses[2][0] as (
      req: { headers?: Record<string, string> },
      _res: unknown,
      next: () => void
    ) => void;
    let nextCalled = 0;
    const next = () => {
      nextCalled += 1;
    };

    middleware(
      { headers: { 'mcp-session-id': 'session-1' } } as never,
      {} as never,
      next
    );

    assert.equal(nextCalled, 1);
  });
});

describe('registerHealthRoute', () => {
  it('registers /health and responds with status', () => {
    const { routes } = captureMiddleware();

    assert.equal(typeof routes['/health'], 'function');

    let jsonBody: unknown;
    const res = { json: (payload: unknown) => (jsonBody = payload) };
    routes['/health']({}, res);

    assert.equal((jsonBody as { status?: string }).status, 'healthy');
  });
});

describe('attachBaseMiddleware', () => {
  it('registers middleware in expected order', () => {
    const { uses } = captureMiddleware();
    assert.equal(uses.length, 7);
  });
});
