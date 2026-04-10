import { McpServer } from '@modelcontextprotocol/server';

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
import { taskManager } from '../src/tasks/store.js';

function createTaskTestServer(): McpServer {
  return new McpServer(
    { name: 'trace-context-test', version: '0.0.0' },
    {
      capabilities: {
        tools: {},
        tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
      },
    }
  );
}

async function waitForCompletedTask(
  _server: McpServer,
  taskId: string
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const task = taskManager.getTask(taskId);
    if (task?.status === 'completed') return;
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
      registerTaskHandlers(server);

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
      registerTaskHandlers(server);

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

      const completedTask = taskManager.getTask(task.task.taskId);
      assert.ok(completedTask);
      const result = completedTask.result as {
        content: Array<{ text: string }>;
      };

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
