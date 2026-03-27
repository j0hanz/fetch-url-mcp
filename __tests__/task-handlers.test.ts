import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { handleToolCallRequest } from '../src/tasks/execution.js';
import { registerTaskHandlers } from '../src/tasks/handlers.js';
import {
  registerTaskCapableTool,
  unregisterTaskCapableTool,
} from '../src/tasks/registry.js';

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

function getCancelHandler(server: McpServer): UnknownRequestHandler {
  const handlers: unknown = Reflect.get(server.server, '_requestHandlers');
  assert.ok(handlers instanceof Map);
  const handler = handlers.get('tasks/cancel');
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
      assert.equal(payload['error'], 'broken');
      assert.equal(payload['code'], ErrorCode.InternalError);
    } finally {
      unregisterTaskCapableTool(toolName);
      await server.close();
    }
  });
});

describe('task result for cancelled task', () => {
  it('returns isError result instead of throwing for cancelled tasks', async () => {
    const server = new McpServer(
      { name: 'task-handler-test', version: '0.0.0' },
      {
        capabilities: {
          tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
        },
      }
    );
    const toolName = `slow-task-tool-${randomUUID()}`;

    registerTaskCapableTool({
      name: toolName,
      parseArguments: () => ({}),
      execute: () =>
        new Promise(() => {
          /* never resolves */
        }),
      taskSupport: 'optional',
    });

    try {
      registerTaskHandlers(server, { requireInterception: false });

      const taskResult = (await handleToolCallRequest(
        server,
        {
          method: 'tools/call',
          params: { name: toolName, arguments: {}, task: { ttl: 5_000 } },
        },
        { ownerKey: 'default' }
      )) as { task: { taskId: string } };

      // Cancel the task
      const cancelHandler = getCancelHandler(server);
      await cancelHandler(
        { method: 'tasks/cancel', params: { taskId: taskResult.task.taskId } },
        undefined
      );

      // Retrieve result — should NOT throw
      const result = (await getTaskResultHandler(server)(
        { method: 'tasks/result', params: { taskId: taskResult.task.taskId } },
        undefined
      )) as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
        _meta?: Record<string, unknown>;
      };

      assert.equal(result.isError, true);
      const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<
        string,
        unknown
      >;
      assert.ok(typeof payload['error'] === 'string');
      assert.deepEqual(result._meta?.['io.modelcontextprotocol/related-task'], {
        taskId: taskResult.task.taskId,
      });
    } finally {
      unregisterTaskCapableTool(toolName);
      await server.close();
    }
  });
});

describe('required task support enforcement', () => {
  it('rejects non-task call for tool with taskSupport required', async () => {
    const server = new McpServer(
      { name: 'task-handler-test', version: '0.0.0' },
      {
        capabilities: {
          tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
        },
      }
    );
    const toolName = `required-task-tool-${randomUUID()}`;

    registerTaskCapableTool({
      name: toolName,
      parseArguments: () => ({}),
      execute: async () => ({
        content: [{ type: 'text' as const, text: 'ok' }],
      }),
      taskSupport: 'required',
    });

    try {
      registerTaskHandlers(server, { requireInterception: false });

      await assert.rejects(
        () =>
          handleToolCallRequest(
            server,
            {
              method: 'tools/call',
              params: { name: toolName, arguments: {} },
            },
            { ownerKey: 'default' }
          ),
        (err: unknown) =>
          err instanceof McpError && err.code === ErrorCode.MethodNotFound
      );
    } finally {
      unregisterTaskCapableTool(toolName);
      await server.close();
    }
  });
});

describe('model-immediate-response in CreateTaskResult', () => {
  it('includes _meta with model-immediate-response when tool provides it', async () => {
    const server = new McpServer(
      { name: 'task-handler-test', version: '0.0.0' },
      {
        capabilities: {
          tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
        },
      }
    );
    const toolName = `immediate-response-tool-${randomUUID()}`;

    registerTaskCapableTool({
      name: toolName,
      parseArguments: () => ({}),
      execute: async () => ({
        content: [{ type: 'text' as const, text: 'done' }],
      }),
      taskSupport: 'optional',
      immediateResponse: 'Fetching is in progress, please wait.',
    });

    try {
      registerTaskHandlers(server, { requireInterception: false });

      const result = (await handleToolCallRequest(
        server,
        {
          method: 'tools/call',
          params: { name: toolName, arguments: {}, task: { ttl: 5_000 } },
        },
        { ownerKey: 'default' }
      )) as {
        task: { taskId: string };
        _meta?: Record<string, unknown>;
      };

      assert.ok(result.task.taskId);
      assert.equal(
        result._meta?.['io.modelcontextprotocol/model-immediate-response'],
        'Fetching is in progress, please wait.'
      );
    } finally {
      unregisterTaskCapableTool(toolName);
      await server.close();
    }
  });

  it('omits _meta when tool does not provide immediateResponse', async () => {
    const server = new McpServer(
      { name: 'task-handler-test', version: '0.0.0' },
      {
        capabilities: {
          tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
        },
      }
    );
    const toolName = `no-immediate-response-tool-${randomUUID()}`;

    registerTaskCapableTool({
      name: toolName,
      parseArguments: () => ({}),
      execute: async () => ({
        content: [{ type: 'text' as const, text: 'done' }],
      }),
      taskSupport: 'optional',
    });

    try {
      registerTaskHandlers(server, { requireInterception: false });

      const result = (await handleToolCallRequest(
        server,
        {
          method: 'tools/call',
          params: { name: toolName, arguments: {}, task: { ttl: 5_000 } },
        },
        { ownerKey: 'default' }
      )) as {
        task: { taskId: string };
        _meta?: Record<string, unknown>;
      };

      assert.ok(result.task.taskId);
      assert.equal(result._meta, undefined);
    } finally {
      unregisterTaskCapableTool(toolName);
      await server.close();
    }
  });
});
