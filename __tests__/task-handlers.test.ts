import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { handleToolCallRequest } from '../dist/tasks/execution.js';
import { registerTaskHandlers } from '../dist/tasks/handlers.js';
import {
  registerTaskCapableTool,
  unregisterTaskCapableTool,
} from '../dist/tasks/registry.js';

type UnknownRequestHandler = (
  request: unknown,
  extra?: unknown
) => Promise<unknown>;

function isUnknownRequestHandler(
  value: unknown
): value is UnknownRequestHandler {
  return typeof value === 'function';
}

function getTaskResultHandler(server: McpServer): UnknownRequestHandler {
  const handlers: unknown = Reflect.get(server.server, '_requestHandlers');
  assert.ok(handlers instanceof Map);
  const handler = handlers.get('tasks/result');
  assert.ok(isUnknownRequestHandler(handler));
  return handler;
}

describe('task result failure normalization', () => {
  it('returns isError result when a background tool throws', async () => {
    const server = new McpServer(
      { name: 'task-handler-test', version: '0.0.0' },
      {
        capabilities: {
          tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
        },
      }
    );
    const toolName = `failing-task-tool-${randomUUID()}`;

    registerTaskCapableTool({
      name: toolName,
      parseArguments: () => ({}),
      execute: async () => {
        throw new Error('boom');
      },
      taskSupport: 'optional',
    });

    try {
      registerTaskHandlers(server, { requireInterception: false });

      const taskResult = (await handleToolCallRequest(
        server,
        {
          method: 'tools/call',
          params: { name: toolName, arguments: {}, task: { ttl: 1_000 } },
        },
        { ownerKey: 'default' }
      )) as { task: { taskId: string } };

      const result = (await getTaskResultHandler(server)(
        { method: 'tasks/result', params: { taskId: taskResult.task.taskId } },
        undefined
      )) as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
        _meta?: Record<string, unknown>;
      };

      assert.equal(result.isError, true);
      assert.equal(JSON.parse(result.content[0]?.text ?? '{}').error, 'boom');
      assert.deepEqual(result._meta?.['io.modelcontextprotocol/related-task'], {
        taskId: taskResult.task.taskId,
      });
    } finally {
      unregisterTaskCapableTool(toolName);
      await server.close();
    }
  });

  it('preserves McpError code in the background failure payload', async () => {
    const server = new McpServer(
      { name: 'task-handler-test', version: '0.0.0' },
      {
        capabilities: {
          tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
        },
      }
    );
    const toolName = `mcp-error-task-tool-${randomUUID()}`;

    registerTaskCapableTool({
      name: toolName,
      parseArguments: () => ({}),
      execute: async () => {
        throw new McpError(ErrorCode.InternalError, 'broken', {
          reason: 'test',
        });
      },
      taskSupport: 'optional',
    });

    try {
      registerTaskHandlers(server, { requireInterception: false });

      const taskResult = (await handleToolCallRequest(
        server,
        {
          method: 'tools/call',
          params: { name: toolName, arguments: {}, task: { ttl: 1_000 } },
        },
        { ownerKey: 'default' }
      )) as { task: { taskId: string } };

      const result = (await getTaskResultHandler(server)(
        { method: 'tasks/result', params: { taskId: taskResult.task.taskId } },
        undefined
      )) as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };

      const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<
        string,
        unknown
      >;
      assert.equal(result.isError, true);
      assert.equal(payload.error, 'broken');
      assert.equal(payload.code, ErrorCode.InternalError);
    } finally {
      unregisterTaskCapableTool(toolName);
      await server.close();
    }
  });
});
