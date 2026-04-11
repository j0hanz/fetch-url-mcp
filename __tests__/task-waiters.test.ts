import { isTerminal } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getRequestId, runWithRequestContext } from '../src/lib/core.js';
import {
  type TaskStatus,
  TaskWaiterRegistry,
  waitForTerminalTask,
} from '../src/tasks/manager.js';

// ── Helper types ────────────────────────────────────────────────────

interface TestTask {
  taskId: string;
  ownerKey: string;
  status: TaskStatus;
  ttl: number | null;
  _createdAtMs: number;
}

function makeTask(overrides?: Partial<TestTask>): TestTask {
  return {
    taskId: 'task-1',
    ownerKey: 'owner-1',
    status: 'working',
    ttl: 30_000,
    _createdAtMs: Date.now(),
    ...overrides,
  };
}

// ── TaskWaiterRegistry ──────────────────────────────────────────────

describe('TaskWaiterRegistry', () => {
  it('notifies a waiter when task reaches terminal status', () => {
    const registry = new TaskWaiterRegistry<TestTask>(isTerminal);
    let received: TestTask | undefined;

    registry.add('task-1', (task) => {
      received = task;
    });

    const task = makeTask({ status: 'completed' });
    registry.notify(task);

    assert.ok(received);
    assert.equal(received.taskId, 'task-1');
    assert.equal(received.status, 'completed');
  });

  it('does not notify for non-terminal status', () => {
    const registry = new TaskWaiterRegistry<TestTask>(isTerminal);
    let called = false;

    registry.add('task-1', () => {
      called = true;
    });

    registry.notify(makeTask({ status: 'working' }));
    assert.equal(called, false);
  });

  it('notifies multiple waiters for the same task', () => {
    const registry = new TaskWaiterRegistry<TestTask>(isTerminal);
    const calls: string[] = [];

    registry.add('task-1', () => calls.push('a'));
    registry.add('task-1', () => calls.push('b'));

    registry.notify(makeTask({ status: 'failed' }));
    assert.deepEqual(calls, ['a', 'b']);
  });

  it('removes waiters after notification', () => {
    const registry = new TaskWaiterRegistry<TestTask>(isTerminal);
    let count = 0;

    registry.add('task-1', () => {
      count++;
    });

    const task = makeTask({ status: 'completed' });
    registry.notify(task);
    registry.notify(task); // second call — should be no-op.

    assert.equal(count, 1);
  });

  it('remove() unregisters a specific waiter', () => {
    const registry = new TaskWaiterRegistry<TestTask>(isTerminal);
    let called = false;

    const waiter = () => {
      called = true;
    };
    registry.add('task-1', waiter);
    registry.remove('task-1', waiter);

    registry.notify(makeTask({ status: 'completed' }));
    assert.equal(called, false);
  });

  it('remove() is safe with null waiter', () => {
    const registry = new TaskWaiterRegistry<TestTask>(isTerminal);
    assert.doesNotThrow(() => registry.remove('task-1', null));
  });

  it('remove() is safe for unknown taskId', () => {
    const registry = new TaskWaiterRegistry<TestTask>(isTerminal);
    const waiter = () => {};
    assert.doesNotThrow(() => registry.remove('unknown', waiter));
  });
});

// ── waitForTerminalTask ─────────────────────────────────────────────

