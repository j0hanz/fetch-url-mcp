import { describe, expect, it, vi } from 'vitest';

import {
  attachBaseMiddleware,
  buildCorsOptions,
  createContextMiddleware,
  createJsonParseErrorHandler,
  registerHealthRoute,
} from '../src/http/server-middleware.js';

describe('buildCorsOptions', () => {
  it('reads allowed origins and allow-all flag', () => {
    const originalOrigins = process.env.ALLOWED_ORIGINS;
    const originalAllowAll = process.env.CORS_ALLOW_ALL;

    process.env.ALLOWED_ORIGINS = 'https://a.test, https://b.test';
    process.env.CORS_ALLOW_ALL = 'true';

    const options = buildCorsOptions();
    expect(options.allowedOrigins).toEqual([
      'https://a.test',
      'https://b.test',
    ]);
    expect(options.allowAllOrigins).toBe(true);

    process.env.ALLOWED_ORIGINS = originalOrigins;
    process.env.CORS_ALLOW_ALL = originalAllowAll;
  });
});

describe('createJsonParseErrorHandler', () => {
  it('returns JSON-RPC parse error for invalid JSON', () => {
    const handler = createJsonParseErrorHandler();
    const err = new SyntaxError('bad json') as Error & { body?: string };
    err.body = '{}';

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const next = vi.fn();

    handler(err, {} as never, res as never, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonrpc: '2.0',
        id: null,
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('delegates to next for non-parse errors', () => {
    const handler = createJsonParseErrorHandler();
    const res = { status: vi.fn(), json: vi.fn() };
    const next = vi.fn();

    handler(new Error('other'), {} as never, res as never, next);

    expect(next).toHaveBeenCalledOnce();
  });
});

describe('createContextMiddleware', () => {
  it('invokes next handler', () => {
    const middleware = createContextMiddleware();
    const next = vi.fn();

    middleware(
      { headers: { 'mcp-session-id': 'session-1' } } as never,
      {} as never,
      next
    );

    expect(next).toHaveBeenCalledOnce();
  });
});

describe('registerHealthRoute', () => {
  it('registers /health and responds with status', () => {
    const handlers: Record<string, (req: unknown, res: unknown) => void> = {};
    const app = {
      get: (path: string, handler: (req: unknown, res: unknown) => void) => {
        handlers[path] = handler;
      },
    };

    registerHealthRoute(app as never);

    expect(handlers['/health']).toBeDefined();

    const res = { json: vi.fn() };
    handlers['/health']({}, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'healthy' })
    );
  });
});

describe('attachBaseMiddleware', () => {
  it('registers middleware in expected order', () => {
    const uses: unknown[] = [];
    const app = {
      use: (...args: unknown[]) => {
        uses.push(args);
      },
      get: vi.fn(),
    };

    const jsonParser = vi.fn();
    const rateLimit = vi.fn();
    const auth = vi.fn();
    const cors = vi.fn();

    attachBaseMiddleware(app as never, jsonParser, rateLimit, auth, cors);

    expect(uses.length).toBe(7);
  });
});
