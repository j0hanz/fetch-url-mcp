import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { createMcpServer } from '../dist/server.js';
import { shutdownTransformWorkerPool } from '../dist/transform/transform.js';

after(async () => {
  await shutdownTransformWorkerPool();
});

type RequestHandler = (request: unknown, extra?: unknown) => Promise<unknown>;

type HandlerMap = Map<string, RequestHandler>;

function getPrivateRequestHandlers(target: object): Map<string, unknown> {
  const handlers = Reflect.get(target, '_requestHandlers');
  assert.ok(
    handlers instanceof Map,
    'MCP protocol should expose _requestHandlers'
  );
  return handlers;
}

function getRequestHandler(
  server: Awaited<ReturnType<typeof createMcpServer>>,
  method: string
): RequestHandler {
  const handlers = getPrivateRequestHandlers(server.server) as HandlerMap;
  const handler = handlers.get(method);
  assert.ok(handler, `${method} handler should be registered`);
  return handler;
}

describe('MCP task-augmented tools', () => {
  it('supports task-augmented fetch-url calls and task polling', async (t) => {
    const server = await createMcpServer();

    t.mock.method(globalThis, 'fetch', async () => {
      return new Response('<html><body><p>Task fetch</p></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });

    try {
      const listTools = getRequestHandler(server, 'tools/list');
      const callTool = getRequestHandler(server, 'tools/call');
      const getTask = getRequestHandler(server, 'tasks/get');
      const getTaskResult = getRequestHandler(server, 'tasks/result');

      const toolsResult = (await listTools({
        method: 'tools/list',
      })) as {
        tools?: { name: string; execution?: { taskSupport?: string } }[];
      };

      const fetchTool = toolsResult.tools?.find(
        (tool) => tool.name === 'fetch-url'
      );
      assert.ok(fetchTool, 'fetch-url tool should be registered');
      assert.equal(fetchTool.execution?.taskSupport, 'optional');

      const createResult = (await callTool({
        method: 'tools/call',
        params: {
          name: 'fetch-url',
          arguments: { url: 'https://example.com/task-test' },
          task: { ttl: 10_000 },
        },
      })) as { task?: { taskId?: string }; _meta?: unknown };

      const taskId = createResult.task?.taskId;
      assert.ok(taskId, 'task id should be returned');
      assert.equal('_meta' in createResult, false);

      const taskStatus = (await getTask({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/get',
        params: { taskId, task: { ttl: 10_000 } },
      })) as {
        taskId?: string;
        status?: string;
      };

      assert.equal(taskStatus.taskId, taskId);
      assert.equal(typeof taskStatus.status, 'string');
      assert.equal('_meta' in taskStatus, false);

      const result = (await getTaskResult({
        jsonrpc: '2.0',
        id: 2,
        method: 'tasks/result',
        params: { taskId, task: { ttl: 10_000 } },
      })) as {
        structuredContent?: { url?: string; markdown?: string };
        isError?: boolean;
        _meta?: {
          'io.modelcontextprotocol/related-task'?: {
            taskId?: string;
          };
        };
      };

      assert.equal(result.isError, undefined);
      assert.equal(
        result.structuredContent?.url,
        'https://example.com/task-test'
      );
      assert.equal(typeof result.structuredContent?.markdown, 'string');
      assert.equal(
        result._meta?.['io.modelcontextprotocol/related-task']?.taskId,
        taskId
      );
    } finally {
      await server.close();
    }
  });

  it('allows tasks to be cancelled', async (t) => {
    const server = await createMcpServer();

    t.mock.method(globalThis, 'fetch', async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return new Response('<html><body><p>Cancelled task</p></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });

    try {
      const callTool = getRequestHandler(server, 'tools/call');
      const cancelTask = getRequestHandler(server, 'tasks/cancel');
      const getTask = getRequestHandler(server, 'tasks/get');
      const getTaskResult = getRequestHandler(server, 'tasks/result');

      const createResult = (await callTool({
        method: 'tools/call',
        params: {
          name: 'fetch-url',
          arguments: { url: 'https://example.com/task-cancel' },
          task: { ttl: 10_000 },
        },
      })) as {
        task?: { taskId?: string };
        _meta?: unknown;
      };

      const taskId = createResult.task?.taskId;
      assert.ok(taskId, 'task id should be returned');
      assert.equal('_meta' in createResult, false);

      await cancelTask({
        jsonrpc: '2.0',
        id: 10,
        method: 'tasks/cancel',
        params: { taskId, task: { ttl: 10_000 } },
      });

      const taskStatus = (await getTask({
        jsonrpc: '2.0',
        id: 11,
        method: 'tasks/get',
        params: { taskId, task: { ttl: 10_000 } },
      })) as {
        taskId?: string;
        status?: string;
      };

      assert.equal(taskStatus.taskId, taskId);
      assert.equal(taskStatus.status, 'cancelled');
      assert.equal('_meta' in taskStatus, false);

      await assert.rejects(
        async () =>
          getTaskResult({
            jsonrpc: '2.0',
            id: 12,
            method: 'tasks/result',
            params: { taskId, task: { ttl: 10_000 } },
          }),
        (error: unknown) =>
          error instanceof Error && error.message.includes('Task was cancelled')
      );
    } finally {
      await server.close();
    }
  });

  it('returns InvalidParams for unknown task ids', async () => {
    const server = await createMcpServer();

    try {
      const getTask = getRequestHandler(server, 'tasks/get');

      await assert.rejects(
        async () =>
          getTask({
            jsonrpc: '2.0',
            id: 20,
            method: 'tasks/get',
            params: { taskId: 'missing-task-id' },
          }),
        (error: unknown) =>
          error instanceof Error &&
          /Task not found/.test(error.message) &&
          (error as Error & { code?: number }).code === -32602
      );
    } finally {
      await server.close();
    }
  });
});