describe('waitForTerminalTask', () => {
  it('returns immediately if task is already terminal', async () => {
    const registry = new TaskWaiterRegistry<TestTask>(isTerminal);
    const task = makeTask({ status: 'completed' });

    const result = await waitForTerminalTask({
      taskId: 'task-1',
      ownerKey: 'owner-1',
      lookupTask: () => task,
      removeTask: () => {},
      registry,
      isTerminal,
    });

    assert.ok(result);
    assert.equal(result.status, 'completed');
  });

  it('returns undefined if task is not found', async () => {
    const registry = new TaskWaiterRegistry<TestTask>(isTerminal);

    const result = await waitForTerminalTask({
      taskId: 'task-1',
      ownerKey: 'owner-1',
      lookupTask: () => undefined,
      removeTask: () => {},
      registry,
      isTerminal,
    });

    assert.equal(result, undefined);
  });

  it('resolves when task becomes terminal', async () => {
    const registry = new TaskWaiterRegistry<TestTask>(isTerminal);
    const task = makeTask({ status: 'working', ttl: 30_000 });

    const promise = waitForTerminalTask({
      taskId: 'task-1',
      ownerKey: 'owner-1',
      lookupTask: () => task,
      removeTask: () => {},
      registry,
      isTerminal,
    });

    // Simulate the task completing after a short delay.
    queueMicrotask(() => {
      task.status = 'completed';
      registry.notify(task);
    });

    const result = await promise;
    assert.ok(result);
    assert.equal(result.status, 'completed');
  });

  it('rejects on abort signal', async () => {
    const registry = new TaskWaiterRegistry<TestTask>(isTerminal);
    const task = makeTask({ status: 'working', ttl: 30_000 });
    const ac = new AbortController();

    const promise = waitForTerminalTask({
      taskId: 'task-1',
      ownerKey: 'owner-1',
      signal: ac.signal,
      lookupTask: () => task,
      removeTask: () => {},
      registry,
      isTerminal,
    });

    // Abort immediately.
    ac.abort();

    await assert.rejects(promise, (err: unknown) => err instanceof Error);
  });

  // NOTE: When signal is already aborted, waitForTerminalTask() rejects an
  // internal promise but returns void, causing an unhandled rejection.
  // This is a known implementation quirk — tracked separately.

  it('rejects on ttl expiry with short ttl', async () => {
    const registry = new TaskWaiterRegistry<TestTask>(isTerminal);
    const task = makeTask({
      status: 'working',
      ttl: 50, // 50ms — will expire very quickly.
      _createdAtMs: Date.now(),
    });

    let removed = false;
    await assert.rejects(
      waitForTerminalTask({
        taskId: 'task-1',
        ownerKey: 'owner-1',
        lookupTask: () => task,
        removeTask: () => {
          removed = true;
        },
        registry,
        isTerminal,
      }),
      (err: unknown) => err instanceof Error
    );
    assert.equal(removed, true, 'removeTask should be called on expiry');
  });

  it('returns undefined when owner mismatch on notification', async () => {
    const registry = new TaskWaiterRegistry<TestTask>(isTerminal);
    const task = makeTask({ status: 'working', ttl: 30_000 });

    const promise = waitForTerminalTask({
      taskId: 'task-1',
      ownerKey: 'owner-1',
      lookupTask: () => task,
      removeTask: () => {},
      registry,
      isTerminal,
    });

    // Notify with a different ownerKey.
    queueMicrotask(() => {
      const wrongOwnerTask = makeTask({
        status: 'completed',
        ownerKey: 'different-owner',
      });
      registry.notify(wrongOwnerTask);
    });

    const result = await promise;
    assert.equal(result, undefined);
  });

  it('preserves request context when the waiter resolves asynchronously', async () => {
    const registry = new TaskWaiterRegistry<TestTask>(isTerminal);
    const task = makeTask({ status: 'working', ttl: 30_000 });
    let observedRequestId: string | undefined;

    const promise = runWithRequestContext(
      {
        requestId: 'req-task-waiter',
        operationId: 'req-task-waiter',
      },
      async () => {
        const result = await waitForTerminalTask({
          taskId: 'task-1',
          ownerKey: 'owner-1',
          lookupTask: () => task,
          removeTask: () => {},
          registry,
          isTerminal,
        });

        observedRequestId = getRequestId();
        return result;
      }
    );

    queueMicrotask(() => {
      task.status = 'completed';
      registry.notify(task);
    });

    const result = await promise;
    assert.ok(result);
    assert.equal(result.status, 'completed');
    assert.equal(observedRequestId, 'req-task-waiter');
  });
});
