import { McpServer } from '@modelcontextprotocol/server';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { setTimeout as setTimeoutPromise } from 'node:timers/promises';

import { config } from '../src/lib/config.js';
import {
  createProgressReporter,
  type ProgressNotification,
} from '../src/lib/mcp-interop.js';
import {
  abortTaskExecution,
  handleToolCallRequest,
  registerTaskCapableTool,
  registerTaskHandlers,
  unregisterTaskCapableTool,
} from '../src/tasks/manager.js';
import { taskManager, type TaskState } from '../src/tasks/store.js';

type UnknownRequestHandler = (
  request: unknown,
  extra?: unknown
) => Promise<unknown>;

function isUnknownRequestHandler(
  value: unknown
): value is UnknownRequestHandler {
  return typeof value === 'function';
}

function getDeleteHandler(server: McpServer): UnknownRequestHandler {
  const handlers: unknown = Reflect.get(server.server, '_requestHandlers');
  assert.ok(handlers instanceof Map);
  const handler = handlers.get('tasks/delete');
  assert.ok(isUnknownRequestHandler(handler));
  return handler;
}

function getTaskDirect(taskId: string, ownerKey = 'default'): TaskState {
  const task = taskManager.getTask(taskId, ownerKey);
  assert.ok(task, `Task ${taskId} not found`);
  return task;
}

function cancelTaskDirect(taskId: string, ownerKey = 'default'): TaskState {
  const task = taskManager.cancelTask(taskId, ownerKey);
  assert.ok(task, `Task ${taskId} not found for cancellation`);
  abortTaskExecution(taskId);
  return task;
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

describe('task creation notifications', () => {
  it('emits notifications/tasks/created with related-task metadata only', async () => {
    const server = createTaskTestServer();
    const toolName = `task-created-notification-tool-${randomUUID()}`;
    const notifications: Array<Record<string, unknown>> = [];

    registerTaskCapableTool(server, {
      name: toolName,
      parseArguments: () => ({}),
      execute: async () => ({
        content: [{ type: 'text' as const, text: 'ok' }],
      }),
      taskSupport: 'optional',
    });

    const originalIsConnected = server.isConnected.bind(server);
    const originalNotification = server.server.notification.bind(server.server);
    const originalEmitStatusNotifications =
      config.tasks.emitStatusNotifications;
    config.tasks.emitStatusNotifications = true;
    (server as unknown as { isConnected: () => boolean }).isConnected = () =>
      true;
    (
      server.server as unknown as {
        notification: (...args: unknown[]) => Promise<void>;
      }
    ).notification = async (notification: unknown) => {
      notifications.push(notification as Record<string, unknown>);
    };

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
              'modelcontextprotocol.io/task': {
                taskId: 'created-notification-task',
                keepAlive: 5_000,
              },
            },
          },
        },
        { ownerKey: 'default' }
      )) as { task: { taskId: string } };

      assert.equal(notifications.length >= 1, true);
      const created = notifications.find(
        (notification) =>
          notification['method'] === 'notifications/tasks/created'
      );
      assert.ok(created);
      assert.deepEqual(created['params'], {
        _meta: {
          'io.modelcontextprotocol/related-task': {
            taskId: result.task.taskId,
          },
        },
      });
    } finally {
      (server as unknown as { isConnected: () => boolean }).isConnected =
        originalIsConnected;
      (
        server.server as unknown as {
          notification: (...args: unknown[]) => Promise<void>;
        }
      ).notification = originalNotification as (
        ...args: unknown[]
      ) => Promise<void>;
      config.tasks.emitStatusNotifications = originalEmitStatusNotifications;
      unregisterTaskCapableTool(server, toolName);
      await server.close();
    }
  });
});

