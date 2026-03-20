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
  it('strips client-supplied related-task metadata from direct-call progress notifications', async (t) => {
    const server = await createMcpServer();
    const notifications: Array<{
      method?: string;
      params?: {
        progressToken?: string;
        _meta?: {
          'io.modelcontextprotocol/related-task'?: { taskId?: string };
        };
      };
    }> = [];

    t.mock.method(globalThis, 'fetch', async () => {
      return new Response('<html><body><p>Direct fetch</p></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });

    try {
      const callTool = getRequestHandler(server, 'tools/call');

      await callTool(
        {
          method: 'tools/call',
          params: {
            name: 'fetch-url',
            arguments: { url: 'https://example.com/direct-progress' },
            _meta: {
              progressToken: 'prog-direct',
              'io.modelcontextprotocol/related-task': { taskId: 'forged-task' },
            },
          },
        },
        {
          sendNotification: async (notification: unknown) => {
            notifications.push(notification as (typeof notifications)[number]);
          },
        }
      );

      const progressNotifications = notifications.filter(
        (notification) => notification.method === 'notifications/progress'
      );
      assert.ok(progressNotifications.length > 0);
      for (const notification of progressNotifications) {
        assert.equal(notification.params?.progressToken, 'prog-direct');
        assert.equal(
          notification.params?._meta?.['io.modelcontextprotocol/related-task'],
          undefined
        );
      }
    } finally {
      await server.close();
    }
  });

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
        params: { taskId },
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
        params: { taskId },
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
    const notifications: unknown[] = [];

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

      const createResult = (await callTool(
        {
          method: 'tools/call',
          params: {
            name: 'fetch-url',
            arguments: { url: 'https://example.com/task-cancel' },
            task: { ttl: 10_000 },
          },
        },
        {
          sendNotification: async (notification: unknown) => {
            notifications.push(notification);
          },
        }
      )) as {
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
        params: { taskId },
      });

      const notificationCountAtCancel = notifications.length;

      const taskStatus = (await getTask({
        jsonrpc: '2.0',
        id: 11,
        method: 'tasks/get',
        params: { taskId },
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
            params: { taskId },
          }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(
            (error as Error & { code?: number }).code,
            -32600,
            'cancelled tasks/result should use InvalidRequest'
          );
          assert.match(error.message, /Task was cancelled/);
          assert.deepEqual((error as Error & { data?: unknown }).data, {
            taskId,
            status: 'cancelled',
            statusMessage: 'The task was cancelled by request.',
          });
          return true;
        }
      );

      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(notifications.length, notificationCountAtCancel);
    } finally {
      await server.close();
    }
  });

  it('emits task progress notifications on the original progress token with the real related-task id', async (t) => {
    const server = await createMcpServer();
    const notifications: Array<{
      method?: string;
      params?: {
        progressToken?: string;
        progress?: number;
        _meta?: {
          'io.modelcontextprotocol/related-task'?: { taskId?: string };
        };
      };
    }> = [];

    t.mock.method(globalThis, 'fetch', async () => {
      return new Response('<html><body><p>Task progress</p></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });

    try {
      const callTool = getRequestHandler(server, 'tools/call');
      const getTaskResult = getRequestHandler(server, 'tasks/result');

      const createResult = (await callTool(
        {
          method: 'tools/call',
          params: {
            name: 'fetch-url',
            arguments: { url: 'https://example.com/task-progress' },
            task: { ttl: 10_000 },
            _meta: {
              progressToken: 'prog-task',
              'io.modelcontextprotocol/related-task': { taskId: 'forged-task' },
            },
          },
        },
        {
          sendNotification: async (notification: unknown) => {
            notifications.push(notification as (typeof notifications)[number]);
          },
        }
      )) as {
        task?: { taskId?: string };
      };

      const taskId = createResult.task?.taskId;
      assert.ok(taskId);

      await getTaskResult({
        jsonrpc: '2.0',
        id: 30,
        method: 'tasks/result',
        params: { taskId },
      });
      await new Promise((resolve) => setImmediate(resolve));

      const progressNotifications = notifications.filter(
        (notification) => notification.method === 'notifications/progress'
      );
      assert.ok(progressNotifications.length > 0);

      for (const notification of progressNotifications) {
        assert.equal(notification.params?.progressToken, 'prog-task');
        assert.equal(
          notification.params?._meta?.['io.modelcontextprotocol/related-task']
            ?.taskId,
          taskId
        );
      }
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

  it('tolerates unknown params on task requests (passthrough)', async () => {
    const server = await createMcpServer();

    try {
      const getTask = getRequestHandler(server, 'tasks/get');

      // Extra keys (e.g. task, _meta) should be ignored — not rejected.
      // The handler proceeds normally and returns "Task not found" for the bad id.
      await assert.rejects(
        async () =>
          getTask({
            jsonrpc: '2.0',
            id: 21,
            method: 'tasks/get',
            params: { taskId: 'missing-task-id', task: { ttl: 10_000 } },
          }),
        (error: unknown) =>
          error instanceof Error && /Task not found/.test(error.message)
      );
    } finally {
      await server.close();
    }
  });
});
