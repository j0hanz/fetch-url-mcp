import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createCorsMiddleware } from '../dist/http/cors.js';

describe('createCorsMiddleware', () => {
  it('exposes mcp-session-id for allowed origins', () => {
    const middleware = createCorsMiddleware({
      allowedOrigins: ['https://client.test'],
      allowAllOrigins: false,
    });

    const headers: Record<string, string> = {};
    const res = {
      header: (key: string, value: string) => {
        headers[key] = value;
        return res;
      },
      vary: () => res,
      sendStatus: () => res,
    };
    const req = {
      headers: { origin: 'https://client.test' },
      method: 'POST',
    };
    let nextCalled = 0;
    const next = () => {
      nextCalled += 1;
    };

    middleware(req as never, res as never, next);

    assert.equal(headers['Access-Control-Expose-Headers'], 'mcp-session-id');
    assert.equal(nextCalled, 1);
  });
});