async function waitForTaskSnapshot(
  _server: McpServer,
  taskId: string,
  predicate: (task: Record<string, unknown>) => boolean
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const task = taskManager.getTask(taskId);
    if (task) {
      const snapshot = task as unknown as Record<string, unknown>;
      if (predicate(snapshot)) return snapshot;
    }
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
      registerTaskHandlers(server);

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

  it('stops inline notifications after the request lifetime ends', async () => {
    const server = createTaskTestServer();
    const toolName = `inline-progress-lifetime-tool-${randomUUID()}`;

    registerTaskCapableTool(server, {
      name: toolName,
      parseArguments: () => ({}),
      execute: async (_args, extra) => {
        const reporter = createProgressReporter(extra);
        reporter.report(1, 'Done', 1);
        setTimeout(() => {
          reporter.report(2, 'Too late', 2);
        }, 0);
        return {
          content: [{ type: 'text' as const, text: 'ok' }],
        };
      },
      taskSupport: 'optional',
    });

    const notifications: ProgressNotification[] = [];

    try {
      registerTaskHandlers(server);

      await handleToolCallRequest(
        server,
        {
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: {},
            _meta: { progressToken: 'tok-inline-lifetime' },
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

      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]?.params.progress, 1);
      assert.equal(
        notifications[0]?.params.progressToken,
        'tok-inline-lifetime'
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
      registerTaskHandlers(server);

      const createTask = (await handleToolCallRequest(
        server,
        {
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: {},
            _meta: {
              progressToken: 'tok-task',
              'modelcontextprotocol.io/task': {
                taskId: 'test-notif',
                keepAlive: 5_000,
              },
            },
          },
        },
        {
          ownerKey: 'default',
          sendNotification: async (notification) => {
            notifications.push(notification);
          },
        }
      )) as { task: { taskId: string } };

      await waitForTaskSnapshot(
        server,
        createTask.task.taskId,
        (task) => task['status'] === 'completed'
      );

      const task = getTaskDirect(createTask.task.taskId);
      const result = task.result as {
        content: Array<{ type: string; text: string }>;
      };

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

  it('accepts numeric progress tokens and floating-point progress without closing early at total', async () => {
    const server = createTaskTestServer();
    const toolName = `task-progress-float-tool-${randomUUID()}`;

    registerTaskCapableTool(server, {
      name: toolName,
      parseArguments: () => ({}),
      execute: async (_args, extra) => {
        const reporter = createProgressReporter(extra);
        reporter.report(0.5, 'Halfway through phase one', 0.5);
        await setTimeoutPromise(125);
        reporter.report(1.5, 'Still running after the first total', 1.5);
        return {
          content: [{ type: 'text' as const, text: 'done' }],
        };
      },
      taskSupport: 'optional',
    });

    const notifications: ProgressNotification[] = [];

    try {
      registerTaskHandlers(server);

      const createTask = (await handleToolCallRequest(
        server,
        {
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: {},
            _meta: {
              progressToken: 7,
              'modelcontextprotocol.io/task': {
                taskId: 'test-abort',
                keepAlive: 5_000,
              },
            },
          },
        },
        {
          ownerKey: 'default',
          sendNotification: async (notification) => {
            notifications.push(notification);
          },
        }
      )) as { task: { taskId: string } };

      await waitForTaskSnapshot(
        server,
        createTask.task.taskId,
        (task) => task['status'] === 'completed'
      );

      const task = getTaskDirect(createTask.task.taskId);
      assert.equal(task.status, 'completed');

      await setTimeoutPromise(250);

      assert.equal(notifications.length, 2);
      assert.deepEqual(
        notifications.map((notification) => notification.params.progress),
        [0.5, 1.5]
      );
      assert.deepEqual(
        notifications.map((notification) => notification.params.total),
        [0.5, 1.5]
      );
      assert.ok(
        notifications.every(
          (notification) => notification.params.progressToken === 7
        )
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
      registerTaskHandlers(server);

      const createTask = (await handleToolCallRequest(
        server,
        {
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: {},
            _meta: {
              progressToken: 'tok-state',
              'modelcontextprotocol.io/task': {
                taskId: 'test-state',
                keepAlive: 5_000,
              },
            },
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
      await waitForTaskSnapshot(
        server,
        createTask.task.taskId,
        (task) => task['status'] === 'completed'
      );

      const completedTask = getTaskDirect(createTask.task.taskId);
      assert.equal(completedTask.status, 'completed');
    } finally {
      unregisterTaskCapableTool(server, toolName);
      await server.close();
    }
  });
});

describe('task result availability', () => {
  it('rejects tasks/result for a task that has not completed yet', async () => {
    const server = createTaskTestServer();
    const toolName = `task-result-working-tool-${randomUUID()}`;
    const gate = createDeferred();

    registerTaskCapableTool(server, {
      name: toolName,
      parseArguments: () => ({}),
      execute: async () => {
        await gate.promise;
        return {
          content: [{ type: 'text' as const, text: 'done' }],
        };
      },
      taskSupport: 'optional',
    });

    try {
      registerTaskHandlers(server);

      const taskResult = (await handleToolCallRequest(
        server,
        {
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: {},
            _meta: {
              'modelcontextprotocol.io/task': {
                taskId: 'working-task',
                keepAlive: 5_000,
              },
            },
          },
        },
        { ownerKey: 'default' }
      )) as { task: { taskId: string } };

      const task = getTaskDirect(taskResult.task.taskId);
      assert.equal(task.status, 'working');
      assert.equal(task.result, undefined);
    } finally {
      gate.resolve();
      unregisterTaskCapableTool(server, toolName);
      await server.close();
    }
  });
});

describe('task result failure normalization', () => {
  it('rejects tasks/result for failed tool error results', async () => {
    const server = createTaskTestServer();
    const toolName = `failed-result-task-tool-${randomUUID()}`;

    registerTaskCapableTool(server, {
      name: toolName,
      parseArguments: () => ({}),
      execute: async () => ({
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: 'tool reported failure',
              url: 'https://example.com/failure',
            }),
          },
        ],
      }),
      taskSupport: 'optional',
    });

    try {
      registerTaskHandlers(server);

      const taskResult = (await handleToolCallRequest(
        server,
        {
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: {},
            _meta: {
              'modelcontextprotocol.io/task': {
                taskId: 'test-fail-result',
                keepAlive: 1_000,
              },
            },
          },
        },
        { ownerKey: 'default' }
      )) as { task: { taskId: string } };

      await waitForTaskSnapshot(
        server,
        taskResult.task.taskId,
        (task) => task['status'] === 'failed'
      );

      const task = getTaskDirect(taskResult.task.taskId);
      assert.equal(task.status, 'failed');
      assert.ok(task.statusMessage?.includes('tool reported failure'));
    } finally {
      unregisterTaskCapableTool(server, toolName);
      await server.close();
    }
  });

  it('replays a JSON-RPC error when a background tool throws', async () => {
    const server = createTaskTestServer();
    const toolName = `failing-task-tool-${randomUUID()}`;

    registerTaskCapableTool(server, {
      name: toolName,
      parseArguments: () => ({}),
      execute: async () => {
        throw Error('boom');
      },
      taskSupport: 'optional',
    });

    try {
      registerTaskHandlers(server);

      const taskResult = (await handleToolCallRequest(
        server,
        {
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: {},
            _meta: {
              'modelcontextprotocol.io/task': {
                taskId: 'test-fail-1',
                keepAlive: 1_000,
              },
            },
          },
        },
        { ownerKey: 'default' }
      )) as { task: { taskId: string } };

      await waitForTaskSnapshot(
        server,
        taskResult.task.taskId,
        (task) => task['status'] === 'failed'
      );

      const task = getTaskDirect(taskResult.task.taskId);
      assert.equal(task.status, 'failed');
      assert.ok(task.statusMessage?.includes('boom'));
      assert.ok(task.error);
      assert.equal(task.error.code, ProtocolErrorCode.InternalError);
    } finally {
      unregisterTaskCapableTool(server, toolName);
      await server.close();
    }
  });

  it('preserves ProtocolError code and data for background failures', async () => {
    const server = createTaskTestServer();
    const toolName = `mcp-error-task-tool-${randomUUID()}`;

    registerTaskCapableTool(server, {
      name: toolName,
      parseArguments: () => ({}),
      execute: async () => {
        const error = new ProtocolError(
          ProtocolErrorCode.InternalError,
          'broken',
          {
            reason: 'test',
          }
        );
        throw error;
      },
      taskSupport: 'optional',
    });

    try {
      registerTaskHandlers(server);

      const taskResult = (await handleToolCallRequest(
        server,
        {
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: {},
            _meta: {
              'modelcontextprotocol.io/task': {
                taskId: 'test-fail-2',
                keepAlive: 1_000,
              },
            },
          },
        },
        { ownerKey: 'default' }
      )) as { task: { taskId: string } };

      await waitForTaskSnapshot(
        server,
        taskResult.task.taskId,
        (task) => task['status'] === 'failed'
      );

      const task = getTaskDirect(taskResult.task.taskId);
      assert.equal(task.status, 'failed');
      assert.ok(task.statusMessage?.includes('broken'));
      assert.ok(task.error);
      assert.equal(task.error.code, ProtocolErrorCode.InternalError);
      assert.deepEqual(task.error.data, { reason: 'test' });
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
      registerTaskHandlers(server);

      const taskResult = (await handleToolCallRequest(
        server,
        {
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: {},
            _meta: {
              'modelcontextprotocol.io/task': {
                taskId: 'test-cancel',
                keepAlive: 5_000,
              },
            },
          },
        },
        { ownerKey: 'default' }
      )) as { task: { taskId: string } };

      // Cancel the task
      cancelTaskDirect(taskResult.task.taskId);

      const task = getTaskDirect(taskResult.task.taskId);
      assert.equal(task.status, 'cancelled');
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
      registerTaskHandlers(server);

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
          err instanceof ProtocolError &&
          err.code === ProtocolErrorCode.MethodNotFound
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
      registerTaskHandlers(server);

      const result = (await handleToolCallRequest(
        server,
        {
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: {},
            _meta: {
              'modelcontextprotocol.io/task': {
                taskId: 'test-imm-yes',
                keepAlive: 5_000,
              },
            },
          },
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
      registerTaskHandlers(server);

      const result = (await handleToolCallRequest(
        server,
        {
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: {},
            _meta: {
              'modelcontextprotocol.io/task': {
                taskId: 'test-imm-no',
                keepAlive: 5_000,
              },
            },
          },
        },
        { ownerKey: 'default' }
      )) as {
        task: { taskId: string };
        _meta?: Record<string, unknown>;
      };

      assert.ok(result.task.taskId);
    } finally {
      unregisterTaskCapableTool(server, toolName);
      await server.close();
    }
  });
});

