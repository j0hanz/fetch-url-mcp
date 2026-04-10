import type { ServerResult } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { after, before, describe, it } from 'node:test';

import {
  assertHttpModeConfiguration,
  authService,
  buildProtectedResourceMetadataDocument,
  resolveClientIp,
  startHttpServer,
} from '../src/http/index.js';
import { config } from '../src/lib/config.js';
import { resolveTaskOwnerKey, taskManager } from '../src/tasks/manager.js';

const TEST_API_KEY = 'test-api-key';

type HttpServerHandle = Awaited<ReturnType<typeof startHttpServer>>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseFirstSseDataEvent(text: string): unknown {
  const dataLine = text
    .split(/\r?\n/)
    .find((line) => line.startsWith('data: '));
  assert.ok(dataLine, 'expected at least one SSE data event');
  return JSON.parse(dataLine.slice('data: '.length));
}

function assertJsonRpcError(
  value: unknown,
  expected: {
    id: string | number | null;
    code: number;
    message: string;
    data?: unknown;
  }
): void {
  const body = asRecord(value);
  assert.deepEqual(body, {
    jsonrpc: '2.0',
    error: {
      code: expected.code,
      message: expected.message,
      ...(expected.data !== undefined ? { data: expected.data } : {}),
    },
    id: expected.id,
  });
}

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

async function initializeSession(baseUrl: string): Promise<string> {
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
  return sessionId;
}

async function postSessionRpc(
  baseUrl: string,
  sessionId: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: createSessionHeaders({
      sessionId,
      protocolVersion: '2025-11-25',
    }),
    body: JSON.stringify(body),
  });

  assert.equal(response.status, 200);
  return parseFirstSseDataEvent(await response.text());
}

