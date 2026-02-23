import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { createMcpServer } from '../dist/server.js';
import { shutdownTransformWorkerPool } from '../dist/transform/transform.js';

after(async () => {
  await shutdownTransformWorkerPool();
});

type RequestHandler = (request: unknown, extra?: unknown) => Promise<unknown>;

type HandlerMap = Map<string, RequestHandler>;

function getRequestHandler(
  server: Awaited<ReturnType<typeof createMcpServer>>,
  method: string
): RequestHandler {
  const handlers = (
    server.server as unknown as { _requestHandlers: HandlerMap }
  )._requestHandlers;
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
      })) as { task?: { taskId?: string } };

      const taskId = createResult.task?.taskId;
      assert.ok(taskId, 'task id should be returned');

      const taskStatus = (await getTask({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/get',
        params: { taskId, task: { ttl: 10_000 } },
      })) as { taskId?: string; status?: string };

      assert.equal(taskStatus.taskId, taskId);
      assert.equal(typeof taskStatus.status, 'string');

      const result = (await getTaskResult({
        jsonrpc: '2.0',
        id: 2,
        method: 'tasks/result',
        params: { taskId, task: { ttl: 10_000 } },
      })) as {
        structuredContent?: { url?: string; markdown?: string };
        isError?: boolean;
      };

      assert.equal(result.isError, undefined);
      assert.equal(
        result.structuredContent?.url,
        'https://example.com/task-test'
      );
      assert.equal(typeof result.structuredContent?.markdown, 'string');
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
      })) as { task?: { taskId?: string } };

      const taskId = createResult.task?.taskId;
      assert.ok(taskId, 'task id should be returned');

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
      })) as { taskId?: string; status?: string };

      assert.equal(taskStatus.taskId, taskId);
      assert.equal(taskStatus.status, 'cancelled');

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
});