describe('tasks/delete handler', () => {
  it('deletes a completed task', async () => {
    const server = createTaskTestServer();
    const toolName = `del-tool-${randomUUID()}`;

    registerTaskCapableTool(server, {
      name: toolName,
      parseArguments: () => ({}),
      execute: async () => ({
        content: [{ type: 'text' as const, text: 'ok' }],
      }),
      taskSupport: 'optional',
    });

    try {
      registerTaskHandlers(server);

      const taskResult = (await handleToolCallRequest(
        server,
        {
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: {},
            _meta: {
              'modelcontextprotocol.io/task': {
                taskId: 'test-del-ok',
                keepAlive: 5_000,
              },
            },
          },
        },
        { ownerKey: 'default' }
      )) as { task: { taskId: string } };

      await waitForTaskSnapshot(
        server,
        taskResult.task.taskId,
        (task) => task['status'] === 'completed'
      );

      // Verify task is completed
      const task = getTaskDirect(taskResult.task.taskId);
      assert.equal(task.status, 'completed');

      // Delete the terminal task
      const deleteHandler = getDeleteHandler(server);
      const deleteResult = await deleteHandler(
        { method: 'tasks/delete', params: { taskId: taskResult.task.taskId } },
        undefined
      );
      assert.deepEqual(deleteResult, {});

      // Verify task is gone
      const deleted = taskManager.getTask(taskResult.task.taskId);
      assert.equal(deleted, undefined);
    } finally {
      unregisterTaskCapableTool(server, toolName);
      await server.close();
    }
  });

  it('rejects deletion of a non-terminal task', async () => {
    const server = createTaskTestServer();
    const toolName = `del-reject-tool-${randomUUID()}`;

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
      registerTaskHandlers(server);

      const taskResult = (await handleToolCallRequest(
        server,
        {
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: {},
            _meta: {
              'modelcontextprotocol.io/task': {
                taskId: 'test-del-reject',
                keepAlive: 5_000,
              },
            },
          },
        },
        { ownerKey: 'default' }
      )) as { task: { taskId: string } };

      const deleteHandler = getDeleteHandler(server);
      await assert.rejects(
        async () =>
          deleteHandler(
            {
              method: 'tasks/delete',
              params: { taskId: taskResult.task.taskId },
            },
            undefined
          ),
        (err: unknown) =>
          err instanceof ProtocolError &&
          err.code === ProtocolErrorCode.InvalidParams
      );

      // Clean up by cancelling
      cancelTaskDirect(taskResult.task.taskId);
    } finally {
      unregisterTaskCapableTool(server, toolName);
      await server.close();
    }
  });
});

describe('task creation uses client-provided ID', () => {
  it('returns a task with the client-provided taskId', async () => {
    const server = createTaskTestServer();
    const toolName = `submitted-status-tool-${randomUUID()}`;

    registerTaskCapableTool(server, {
      name: toolName,
      parseArguments: () => ({}),
      execute: async () => ({
        content: [{ type: 'text' as const, text: 'ok' }],
      }),
      taskSupport: 'optional',
    });

    try {
      registerTaskHandlers(server);

      const taskResult = (await handleToolCallRequest(
        server,
        {
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: {},
            _meta: {
              'modelcontextprotocol.io/task': {
                taskId: 'test-submitted',
                keepAlive: 5_000,
              },
            },
          },
        },
        { ownerKey: 'default' }
      )) as { task: { taskId: string; status: string } };

      assert.equal(taskResult.task.taskId, 'test-submitted');
    } finally {
      unregisterTaskCapableTool(server, toolName);
      await server.close();
    }
  });
});