describe('HTTP native gateway routing', () => {
  let server: HttpServerHandle;
  let baseUrl: string;
  const originalStaticTokens = [...config.auth.staticTokens];
  const originalAuthenticate = authService.authenticate.bind(authService);

  before(async () => {
    config.auth.staticTokens.splice(
      0,
      config.auth.staticTokens.length,
      TEST_API_KEY
    );
    authService.authenticate = async () => ({
      token: TEST_API_KEY,
      clientId: 'static-token',
      scopes: [],
      resource: config.auth.resourceUrl,
    });

    server = await startHttpServer();
    baseUrl = `http://${server.host}:${server.port}`;
  });

  after(async () => {
    await server.shutdown('test');
    config.auth.staticTokens.splice(
      0,
      config.auth.staticTokens.length,
      ...originalStaticTokens
    );
    authService.authenticate = originalAuthenticate;
  });

  it('returns 406 for POST /mcp when Accept omits text/event-stream', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: createAuthHeaders('application/json'),
      body: createInitializeRequestBody(),
    });

    assert.equal(response.status, 406);
    assertJsonRpcError(await response.json(), {
      id: null,
      code: -32600,
      message:
        'We need the request to accept both "application/json" and "text/event-stream".',
    });
  });

  it('routes POST /mcp/ through the MCP handler', async () => {
    const response = await fetch(`${baseUrl}/mcp/`, {
      method: 'POST',
      headers: createAuthHeaders('application/json'),
      body: createInitializeRequestBody(),
    });

    assert.equal(response.status, 406);
    assertJsonRpcError(await response.json(), {
      id: null,
      code: -32600,
      message:
        'We need the request to accept both "application/json" and "text/event-stream".',
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
    assertJsonRpcError(await response.json(), {
      id: null,
      code: -32700,
      message:
        "We couldn't parse the request body. Please ensure it's valid JSON.",
    });
  });

  it('rejects MCP POST requests without a JSON object body', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'x-api-key': TEST_API_KEY,
      },
      body: 'not-json',
    });

    assert.equal(response.status, 400);
    assertJsonRpcError(await response.json(), {
      id: null,
      code: -32600,
      message:
        'We need a valid JSON object in the request body for MCP POST requests.',
    });
  });

  it('accepts initialize without MCP-Protocol-Version when the body version is supported', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: createSessionHeaders(),
      body: createInitializeRequestBody(),
    });

    assert.equal(response.status, 200);
    assert.ok(response.headers.get('mcp-session-id'));
    assert.equal(response.headers.get('content-type'), 'text/event-stream');

    const body = await response.text();
    assert.match(body, /"protocolVersion":"2025-11-25"/);
  });

  it('rejects initialize when the body protocol version is unsupported', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: createSessionHeaders(),
      body: createInitializeRequestBodyForVersion('2099-01-01'),
    });

    assert.equal(response.status, 400);
    assertJsonRpcError(await response.json(), {
      id: 1,
      code: -32600,
      message:
        "The protocol version '2099-01-01' isn't supported right now. Please check and try again.",
    });
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
    assertJsonRpcError(await response.json(), {
      id: 2,
      code: -32600,
      message:
        "Your session hasn't been initialized yet. Please wait a moment and try again.",
    });
  });

  it('rejects sessioned requests that omit MCP-Protocol-Version', async () => {
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
    assertJsonRpcError(await pingResponse.json(), {
      id: null,
      code: -32600,
      message:
        'Please include the MCP-Protocol-Version header in your request.',
    });
  });

  it('rejects invalid MCP-Protocol-Version on sessioned requests', async () => {
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

    // Ping with an unsupported version — should be rejected
    const pingResponse = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: createSessionHeaders({
        sessionId,
        protocolVersion: '1999-01-01',
      }),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'ping',
      }),
    });

    assert.equal(pingResponse.status, 400);
    assertJsonRpcError(await pingResponse.json(), {
      id: null,
      code: -32600,
      message:
        "The protocol version '1999-01-01' isn't supported right now. Please check and try again.",
    });
  });

  it('returns the fetch-url tool contract after session initialization', async () => {
    const sessionId = await initializeSession(baseUrl);

    const listResponse = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: createSessionHeaders({
        sessionId,
        protocolVersion: '2025-11-25',
      }),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/list',
      }),
    });

    assert.equal(listResponse.status, 200);
    const body = parseFirstSseDataEvent(await listResponse.text()) as {
      result?: { tools?: Array<Record<string, unknown>> };
    };

    const tool = body.result?.tools?.find(
      (entry) => entry['name'] === 'fetch-url'
    );
    assert.ok(tool, 'fetch-url should be listed');
    const execution = asRecord(tool['execution']);
    assert.equal(execution?.['taskSupport'], 'optional');
    assert.deepEqual(tool['annotations'], {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    assert.equal(Array.isArray(tool['icons']), true);
  });

  it('keeps auth-bound tasks accessible after the original session closes', async () => {
    const ownerKey = resolveTaskOwnerKey({
      authInfo: { clientId: 'static-token', token: TEST_API_KEY },
    });
    const task = taskManager.createTask(
      { keepAlive: 5_000 },
      'Task completed',
      ownerKey
    );
    taskManager.updateTask(task.taskId, {
      status: 'completed',
      result: {
        content: [{ type: 'text' as const, text: 'persisted result' }],
      } satisfies ServerResult,
    });

    const firstSessionId = await initializeSession(baseUrl);
    const closeResponse = await fetch(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: createSessionHeaders({
        sessionId: firstSessionId,
        protocolVersion: '2025-11-25',
      }),
    });
    assert.equal(closeResponse.status, 200);

    const secondSessionId = await initializeSession(baseUrl);

    const getBody = asRecord(
      await postSessionRpc(baseUrl, secondSessionId, {
        jsonrpc: '2.0',
        id: 10,
        method: 'tasks/get',
        params: { taskId: task.taskId },
      })
    );
    assert.equal(getBody?.['result'] && typeof getBody['result'], 'object');
    assert.equal(asRecord(getBody?.['result'])?.['taskId'], task.taskId);

    const listBody = asRecord(
      await postSessionRpc(baseUrl, secondSessionId, {
        jsonrpc: '2.0',
        id: 11,
        method: 'tasks/list',
        params: {},
      })
    );
    const tasks = Array.isArray(asRecord(listBody?.['result'])?.['tasks'])
      ? (asRecord(listBody?.['result'])?.['tasks'] as Array<
          Record<string, unknown>
        >)
      : [];
    assert.ok(tasks.some((entry) => entry['taskId'] === task.taskId));

    const resultBody = asRecord(
      await postSessionRpc(baseUrl, secondSessionId, {
        jsonrpc: '2.0',
        id: 12,
        method: 'tasks/result',
        params: { taskId: task.taskId },
      })
    );
    assert.equal(
      asRecord(resultBody?.['result'])?.['content'] instanceof Array,
      true
    );
    const content = asRecord(resultBody?.['result'])?.['content'] as
      | Array<Record<string, unknown>>
      | undefined;
    assert.equal(content?.[0]?.['text'], 'persisted result');
  });

  it('returns 405 for unsupported methods on /mcp', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'PUT',
      headers: createAuthHeaders('application/json, text/event-stream'),
      body: JSON.stringify({}),
    });

    assert.equal(response.status, 405);
    assert.deepEqual(await response.json(), {
      error: "Looks like you tried to use a method that isn't allowed here.",
    });
    assert.equal(response.headers.get('allow'), 'DELETE, GET, OPTIONS, POST');
  });
});

