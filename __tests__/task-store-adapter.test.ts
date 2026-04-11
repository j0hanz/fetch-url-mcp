import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { setTimeout as setTimeoutPromise } from 'node:timers/promises';

import {
  registerMcpSessionOwnerKey,
  unregisterMcpSessionServer,
} from '../src/lib/core.js';
import { TaskStoreAdapter } from '../src/tasks/adapter.js';
import { taskManager } from '../src/tasks/store.js';

const adapter = new TaskStoreAdapter();

function cleanupTask(taskId: string, ownerKey?: string): void {
  try {
    if (ownerKey) {
      taskManager.deleteTask(taskId, ownerKey);
      return;
    }
    taskManager.cancelTask(taskId);
  } catch {
    // Ignore cleanup failures in tests.
  }
}

afterEach(() => {
  unregisterMcpSessionServer('sess-a');
  unregisterMcpSessionServer('sess-b');
});

describe('TaskStoreAdapter', () => {
  it('uses ttl, pollInterval, context, requestId, and request metadata on createTask', async () => {
    const task = await adapter.createTask(
      {
        ttl: null,
        pollInterval: 2_500,
        context: { ownerKey: 'owner-from-context', trace: 'abc' },
      },
      'req-1',
      {
        method: 'tools/call',
        params: {
          _meta: { progressToken: 'tok-1' },
        },
      }
    );

    try {
      assert.equal(task.ttl, null);
      assert.equal(task.pollInterval, 2_500);

      const state = taskManager.getTask(task.taskId, 'owner-from-context');
      assert.ok(state);
      assert.equal(state.keepAlive, null);
      assert.equal(state.pollFrequency, 2_500);
      assert.equal(state.requestId, 'req-1');
      assert.equal(state.requestMethod, 'tools/call');
      assert.deepEqual(state.requestMeta, { progressToken: 'tok-1' });
      assert.deepEqual(state.context, {
        ownerKey: 'owner-from-context',
        trace: 'abc',
      });
    } finally {
      cleanupTask(task.taskId, 'owner-from-context');
    }
  });

  it('uses the registered session owner for get/list/result operations', async () => {
    registerMcpSessionOwnerKey('sess-a', 'auth:owner-a');

    const task = await adapter.createTask(
      { ttl: 5_000 },
      'req-2',
      { method: 'tools/call', params: {} },
      'sess-a'
    );

    try {
      await adapter.storeTaskResult(
        task.taskId,
        'completed',
        {
          content: [{ type: 'text', text: 'done' }],
        },
        'sess-a'
      );

      const fetched = await adapter.getTask(task.taskId, 'sess-a');
      assert.equal(fetched?.taskId, task.taskId);

      const listed = await adapter.listTasks(undefined, 'sess-a');
      assert.ok(listed.tasks.some((entry) => entry.taskId === task.taskId));

      const result = await adapter.getTaskResult(task.taskId, 'sess-a');
      assert.deepEqual(result, {
        content: [{ type: 'text', text: 'done' }],
        _meta: {
          'io.modelcontextprotocol/related-task': {
            taskId: task.taskId,
          },
        },
      });
    } finally {
      cleanupTask(task.taskId, 'auth:owner-a');
    }
  });

  it('waits for a pending task result before resolving', async () => {
    registerMcpSessionOwnerKey('sess-a', 'auth:owner-a');

    const task = await adapter.createTask(
      { ttl: 5_000 },
      'req-4',
      { method: 'tools/call', params: {} },
      'sess-a'
    );

    try {
      const pendingResult = adapter.getTaskResult(task.taskId, 'sess-a');

      await setTimeoutPromise(10);
      await adapter.storeTaskResult(
        task.taskId,
        'completed',
        {
          content: [{ type: 'text', text: 'delayed' }],
        },
        'sess-a'
      );

      const result = await pendingResult;
      assert.deepEqual(result, {
        content: [{ type: 'text', text: 'delayed' }],
        _meta: {
          'io.modelcontextprotocol/related-task': {
            taskId: task.taskId,
          },
        },
      });
    } finally {
      cleanupTask(task.taskId, 'auth:owner-a');
    }
  });

  it('returns a terminal cancelled payload when a task is cancelled', async () => {
    registerMcpSessionOwnerKey('sess-a', 'auth:owner-a');

    const task = await adapter.createTask(
      { ttl: 5_000 },
      'req-5',
      { method: 'tools/call', params: {} },
      'sess-a'
    );

    try {
      await adapter.updateTaskStatus(
        task.taskId,
        'cancelled',
        'The task was cancelled by request.',
        'sess-a'
      );

      const result = await adapter.getTaskResult(task.taskId, 'sess-a');
      assert.deepEqual(result, {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'The task was cancelled by request.',
              taskId: task.taskId,
              status: 'cancelled',
              code: -32000,
              data: {
                code: 'ABORTED',
                sdkCode: 'CONNECTION_CLOSED',
              },
            }),
          },
        ],
        isError: true,
        _meta: {
          'io.modelcontextprotocol/related-task': {
            taskId: task.taskId,
          },
        },
      });
    } finally {
      cleanupTask(task.taskId, 'auth:owner-a');
    }
  });

  it('does not expose a task to a different session owner', async () => {
    registerMcpSessionOwnerKey('sess-a', 'auth:owner-a');
    registerMcpSessionOwnerKey('sess-b', 'auth:owner-b');

    const task = await adapter.createTask(
      { ttl: 5_000 },
      'req-3',
      { method: 'tools/call', params: {} },
      'sess-a'
    );

    try {
      const fetched = await adapter.getTask(task.taskId, 'sess-b');
      assert.equal(fetched, null);

      const listed = await adapter.listTasks(undefined, 'sess-b');
      assert.equal(
        listed.tasks.some((entry) => entry.taskId === task.taskId),
        false
      );
    } finally {
      cleanupTask(task.taskId, 'auth:owner-a');
    }
  });
});
