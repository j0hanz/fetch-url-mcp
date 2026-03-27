import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { setTimeout as setTimeoutPromise } from 'node:timers/promises';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import {
  createProgressReporter,
  type ProgressNotification,
} from '../src/lib/mcp-interop.js';
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

function getTaskGetHandler(server: McpServer): UnknownRequestHandler {
  const handlers: unknown = Reflect.get(server.server, '_requestHandlers');
  assert.ok(handlers instanceof Map);
  const handler = handlers.get('tasks/get');
  assert.ok(isUnknownRequestHandler(handler));
  return handler;
}

function createTaskTestServer(): McpServer {
  return new McpServer(
    { name: 'task-handler-test', version: '0.0.0' },
    {
      capabilities: {
        tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
      },
    }
  );
}

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((res) => {
      resolve = res;
    }),
    resolve,
  };
}

async function waitForTaskSnapshot(
  server: McpServer,
  taskId: string,
  predicate: (task: Record<string, unknown>) => boolean
): Promise<Record<string, unknown>> {
  const getTask = getTaskGetHandler(server);

  for (let attempt = 0; attempt < 50; attempt++) {
    const snapshot = (await getTask(
      { method: 'tasks/get', params: { taskId } },
      undefined
    )) as Record<string, unknown>;
    if (predicate(snapshot)) return snapshot;
    await setTimeoutPromise(10);
  }

  assert.fail(`Timed out waiting for task snapshot ${taskId}`);
}

describe('progress notifications', () => {
  it('emits monotonic inline progress notifications with the provided token', async () => {
    const server = createTaskTestServer();
    const toolName = `inline-progress-tool-${randomUUID()}`;

    registerTaskCapableTool(server, {
      name: toolName,
      parseArguments: () => ({}),
      execute: async (_args, extra) => {
        const reporter = createProgressReporter(extra);
        reporter.report(2, 'Phase 2', 3);
        reporter.report(1, 'Phase 1 rewind', 3);
        reporter.report(3, 'Done', 3);
        return {
          content: [{ type: 'text' as const, text: 'ok' }],
        };
      },
      taskSupport: 'optional',
    });

    const notifications: ProgressNotification[] = [];

    try {
      registerTaskHandlers(server, { requireInterception: false });

      await handleToolCallRequest(
        server,
        {
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: {},
            _meta: { progressToken: 'tok-inline' },
          },
        },
        {
          ownerKey: 'default',
          sendNotification: async (notification) => {
            notifications.push(notification);
          },
        }
      );

      await setTimeoutPromise(250);

      assert.equal(notifications.length, 2);
      assert.deepEqual(
        notifications.map((notification) => notification.params.progress),
        [2, 3]
      );
      assert.ok(
        notifications.every(
          (notification) =>
            notification.params.progressToken === 'tok-inline' &&
            notification.params.total === 3
        )
      );
    } finally {
      unregisterTaskCapableTool(server, toolName);
      await server.close();
    }
  });

  it('reuses the same task progress token and stops notifying after terminal completion', async () => {
    const server = createTaskTestServer();
    const toolName = `task-progress-tool-${randomUUID()}`;

    registerTaskCapableTool(server, {
      name: toolName,
      parseArguments: () => ({}),
      execute: async (_args, extra) => {
        const reporter = createProgressReporter(extra);
        reporter.report(1, 'Queued', 4);
        await setTimeoutPromise(125);
        reporter.report(2, 'Fetching', 4);
        await setTimeoutPromise(125);
        reporter.report(4, 'Done', 4);
        setTimeout(() => {
          reporter.report(5, 'Too late', 5);
        }, 0);
        return {
          content: [{ type: 'text' as const, text: 'done' }],
        };
      },
      taskSupport: 'optional',
    });

    const notifications: ProgressNotification[] = [];

    try {
      registerTaskHandlers(server, { requireInterception: false });

      const createTask = (await handleToolCallRequest(
        server,
        {
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: {},
            task: { ttl: 5_000 },
            _meta: { progressToken: 'tok-task' },
          },
        },
        {
          ownerKey: 'default',
          sendNotification: async (notification) => {
            notifications.push(notification);
          },
        }
      )) as { task: { taskId: string } };

      const result = (await getTaskResultHandler(server)(
        { method: 'tasks/result', params: { taskId: createTask.task.taskId } },
        undefined
      )) as { content: Array<{ type: string; text: string }> };

      assert.equal(result.content[0]?.text, 'done');

      await setTimeoutPromise(250);

      assert.equal(notifications.length, 3);
      assert.deepEqual(
        notifications.map((notification) => notification.params.progress),
        [1, 2, 4]
      );
      assert.ok(
        notifications.every(
          (notification) =>
            notification.params.progressToken === 'tok-task' &&
            notification.params.total === 4 &&
            notification.params._meta?.[
              'io.modelcontextprotocol/related-task'
            ] !== undefined
        )
      );
      assert.deepEqual(
        notifications[0]?.params._meta?.[
          'io.modelcontextprotocol/related-task'
        ],
        { taskId: createTask.task.taskId }
      );
    } finally {
      unregisterTaskCapableTool(server, toolName);
      await server.close();
    }
  });
});