describe('HTTP auth and rate-limit behavior', () => {
  it('prefers trusted proxy forwarding headers for client IP resolution', () => {
    const originalTrustProxy = config.server.http.trustProxy;
    config.server.http.trustProxy = true;

    try {
      const forwardedIp = resolveClientIp({
        headers: { 'x-forwarded-for': '198.51.100.10, 10.0.0.5' },
        socket: { remoteAddress: '127.0.0.1' },
      } as unknown as IncomingMessage);
      assert.equal(forwardedIp, '198.51.100.10');

      const standardForwardedIp = resolveClientIp({
        headers: { forwarded: 'for="[2001:db8::8]:1234";proto=https' },
        socket: { remoteAddress: '127.0.0.1' },
      } as unknown as IncomingMessage);
      assert.equal(standardForwardedIp, '2001:db8::8');
    } finally {
      config.server.http.trustProxy = originalTrustProxy;
    }
  });

  it('fails fast when OAuth mode is missing introspection configuration', () => {
    const originalMode = config.auth.mode;
    const originalIssuerUrl = config.auth.issuerUrl;
    const originalIntrospectionUrl = config.auth.introspectionUrl;

    config.auth.mode = 'oauth';
    config.auth.issuerUrl = new URL('https://issuer.example.com');
    config.auth.introspectionUrl = undefined;

    try {
      assert.throws(
        () => assertHttpModeConfiguration(),
        /OAUTH_INTROSPECTION_URL/
      );
    } finally {
      config.auth.mode = originalMode;
      config.auth.issuerUrl = originalIssuerUrl;
      config.auth.introspectionUrl = originalIntrospectionUrl;
    }
  });

  it('builds protected resource metadata from the configured public resource URL', () => {
    const originalResourceUrl = config.auth.resourceUrl;
    const originalIssuerUrl = config.auth.issuerUrl;

    config.auth.resourceUrl = new URL('https://public.example.com/mcp');
    config.auth.issuerUrl = new URL('https://issuer.example.com');

    try {
      const document = buildProtectedResourceMetadataDocument();

      assert.equal(document.resource, 'https://public.example.com/mcp');
      assert.equal(
        document.resource_metadata,
        'https://public.example.com/.well-known/oauth-protected-resource/mcp'
      );
    } finally {
      config.auth.resourceUrl = originalResourceUrl;
      config.auth.issuerUrl = originalIssuerUrl;
    }
  });

  it('returns a single 429 response with retry-after headers', async () => {
    const originalMaxRequests = config.rateLimit.maxRequests;
    const originalPort = config.server.port;
    const originalResourceUrl = config.auth.resourceUrl;
    const originalStaticTokens = [...config.auth.staticTokens];
    const originalAuthenticate = authService.authenticate.bind(authService);

    config.rateLimit.maxRequests = 0;
    config.server.port = 0;
    config.auth.staticTokens.splice(
      0,
      config.auth.staticTokens.length,
      TEST_API_KEY
    );
    authService.authenticate = async () => ({
      token: TEST_API_KEY,
      clientId: 'static-token',
      scopes: [],
      resource: config.auth.resourceUrl,
    });

    let rateLimitedServer: HttpServerHandle | undefined;
    try {
      rateLimitedServer = await startHttpServer();
      const rateLimitedBaseUrl = `http://${rateLimitedServer.host}:${rateLimitedServer.port}`;

      const response = await fetch(`${rateLimitedBaseUrl}/mcp`, {
        method: 'POST',
        headers: createSessionHeaders(),
        body: createInitializeRequestBody(),
      });

      assert.equal(response.status, 429);
      assert.equal(response.headers.get('retry-after'), '60');
      assertJsonRpcError(await response.json(), {
        id: null,
        code: -32600,
        message: 'Rate limit exceeded',
        data: { retryAfter: 60 },
      });
    } finally {
      if (rateLimitedServer) {
        await rateLimitedServer.shutdown('test');
      }
      config.rateLimit.maxRequests = originalMaxRequests;
      config.server.port = originalPort;
      config.auth.resourceUrl = originalResourceUrl;
      config.auth.staticTokens.splice(
        0,
        config.auth.staticTokens.length,
        ...originalStaticTokens
      );
      authService.authenticate = originalAuthenticate;
    }
  });

  it('rate limits trusted proxy clients by forwarded IP instead of the proxy hop', async () => {
    const originalMaxRequests = config.rateLimit.maxRequests;
    const originalPort = config.server.port;
    const originalResourceUrl = config.auth.resourceUrl;
    const originalTrustProxy = config.server.http.trustProxy;
    const originalStaticTokens = [...config.auth.staticTokens];
    const originalAuthenticate = authService.authenticate.bind(authService);

    config.rateLimit.maxRequests = 1;
    config.server.port = 0;
    config.server.http.trustProxy = true;
    config.auth.staticTokens.splice(
      0,
      config.auth.staticTokens.length,
      TEST_API_KEY
    );
    authService.authenticate = async () => ({
      token: TEST_API_KEY,
      clientId: 'static-token',
      scopes: [],
      resource: config.auth.resourceUrl,
    });

    let proxiedServer: HttpServerHandle | undefined;
    try {
      proxiedServer = await startHttpServer();
      const proxiedBaseUrl = `http://${proxiedServer.host}:${proxiedServer.port}`;

      const firstResponse = await fetch(`${proxiedBaseUrl}/mcp`, {
        method: 'POST',
        headers: {
          ...createSessionHeaders(),
          'x-forwarded-for': '198.51.100.10',
        },
        body: createInitializeRequestBody(),
      });

      const secondResponse = await fetch(`${proxiedBaseUrl}/mcp`, {
        method: 'POST',
        headers: {
          ...createSessionHeaders(),
          'x-forwarded-for': '203.0.113.20',
        },
        body: createInitializeRequestBody(),
      });

      assert.equal(firstResponse.status, 200);
      assert.equal(secondResponse.status, 200);
      await firstResponse.text();
      await secondResponse.text();
    } finally {
      if (proxiedServer) {
        await proxiedServer.shutdown('test');
      }
      config.rateLimit.maxRequests = originalMaxRequests;
      config.server.port = originalPort;
      config.server.http.trustProxy = originalTrustProxy;
      config.auth.resourceUrl = originalResourceUrl;
      config.auth.staticTokens.splice(
        0,
        config.auth.staticTokens.length,
        ...originalStaticTokens
      );
      authService.authenticate = originalAuthenticate;
    }
  });
});
