import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { attachBaseMiddleware } from '../dist/http/server-middleware.js';

type HeaderRequest = { headers?: Record<string, string> };
type JsonResponder = { json: (payload: unknown) => void };
type StatusJsonResponder = {
  status: (code: number) => StatusJsonResponder;
  json: (payload: unknown) => void;
};
type JsonParseErrorHandler = (
  err: Error,
  _req: unknown,
  res: StatusJsonResponder,
  next: () => void
) => void;
type ContextMiddleware = (
  req: HeaderRequest,
  _res: unknown,
  next: () => void
) => void;
type OriginValidationMiddleware = (
  req: HeaderRequest,
  res: StatusJsonResponder,
  next: () => void
) => void;
type HealthRouteHandler = (_req: unknown, res: JsonResponder) => void;

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
  const cors = () => undefined;

  attachBaseMiddleware(app as never, jsonParser, rateLimit, cors);

  return { uses, routes };
}

function createStatusJsonCapture() {
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

  return {
    res,
    getStatusCode: () => statusCode,
    getJsonBody: () => jsonBody,
  };
}

function createJsonCapture() {
  let jsonBody: unknown;
  const res = {
    json: (payload: unknown) => {
      jsonBody = payload;
    },
  };

  return { res, getJsonBody: () => jsonBody };
}

function createNextTracker() {
  let nextCalled = 0;
  const next = () => {
    nextCalled += 1;
  };

  return { next, getCalls: () => nextCalled };
}

describe('createJsonParseErrorHandler', () => {
  it('returns JSON-RPC parse error for invalid JSON', () => {
    const { uses } = captureMiddleware();
    const handler = uses[4][0] as JsonParseErrorHandler;
    const err = new SyntaxError('bad json') as Error & { body?: string };
    err.body = '{}';

    const { res, getStatusCode, getJsonBody } = createStatusJsonCapture();
    const { next, getCalls } = createNextTracker();

    handler(err, {} as never, res as never, next);

    const jsonBody = getJsonBody() as { id?: unknown; jsonrpc?: string };
    assert.equal(getStatusCode(), 400);
    assert.equal(jsonBody.jsonrpc, '2.0');
    assert.equal(jsonBody.id, null);
    assert.equal(getCalls(), 0);
  });

  it('delegates to next for non-parse errors', () => {
    const { uses } = captureMiddleware();
    const handler = uses[4][0] as JsonParseErrorHandler;
    const res = { status: () => res, json: () => res };
    const { next, getCalls } = createNextTracker();

    handler(new Error('other'), {} as never, res as never, next);

    assert.equal(getCalls(), 1);
  });
});

describe('createContextMiddleware', () => {
  it('invokes next handler', () => {
    const { uses } = captureMiddleware();
    const middleware = uses[3][0] as ContextMiddleware;
    const { next, getCalls } = createNextTracker();

    middleware(
      { headers: { 'mcp-session-id': 'session-1' } } as never,
      {} as never,
      next
    );

    assert.equal(getCalls(), 1);
  });
});

describe('registerHealthRoute', () => {
  it('registers /health and responds with status', () => {
    const { routes } = captureMiddleware();
    const handler = routes['/health'] as HealthRouteHandler;
    const { res, getJsonBody } = createJsonCapture();

    assert.equal(typeof handler, 'function');

    handler({} as never, res);

    assert.equal((getJsonBody() as { status?: string }).status, 'healthy');
  });
});

describe('createOriginValidationMiddleware', () => {
  it('rejects non-loopback origins when bound to loopback', () => {
    const { uses } = captureMiddleware();
    const middleware = uses[1][0] as OriginValidationMiddleware;
    const { res, getStatusCode, getJsonBody } = createStatusJsonCapture();
    const { next, getCalls } = createNextTracker();

    middleware(
      { headers: { origin: 'https://evil.example' } } as never,
      res as never,
      next
    );

    assert.equal(getStatusCode(), 403);
    assert.equal(
      (getJsonBody() as { code?: string }).code,
      'ORIGIN_NOT_ALLOWED'
    );
    assert.equal(getCalls(), 0);
  });

  it('allows loopback origins when bound to loopback', () => {
    const { uses } = captureMiddleware();
    const middleware = uses[1][0] as OriginValidationMiddleware;
    const { next, getCalls } = createNextTracker();

    middleware(
      { headers: { origin: 'http://127.0.0.1:3000' } } as never,
      {} as never,
      next
    );

    assert.equal(getCalls(), 1);
  });
});

describe('attachBaseMiddleware', () => {
  it('registers middleware in expected order', () => {
    const { uses } = captureMiddleware();
    assert.equal(uses.length, 7);
  });
});