describe('task progress state', () => {
  it('surfaces numeric progress and total through tasks/get while a task is running', async () => {
    const server = createTaskTestServer();
    const toolName = `task-progress-state-tool-${randomUUID()}`;
    const gate = createDeferred();

    registerTaskCapableTool(server, {
      name: toolName,
      parseArguments: () => ({}),
      execute: async (_args, extra) => {
        const reporter = createProgressReporter(extra);
        reporter.report(1, 'Queued', 3);
        await gate.promise;
        reporter.report(3, 'Done', 3);
        return {
          content: [{ type: 'text' as const, text: 'done' }],
        };
      },
      taskSupport: 'optional',
    });

    try {
      registerTaskHandlers(server, { requireInterception: false });

      const createTask = (await handleToolCallRequest(
        server,
        {
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: {},
            task: { ttl: 5_000 },
            _meta: { progressToken: 'tok-state' },
          },
        },
        { ownerKey: 'default' }
      )) as { task: { taskId: string } };

      const snapshot = await waitForTaskSnapshot(
        server,
        createTask.task.taskId,
        (task) => task['progress'] === 1 && task['total'] === 3
      );

      assert.equal(snapshot['status'], 'working');
      assert.equal(snapshot['statusMessage'], 'Queued');
      assert.equal(snapshot['progress'], 1);
      assert.equal(snapshot['total'], 3);

      gate.resolve();

      await getTaskResultHandler(server)(
        { method: 'tasks/result', params: { taskId: createTask.task.taskId } },
        undefined
      );
    } finally {
      unregisterTaskCapableTool(server, toolName);
      await server.close();
    }
  });
});

describe('task result failure normalization', () => {
  it('replays a JSON-RPC error when a background tool throws', async () => {
    const server = createTaskTestServer();
    const toolName = `failing-task-tool-${randomUUID()}`;

    registerTaskCapableTool(server, {
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

      await assert.rejects(
        () =>
          getTaskResultHandler(server)(
            {
              method: 'tasks/result',
              params: { taskId: taskResult.task.taskId },
            },
            undefined
          ),
        (error: unknown) =>
          error instanceof McpError &&
          error.code === ErrorCode.InternalError &&
          error.message.includes('boom')
      );
    } finally {
      unregisterTaskCapableTool(server, toolName);
      await server.close();
    }
  });

  it('preserves McpError code and data for background failures', async () => {
    const server = createTaskTestServer();
    const toolName = `mcp-error-task-tool-${randomUUID()}`;

    registerTaskCapableTool(server, {
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

      await assert.rejects(
        () =>
          getTaskResultHandler(server)(
            {
              method: 'tasks/result',
              params: { taskId: taskResult.task.taskId },
            },
            undefined
          ),
        (error: unknown) =>
          error instanceof McpError &&
          error.code === ErrorCode.InternalError &&
          error.message.includes('broken') &&
          (error.data as Record<string, unknown> | undefined)?.['reason'] ===
            'test'
      );
    } finally {
      unregisterTaskCapableTool(server, toolName);
      await server.close();
    }
  });
});

describe('task result for cancelled task', () => {
  it('returns a cancellation JSON-RPC error for cancelled tasks', async () => {
    const server = createTaskTestServer();
    const toolName = `slow-task-tool-${randomUUID()}`;

    registerTaskCapableTool(server, {
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

      await assert.rejects(
        () =>
          getTaskResultHandler(server)(
            {
              method: 'tasks/result',
              params: { taskId: taskResult.task.taskId },
            },
            undefined
          ),
        (error: unknown) =>
          error instanceof McpError &&
          error.code === ErrorCode.ConnectionClosed &&
          error.message.includes('The task was cancelled by request.') &&
          (error.data as Record<string, unknown> | undefined)?.['code'] ===
            'ABORTED'
      );
    } finally {
      unregisterTaskCapableTool(server, toolName);
      await server.close();
    }
  });
});

describe('required task support enforcement', () => {
  it('rejects non-task call for tool with taskSupport required', async () => {
    const server = createTaskTestServer();
    const toolName = `required-task-tool-${randomUUID()}`;

    registerTaskCapableTool(server, {
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
      unregisterTaskCapableTool(server, toolName);
      await server.close();
    }
  });
});

describe('model-immediate-response in CreateTaskResult', () => {
  it('includes _meta with model-immediate-response when tool provides it', async () => {
    const server = createTaskTestServer();
    const toolName = `immediate-response-tool-${randomUUID()}`;

    registerTaskCapableTool(server, {
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
      unregisterTaskCapableTool(server, toolName);
      await server.close();
    }
  });

  it('omits _meta when tool does not provide immediateResponse', async () => {
    const server = createTaskTestServer();
    const toolName = `no-immediate-response-tool-${randomUUID()}`;

    registerTaskCapableTool(server, {
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
      unregisterTaskCapableTool(server, toolName);
      await server.close();
    }
  });
});
