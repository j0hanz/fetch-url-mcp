import type { ServerResult } from '@modelcontextprotocol/sdk/types.js';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { authService, startHttpServer } from '../src/http/index.js';
import { config } from '../src/lib/core.js';
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
    assert.deepEqual(await response.json(), {
      error:
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
    assert.deepEqual(await response.json(), {
      error:
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
    assert.deepEqual(await response.json(), {
      error:
        "We couldn't parse the request body. Please ensure it's valid JSON.",
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
      error:
        "Your session hasn't been initialized yet. Please wait a moment and try again.",
    });
  });

  it('tolerates missing MCP-Protocol-Version on sessioned requests (backwards compat)', async () => {
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

    // Ping without MCP-Protocol-Version — should succeed via session fallback
    const pingResponse = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: createSessionHeaders({ sessionId }),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'ping',
      }),
    });

    assert.equal(pingResponse.status, 200);
    const body = await pingResponse.text();
    assert.match(body, /"result"/);
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
    assert.deepEqual(await pingResponse.json(), {
      error:
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
      { ttl: 5_000 },
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
