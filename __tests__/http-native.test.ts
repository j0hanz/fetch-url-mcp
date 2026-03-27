import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

const TEST_API_KEY = 'test-api-key';
const originalApiKey = process.env['API_KEY'];
const originalPort = process.env['PORT'];

process.env['API_KEY'] = TEST_API_KEY;
process.env['PORT'] = '0';

const { startHttpServer } = await import('../src/http/native.js');

if (originalApiKey === undefined) {
  delete process.env['API_KEY'];
} else {
  process.env['API_KEY'] = originalApiKey;
}

if (originalPort === undefined) {
  delete process.env['PORT'];
} else {
  process.env['PORT'] = originalPort;
}

type HttpServerHandle = Awaited<ReturnType<typeof startHttpServer>>;

function createInitializeRequestBody(): string {
  return createInitializeRequestBodyForVersion('2025-11-25');
}

function createInitializeRequestBodyForVersion(
  protocolVersion: string
): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: {
        name: 'http-native-test',
        version: '1.0.0',
      },
    },
  });
}

function createAuthHeaders(accept: string): HeadersInit {
  return {
    accept,
    'content-type': 'application/json',
    'x-api-key': TEST_API_KEY,
  };
}

function createSessionHeaders(options?: {
  accept?: string;
  sessionId?: string;
  protocolVersion?: string;
}): HeadersInit {
  const headers: Record<string, string> = {
    accept: options?.accept ?? 'application/json, text/event-stream',
    'content-type': 'application/json',
    'x-api-key': TEST_API_KEY,
  };

  if (options?.sessionId) {
    headers['mcp-session-id'] = options.sessionId;
  }

  if (options?.protocolVersion) {
    headers['mcp-protocol-version'] = options.protocolVersion;
  }

  return headers;
}

describe('HTTP native gateway routing', () => {
  let server: HttpServerHandle;
  let baseUrl: string;

  before(async () => {
    server = await startHttpServer();
    baseUrl = `http://${server.host}:${server.port}`;
  });

  after(async () => {
    await server.shutdown('test');
  });

  it('returns 406 for POST /mcp when Accept omits text/event-stream', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: createAuthHeaders('application/json'),
      body: createInitializeRequestBody(),
    });

    assert.equal(response.status, 406);
    assert.deepEqual(await response.json(), {
      error: 'Not Acceptable: expected application/json and text/event-stream',
    });
  });

  it('routes POST /mcp/ through the MCP handler', async () => {
    const response = await fetch(`${baseUrl}/mcp/`, {
      method: 'POST',
      headers: createAuthHeaders('application/json'),
      body: createInitializeRequestBody(),
    });

    assert.equal(response.status, 406);
    assert.deepEqual(await response.json(), {
      error: 'Not Acceptable: expected application/json and text/event-stream',
    });
  });

  it('treats invalid JSON on /mcp/ as an MCP parse error', async () => {
    const response = await fetch(`${baseUrl}/mcp/`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: '{',
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      jsonrpc: '2.0',
      error: {
        code: -32700,
        message: 'Parse error',
      },
      id: null,
    });
  });

  it('accepts initialize without MCP-Protocol-Version and negotiates a supported version', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: createSessionHeaders(),
      body: createInitializeRequestBodyForVersion('2099-01-01'),
    });

    assert.equal(response.status, 200);
    assert.ok(response.headers.get('mcp-session-id'));
    assert.equal(response.headers.get('content-type'), 'text/event-stream');

    const body = await response.text();
    assert.match(body, /"protocolVersion":"2025-11-25"/);
  });

  it('rejects pre-initialized session requests other than ping', async () => {
    const initializeResponse = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: createSessionHeaders(),
      body: createInitializeRequestBody(),
    });

    assert.equal(initializeResponse.status, 200);
    const sessionId = initializeResponse.headers.get('mcp-session-id');
    assert.ok(sessionId);
    await initializeResponse.text();

    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: createSessionHeaders({
        sessionId,
        protocolVersion: '2025-11-25',
      }),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      jsonrpc: '2.0',
      error: {
        code: -32600,
        message: 'Session not initialized',
      },
      id: 2,
    });
  });

  it('requires MCP-Protocol-Version after initialization completes', async () => {
    const initializeResponse = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: createSessionHeaders(),
      body: createInitializeRequestBody(),
    });

    assert.equal(initializeResponse.status, 200);
    const sessionId = initializeResponse.headers.get('mcp-session-id');
    assert.ok(sessionId);
    await initializeResponse.text();

    const initializedResponse = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: createSessionHeaders({
        sessionId,
        protocolVersion: '2025-11-25',
      }),
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });

    assert.equal(initializedResponse.status, 202);

    const pingResponse = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: createSessionHeaders({ sessionId }),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'ping',
      }),
    });

    assert.equal(pingResponse.status, 400);
    assert.deepEqual(await pingResponse.json(), {
      jsonrpc: '2.0',
      error: {
        code: -32600,
        message: 'Missing MCP-Protocol-Version header',
      },
      id: null,
    });
  });
});
