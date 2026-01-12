import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveTransportForPost } from '../dist/http.js';
import { createSessionStore } from '../dist/http.js';

describe('mcp-session routing', () => {
  it('returns 404 for POST with unknown mcp-session-id', async () => {
    const sessionStore = createSessionStore(60_000);
    const options = { sessionStore, maxSessions: 10 };

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

    const transport = await resolveTransportForPost({
      res: res as never,
      body: { jsonrpc: '2.0', method: 'tools/list', id: 1 } as never,
      sessionId: 'bogus-session-id',
      options: options as never,
    });

    assert.equal(transport, null);
    assert.equal(statusCode, 404);
    assert.equal((jsonBody as { jsonrpc?: string }).jsonrpc, '2.0');
    assert.equal((jsonBody as { id?: unknown }).id, 1);
  });

  it('echoes JSON-RPC id when rejecting POST without session id', async () => {
    const sessionStore = createSessionStore(60_000);
    const options = { sessionStore, maxSessions: 10 };

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

    const transport = await resolveTransportForPost({
      res: res as never,
      body: { jsonrpc: '2.0', method: 'tools/list', id: 1 } as never,
      sessionId: undefined,
      options: options as never,
    });

    assert.equal(transport, null);
    assert.equal(statusCode, 400);
    assert.equal((jsonBody as { jsonrpc?: string }).jsonrpc, '2.0');
    assert.equal((jsonBody as { id?: unknown }).id, 1);
  });
});
