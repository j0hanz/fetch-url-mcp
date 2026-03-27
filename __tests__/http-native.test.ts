import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

const TEST_API_KEY = 'test-api-key';
const originalApiKey = process.env.API_KEY;
const originalPort = process.env.PORT;

process.env.API_KEY = TEST_API_KEY;
process.env.PORT = '0';

const { startHttpServer } = await import('../dist/http/native.js');
const {
  createCacheKey,
  set: setCacheEntry,
  toCacheScopeId,
} = await import('../dist/lib/cache.js');
const { stringifyCachedPayload } = await import('../dist/schemas.js');

if (originalApiKey === undefined) {
  delete process.env.API_KEY;
} else {
  process.env.API_KEY = originalApiKey;
}

if (originalPort === undefined) {
  delete process.env.PORT;
} else {
  process.env.PORT = originalPort;
}

type HttpServerHandle = Awaited<ReturnType<typeof startHttpServer>>;

function createInitializeRequestBody(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
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

function createSessionHeaders(
  sessionId: string,
  requestId: number | string
): HeadersInit {
  return {
    ...createAuthHeaders('application/json, text/event-stream'),
    'mcp-protocol-version': '2025-11-25',
    'mcp-session-id': sessionId,
    'x-request-id': String(requestId),
  };
}

function createDownloadHeaders(sessionId?: string): HeadersInit {
  return {
    accept: 'text/markdown',
    'x-api-key': TEST_API_KEY,
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  };
}

async function parseMcpResponse<T>(response: Response): Promise<T> {
  const body = await response.text();
  const trimmed = body.trim();

  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed) as T;
  }

  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'));
  const jsonText = dataLines
    .map((line) => line.slice(5).trim())
    .find((line) => line.startsWith('{'));

  assert.ok(
    jsonText,
    `Expected JSON or SSE-framed JSON response, got: ${trimmed}`
  );
  return JSON.parse(jsonText) as T;
}

async function initializeSession(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      ...createAuthHeaders('application/json, text/event-stream'),
      'mcp-protocol-version': '2025-11-25',
    },
    body: createInitializeRequestBody(),
  });

  assert.equal(response.status, 200);
  const sessionId = response.headers.get('mcp-session-id');
  assert.ok(sessionId);

  const initializedResponse = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: createSessionHeaders(sessionId, `init-${sessionId}`),
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    }),
  });

  assert.equal(initializedResponse.status, 202);

  return sessionId;
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

  it('keeps cache resources scoped to the owning MCP session', async () => {
    const sessionA = await initializeSession(baseUrl);
    const sessionB = await initializeSession(baseUrl);
    const namespace = `http-cache-${Date.now()}`;
    const cacheKeyA = createCacheKey(namespace, 'https://example.com/a');
    const cacheKeyB = createCacheKey(namespace, 'https://example.com/b');

    assert.ok(cacheKeyA);
    assert.ok(cacheKeyB);

    setCacheEntry(
      cacheKeyA,
      stringifyCachedPayload({ markdown: '# Session A' }),
      {
        url: 'https://example.com/a',
        title: 'Session A',
        scopeIds: [toCacheScopeId(sessionA)],
      }
    );
    setCacheEntry(
      cacheKeyB,
      stringifyCachedPayload({ markdown: '# Session B' }),
      {
        url: 'https://example.com/b',
        title: 'Session B',
        scopeIds: [toCacheScopeId(sessionB)],
      }
    );

    const listResponseA = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: createSessionHeaders(sessionA, 2),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/list',
        params: {},
      }),
    });
    const listPayloadA = (await parseMcpResponse(listResponseA)) as {
      result?: { resources?: Array<{ uri: string }> };
    };

    assert.equal(listResponseA.status, 200);
    const urisA = (listPayloadA.result?.resources ?? []).map(
      (resource) => resource.uri
    );
    assert.ok(
      urisA.includes(`internal://cache/${namespace}/${cacheKeyA.split(':')[1]}`)
    );
    assert.ok(
      !urisA.includes(
        `internal://cache/${namespace}/${cacheKeyB.split(':')[1]}`
      )
    );

    const readResponseB = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: createSessionHeaders(sessionB, 3),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'resources/read',
        params: {
          uri: `internal://cache/${namespace}/${cacheKeyA.split(':')[1]}`,
        },
      }),
    });
    const readPayloadB = (await parseMcpResponse(readResponseB)) as {
      error?: { code?: number };
    };

    assert.equal(readResponseB.status, 200);
    assert.equal(readPayloadB.error?.code, -32002);
  });

  it('requires the owning MCP session for cached downloads', async () => {
    const sessionA = await initializeSession(baseUrl);
    const sessionB = await initializeSession(baseUrl);
    const namespace = 'markdown';
    const cacheKey = createCacheKey(
      namespace,
      `https://example.com/download-${Date.now()}`
    );

    assert.ok(cacheKey);

    setCacheEntry(
      cacheKey,
      stringifyCachedPayload({ markdown: '# Session A Download' }),
      {
        url: 'https://example.com/download',
        title: 'Session A Download',
        scopeIds: [toCacheScopeId(sessionA)],
      }
    );

    const hash = cacheKey.split(':')[1];
    assert.ok(hash);

    const missingSessionResponse = await fetch(
      `${baseUrl}/mcp/downloads/${namespace}/${hash}`,
      {
        headers: createDownloadHeaders(),
      }
    );

    assert.equal(missingSessionResponse.status, 400);
    assert.deepEqual(await missingSessionResponse.json(), {
      error: 'Missing MCP-Session-ID header',
    });

    const wrongSessionResponse = await fetch(
      `${baseUrl}/mcp/downloads/${namespace}/${hash}`,
      {
        headers: createDownloadHeaders(sessionB),
      }
    );

    assert.equal(wrongSessionResponse.status, 404);
    assert.deepEqual(await wrongSessionResponse.json(), {
      error: 'Not found or expired',
      code: 'NOT_FOUND',
    });

    const ownerResponse = await fetch(
      `${baseUrl}/mcp/downloads/${namespace}/${hash}`,
      {
        headers: createDownloadHeaders(sessionA),
      }
    );

    assert.equal(ownerResponse.status, 200);
    assert.equal(
      ownerResponse.headers.get('content-type'),
      'text/markdown; charset=utf-8'
    );
    assert.equal(await ownerResponse.text(), '# Session A Download');
  });
});
