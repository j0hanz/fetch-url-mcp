import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { config } from '../dist/lib/core.js';
import { getRequestId, runWithRequestContext } from '../dist/lib/core.js';
import { cancelTasksForOwner } from '../dist/lib/mcp-tools.js';
import { taskManager } from '../dist/tasks/manager.js';

describe('TaskManager.waitForTerminalTask', () => {
  it('resolves undefined after TTL expiration', { timeout: 2000 }, async () => {
    const task = taskManager.createTask(
      { ttl: 30 },
      'Task started',
      'ttl-test'
    );

    const result = await taskManager.waitForTerminalTask(
      task.taskId,
      'ttl-test'
    );

    assert.equal(result, undefined);
  });

  it('preserves async request context when resolving', async () => {
    const ownerKey = `context-resolve-${Date.now()}`;
    const task = taskManager.createTask(
      { ttl: 2_000 },
      'Task started',
      ownerKey
    );

    const contextRequestId = await runWithRequestContext(
      { requestId: 'ctx-task-request', operationId: 'ctx-task-operation' },
      async () => {
        const waitPromise = taskManager.waitForTerminalTask(
          task.taskId,
          ownerKey
        );

        setImmediate(() => {
          taskManager.updateTask(task.taskId, {
            status: 'completed',
            result: { ok: true },
          });
        });

        await waitPromise;
        return getRequestId();
      }
    );

    assert.equal(contextRequestId, 'ctx-task-request');
  });
});

describe('TaskManager.listTasks cursor', () => {
  it('paginates using nextCursor', () => {
    const ownerKey = `cursor-test-${Date.now()}`;

    taskManager.createTask(undefined, 'Task 1', ownerKey);
    taskManager.createTask(undefined, 'Task 2', ownerKey);
    taskManager.createTask(undefined, 'Task 3', ownerKey);

    const page1 = taskManager.listTasks({ ownerKey, limit: 2 });
    assert.equal(page1.tasks.length, 2);
    assert.equal(typeof page1.nextCursor, 'string');
    assert.ok(page1.nextCursor);

    const page2 = taskManager.listTasks({
      ownerKey,
      limit: 2,
      cursor: page1.nextCursor,
    });
    assert.equal(page2.tasks.length, 1);
    assert.equal(page2.nextCursor, undefined);
  });

  it('rejects invalid cursors', () => {
    const ownerKey = `cursor-invalid-${Date.now()}`;
    taskManager.createTask(undefined, 'Task 1', ownerKey);

    assert.throws(
      () => taskManager.listTasks({ ownerKey, cursor: '!!!!', limit: 1 }),
      (err: unknown) =>
        err instanceof Error && err.message.toLowerCase().includes('cursor')
    );

    assert.throws(
      () =>
        taskManager.listTasks({
          ownerKey,
          cursor: 'abcd=ef',
          limit: 1,
        }),
      (err: unknown) =>
        err instanceof Error && err.message.toLowerCase().includes('cursor')
    );

    const tooLong = 'a'.repeat(300);
    assert.throws(
      () => taskManager.listTasks({ ownerKey, cursor: tooLong, limit: 1 }),
      (err: unknown) =>
        err instanceof Error && err.message.toLowerCase().includes('cursor')
    );
  });
});

describe('TaskManager.createTask ttl normalization', () => {
  it('enforces minimum and maximum ttl bounds', () => {
    const ownerKey = `ttl-bounds-${Date.now()}`;
    const belowMin = taskManager.createTask(
      { ttl: 1 },
      'Task started',
      ownerKey
    );
    const aboveMax = taskManager.createTask(
      { ttl: 999_999_999 },
      'Task started',
      ownerKey
    );

    assert.equal(belowMin.ttl, 1_000);
    assert.equal(aboveMax.ttl, 86_400_000);
  });

  it('enforces per-owner task capacity', () => {
    const originalMaxPerOwner = config.tasks.maxPerOwner;
    const originalMaxTotal = config.tasks.maxTotal;
    const ownerKey = `capacity-owner-${Date.now()}`;

    config.tasks.maxPerOwner = 1;
    config.tasks.maxTotal = Math.max(originalMaxTotal, 2);

    try {
      taskManager.createTask(undefined, 'Task 1', ownerKey);

      assert.throws(
        () => taskManager.createTask(undefined, 'Task 2', ownerKey),
        (error: unknown) =>
          error instanceof Error &&
          error.message.toLowerCase().includes('capacity')
      );
    } finally {
      config.tasks.maxPerOwner = originalMaxPerOwner;
      config.tasks.maxTotal = originalMaxTotal;
    }
  });
});

