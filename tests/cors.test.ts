import { describe, expect, it, vi } from 'vitest';

import { createCorsMiddleware } from '../src/http/cors.js';

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
      vary: vi.fn(),
      sendStatus: vi.fn(),
    };
    const req = {
      headers: { origin: 'https://client.test' },
      method: 'POST',
    };
    const next = vi.fn();

    middleware(req as never, res as never, next);

    expect(headers['Access-Control-Expose-Headers']).toBe('mcp-session-id');
    expect(next).toHaveBeenCalledOnce();
  });
});
