import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { setTimeout as setTimeoutPromise } from 'node:timers/promises';

import { getTraceContext } from '../src/lib/core.js';
import {
  handleToolCallRequest,
  registerTaskCapableTool,
  registerTaskHandlers,
  unregisterTaskCapableTool,
} from '../src/tasks/manager.js';

type UnknownRequestHandler = (
  request: unknown,
  extra?: unknown
) => Promise<unknown>;

function createTaskTestServer(): McpServer {
  return new McpServer(
    { name: 'trace-context-test', version: '0.0.0' },
    {
      capabilities: {
        tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
      },
    }
  );
}

function getTaskResultHandler(server: McpServer): UnknownRequestHandler {
  const handlers: unknown = Reflect.get(server.server, '_requestHandlers');
  assert.ok(handlers instanceof Map);
  const handler = handlers.get('tasks/result');
  assert.equal(typeof handler, 'function');
  return handler as UnknownRequestHandler;
}

function getTaskGetHandler(server: McpServer): UnknownRequestHandler {
  const handlers: unknown = Reflect.get(server.server, '_requestHandlers');
  assert.ok(handlers instanceof Map);
  const handler = handlers.get('tasks/get');
  assert.equal(typeof handler, 'function');
  return handler as UnknownRequestHandler;
}

async function waitForCompletedTask(
  server: McpServer,
  taskId: string
): Promise<void> {
  const getTask = getTaskGetHandler(server);

  for (let attempt = 0; attempt < 50; attempt++) {
    const snapshot = (await getTask(
      { method: 'tasks/get', params: { taskId } },
      undefined
    )) as Record<string, unknown>;

    if (snapshot['status'] === 'completed') return;
    await setTimeoutPromise(10);
  }

  assert.fail(`Timed out waiting for completed task ${taskId}`);
}

function parseTraceContext(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

describe('trace context propagation', () => {
  it('passes trace context from request _meta into inline tool execution', async () => {
    const server = createTaskTestServer();
    const toolName = `inline-trace-tool-${randomUUID()}`;

    registerTaskCapableTool(server, {
      name: toolName,
      parseArguments: () => ({}),
      execute: async () => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(getTraceContext()),
          },
        ],
      }),
      taskSupport: 'optional',
    });

    try {
      registerTaskHandlers(server, { requireInterception: false });

      const result = (await handleToolCallRequest(
        server,
        {
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: {},
            _meta: {
              traceparent:
                '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01',
              tracestate: 'rojo=00f067aa0ba902b7',
              baggage: 'env=prod',
            },
          },
        },
        { ownerKey: 'default' }
      )) as { content: Array<{ text: string }> };

      assert.deepEqual(parseTraceContext(result.content[0]?.text ?? ''), {
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01',
        tracestate: 'rojo=00f067aa0ba902b7',
        baggage: 'env=prod',
      });
    } finally {
      unregisterTaskCapableTool(server, toolName);
      await server.close();
    }
  });

  it('preserves trace context through background task execution', async () => {
    const server = createTaskTestServer();
    const toolName = `task-trace-tool-${randomUUID()}`;

    registerTaskCapableTool(server, {
      name: toolName,
      parseArguments: () => ({}),
      execute: async () => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(getTraceContext()),
          },
        ],
      }),
      taskSupport: 'optional',
    });

    try {
      registerTaskHandlers(server, { requireInterception: false });

      const task = (await handleToolCallRequest(
        server,
        {
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: {},
            _meta: {
              traceparent:
                '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00',
              tracestate: 'congo=t61rcWkgMzE',
              baggage: 'user_id=123',
              'modelcontextprotocol.io/task': {
                taskId: 'trace-task',
                keepAlive: 5_000,
              },
            },
          },
        },
        { ownerKey: 'default' }
      )) as { task: { taskId: string } };

      await waitForCompletedTask(server, task.task.taskId);

      const result = (await getTaskResultHandler(server)(
        {
          method: 'tasks/result',
          params: { taskId: task.task.taskId },
        },
        undefined
      )) as { content: Array<{ text: string }> };

      assert.deepEqual(parseTraceContext(result.content[0]?.text ?? ''), {
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00',
        tracestate: 'congo=t61rcWkgMzE',
        baggage: 'user_id=123',
      });
    } finally {
      unregisterTaskCapableTool(server, toolName);
      await server.close();
    }
  });
});