describe('TaskManager.updateTask terminal behavior', () => {
  it('does not mutate terminal tasks', () => {
    const ownerKey = `terminal-freeze-${Date.now()}`;
    const task = taskManager.createTask(undefined, 'Task started', ownerKey);

    taskManager.updateTask(task.taskId, {
      status: 'completed',
      statusMessage: 'Completed',
      result: { ok: true },
    });

    taskManager.updateTask(task.taskId, {
      statusMessage: 'Mutated',
      error: { code: -1, message: 'Unexpected' },
    });

    const updated = taskManager.getTask(task.taskId, ownerKey);
    assert.ok(updated);
    assert.equal(updated.status, 'completed');
    assert.equal(updated.statusMessage, 'Completed');
    assert.equal(
      (updated.error as { code?: number } | undefined)?.code,
      undefined
    );
  });
});

describe('TaskManager owner capacity accounting', () => {
  it('does not undercount after cancelled tasks expire', async () => {
    const originalMaxPerOwner = config.tasks.maxPerOwner;
    const originalMaxTotal = config.tasks.maxTotal;
    const ownerKey = `owner-count-drift-${Date.now()}`;

    config.tasks.maxPerOwner = 1;
    config.tasks.maxTotal = Math.max(originalMaxTotal, 3);

    try {
      const first = taskManager.createTask({ ttl: 40 }, 'Task 1', ownerKey);
      taskManager.cancelTask(first.taskId, ownerKey);

      const second = taskManager.createTask({ ttl: 2_000 }, 'Task 2', ownerKey);
      assert.equal(
        taskManager.getTask(second.taskId, ownerKey)?.status,
        'working'
      );

      await new Promise((resolve) => setTimeout(resolve, 80));
      // Trigger lazy cleanup for the expired cancelled task.
      taskManager.getTask(first.taskId, ownerKey);

      assert.throws(
        () => taskManager.createTask(undefined, 'Task 3', ownerKey),
        (error: unknown) =>
          error instanceof Error &&
          error.message.toLowerCase().includes('capacity')
      );
    } finally {
      config.tasks.maxPerOwner = originalMaxPerOwner;
      config.tasks.maxTotal = originalMaxTotal;
    }
  });
});

describe('cancelTasksForOwner', () => {
  it('cancels only active tasks for the specified owner', () => {
    const ownerKey = `session:test-owner-${Date.now()}`;
    const otherOwnerKey = `${ownerKey}-other`;

    const activeTask = taskManager.createTask(
      undefined,
      'Active task',
      ownerKey
    );
    const completedTask = taskManager.createTask(
      undefined,
      'Completed task',
      ownerKey
    );
    const otherOwnerTask = taskManager.createTask(
      undefined,
      'Other owner task',
      otherOwnerKey
    );

    taskManager.updateTask(completedTask.taskId, {
      status: 'completed',
      result: { ok: true },
    });

    const cancelledCount = cancelTasksForOwner(ownerKey, 'The session ended.');

    assert.equal(cancelledCount, 1);
    assert.equal(
      taskManager.getTask(activeTask.taskId, ownerKey)?.status,
      'cancelled'
    );
    assert.equal(
      taskManager.getTask(activeTask.taskId, ownerKey)?.statusMessage,
      'The session ended.'
    );
    assert.equal(
      taskManager.getTask(completedTask.taskId, ownerKey)?.status,
      'completed'
    );
    assert.equal(
      taskManager.getTask(otherOwnerTask.taskId, otherOwnerKey)?.status,
      'working'
    );
  });
});
