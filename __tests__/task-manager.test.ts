import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as setTimeoutPromise } from 'node:timers/promises';

import { config } from '../src/lib/core.js';
import {
  decodeTaskCursor,
  encodeTaskCursor,
  taskManager,
} from '../src/tasks/manager.js';
import type { TaskState } from '../src/tasks/manager.js';

// ── TaskManager ─────────────────────────────────────────────────────

describe('taskManager', () => {
  // Helper to create and cleanup a task in a test scope.
  function createTestTask(ownerKey = 'test-owner', ttl = 10_000): TaskState {
    return taskManager.createTask({ ttl }, 'test task', ownerKey);
  }

  function cleanupTask(taskId: string): void {
    try {
      taskManager.cancelTask(taskId);
    } catch {
      // Already terminal — ignore.
    }
  }

  // ── createTask ──────────────────────────────────────────────────

  describe('createTask', () => {
    it('returns a task with working status', () => {
      const task = createTestTask();
      try {
        assert.equal(task.status, 'working');
        assert.ok(task.taskId);
        assert.ok(task.createdAt);
        assert.ok(task.lastUpdatedAt);
        assert.equal(typeof task.ttl, 'number');
        assert.equal(typeof task.pollInterval, 'number');
      } finally {
        cleanupTask(task.taskId);
      }
    });

    it('assigns a unique taskId per call', () => {
      const a = createTestTask();
      const b = createTestTask();
      try {
        assert.notEqual(a.taskId, b.taskId);
      } finally {
        cleanupTask(a.taskId);
        cleanupTask(b.taskId);
      }
    });

    it('uses the provided ownerKey', () => {
      const task = createTestTask('my-owner');
      try {
        assert.equal(task.ownerKey, 'my-owner');
      } finally {
        cleanupTask(task.taskId);
      }
    });

    it('clamps TTL to minimum (1 000 ms)', () => {
      const task = taskManager.createTask({ ttl: 100 }, 'test', 'ttl-test');
      try {
        assert.ok(task.ttl >= 1_000, `ttl should be >= 1000, got ${task.ttl}`);
      } finally {
        cleanupTask(task.taskId);
      }
    });

    it('clamps TTL to maximum (86 400 000 ms)', () => {
      const task = taskManager.createTask(
        { ttl: 200_000_000 },
        'test',
        'ttl-test'
      );
      try {
        assert.ok(
          task.ttl <= 86_400_000,
          `ttl should be <= 86400000, got ${task.ttl}`
        );
      } finally {
        cleanupTask(task.taskId);
      }
    });

    it('defaults TTL when undefined', () => {
      const task = taskManager.createTask(undefined, 'test', 'ttl-test');
      try {
        assert.equal(task.ttl, 60_000);
      } finally {
        cleanupTask(task.taskId);
      }
    });

    it('retains terminal tasks against owner capacity until they expire', async () => {
      const originalMaxPerOwner = config.tasks.maxPerOwner;
      const ownerKey = `capacity-owner-${Date.now()}`;

      config.tasks.maxPerOwner = 1;
      try {
        const first = taskManager.createTask({ ttl: 1_000 }, 'test', ownerKey);
        taskManager.updateTask(first.taskId, { status: 'completed' });

        assert.throws(
          () => taskManager.createTask({ ttl: 1_000 }, 'test', ownerKey),
          (error: unknown) => error instanceof Error
        );

        await setTimeoutPromise(1_050);
        assert.equal(taskManager.getTask(first.taskId, ownerKey), undefined);

        const second = taskManager.createTask({ ttl: 1_000 }, 'test', ownerKey);
        cleanupTask(second.taskId);
      } finally {
        config.tasks.maxPerOwner = originalMaxPerOwner;
      }
    });
  });

  // ── getTask ─────────────────────────────────────────────────────

  describe('getTask', () => {
    it('retrieves a created task by id', () => {
      const task = createTestTask();
      try {
        const found = taskManager.getTask(task.taskId);
        assert.ok(found);
        assert.equal(found.taskId, task.taskId);
      } finally {
        cleanupTask(task.taskId);
      }
    });

    it('returns undefined for unknown id', () => {
      assert.equal(taskManager.getTask('nonexistent-id'), undefined);
    });

    it('filters by ownerKey when provided', () => {
      const task = createTestTask('owner-a');
      try {
        assert.ok(taskManager.getTask(task.taskId, 'owner-a'));
        assert.equal(taskManager.getTask(task.taskId, 'owner-b'), undefined);
      } finally {
        cleanupTask(task.taskId);
      }
    });
  });

  // ── updateTask ──────────────────────────────────────────────────

  describe('updateTask', () => {
    it('updates statusMessage on a working task', () => {
      const task = createTestTask();
      try {
        taskManager.updateTask(task.taskId, {
          statusMessage: 'halfway there',
        });
        const updated = taskManager.getTask(task.taskId);
        assert.equal(updated?.statusMessage, 'halfway there');
      } finally {
        cleanupTask(task.taskId);
      }
    });

    it('stores numeric progress and total on a working task', () => {
      const task = createTestTask();
      try {
        taskManager.updateTask(task.taskId, {
          progress: 2,
          total: 5,
          statusMessage: 'In progress',
        });
        const updated = taskManager.getTask(task.taskId);
        assert.equal(updated?.progress, 2);
        assert.equal(updated?.total, 5);
        assert.equal(updated?.statusMessage, 'In progress');
      } finally {
        cleanupTask(task.taskId);
      }
    });

    it('transitions to completed', () => {
      const task = createTestTask();
      taskManager.updateTask(task.taskId, {
        status: 'completed',
        result: { hello: 'world' },
      });
      const completed = taskManager.getTask(task.taskId);
      assert.equal(completed?.status, 'completed');
    });

    it('transitions to failed', () => {
      const task = createTestTask();
      taskManager.updateTask(task.taskId, {
        status: 'failed',
        statusMessage: 'boom',
      });
      const failed = taskManager.getTask(task.taskId);
      assert.equal(failed?.status, 'failed');
    });

    it('ignores update for unknown taskId', () => {
      // Should not throw.
      taskManager.updateTask('does-not-exist', {
        statusMessage: 'ignored',
      });
    });

    it('ignores update for already-terminal task', () => {
      const task = createTestTask();
      taskManager.updateTask(task.taskId, { status: 'completed' });
      // Second update should be silently ignored.
      taskManager.updateTask(task.taskId, {
        statusMessage: 'should not apply',
      });
      const t = taskManager.getTask(task.taskId);
      assert.equal(t?.status, 'completed');
    });

    it('transitions to input_required from working', () => {
      const task = createTestTask();
      try {
        taskManager.updateTask(task.taskId, {
          status: 'input_required',
          statusMessage: 'Waiting for user input',
        });
        const updated = taskManager.getTask(task.taskId);
        assert.equal(updated?.status, 'input_required');
        assert.equal(updated?.statusMessage, 'Waiting for user input');
      } finally {
        cleanupTask(task.taskId);
      }
    });

    it('transitions from input_required back to working', () => {
      const task = createTestTask();
      try {
        taskManager.updateTask(task.taskId, { status: 'input_required' });
        taskManager.updateTask(task.taskId, { status: 'working' });
        const updated = taskManager.getTask(task.taskId);
        assert.equal(updated?.status, 'working');
      } finally {
        cleanupTask(task.taskId);
      }
    });

    it('transitions from input_required to completed', () => {
      const task = createTestTask();
      taskManager.updateTask(task.taskId, { status: 'input_required' });
      taskManager.updateTask(task.taskId, { status: 'completed' });
      assert.equal(taskManager.getTask(task.taskId)?.status, 'completed');
    });

    it('transitions from input_required to failed', () => {
      const task = createTestTask();
      taskManager.updateTask(task.taskId, { status: 'input_required' });
      taskManager.updateTask(task.taskId, { status: 'failed' });
      assert.equal(taskManager.getTask(task.taskId)?.status, 'failed');
    });

    it('transitions from input_required to cancelled', () => {
      const task = createTestTask();
      taskManager.updateTask(task.taskId, { status: 'input_required' });
      const cancelled = taskManager.cancelTask(task.taskId);
      assert.equal(cancelled?.status, 'cancelled');
    });
  });

  // ── cancelTask ──────────────────────────────────────────────────

  describe('cancelTask', () => {
    it('cancels a working task', () => {
      const task = createTestTask();
      const cancelled = taskManager.cancelTask(task.taskId);
      assert.ok(cancelled);
      assert.equal(cancelled.status, 'cancelled');
    });

    it('returns undefined for unknown taskId', () => {
      assert.equal(taskManager.cancelTask('nonexistent'), undefined);
    });

    it('throws when cancelling an already-terminal task', () => {
      const task = createTestTask();
      taskManager.updateTask(task.taskId, { status: 'completed' });
      assert.throws(
        () => taskManager.cancelTask(task.taskId),
        (err: unknown) => err instanceof Error
      );
    });

    it('respects ownerKey filter', () => {
      const task = createTestTask('owner-x');
      assert.equal(taskManager.cancelTask(task.taskId, 'owner-y'), undefined);
      // Should still be cancellable by correct owner.
      const result = taskManager.cancelTask(task.taskId, 'owner-x');
      assert.ok(result);
      assert.equal(result.status, 'cancelled');
    });
  });

  // ── cancelTasksByOwner ──────────────────────────────────────────

  describe('cancelTasksByOwner', () => {
    it('cancels all working tasks for the given owner', () => {
      const a = createTestTask('bulk-owner');
      const b = createTestTask('bulk-owner');
      const other = createTestTask('other-owner');
      try {
        const cancelled = taskManager.cancelTasksByOwner('bulk-owner');
        assert.equal(cancelled.length, 2);
        assert.ok(cancelled.every((t) => t.status === 'cancelled'));
        // The other owner's task should still be working.
        assert.equal(taskManager.getTask(other.taskId)?.status, 'working');
      } finally {
        cleanupTask(a.taskId);
        cleanupTask(b.taskId);
        cleanupTask(other.taskId);
      }
    });

    it('returns empty array for empty ownerKey', () => {
      assert.deepEqual(taskManager.cancelTasksByOwner(''), []);
    });
  });

  // ── listTasks ───────────────────────────────────────────────────

  describe('listTasks', () => {
    it('lists tasks for the specified owner', () => {
      const task = createTestTask('list-owner');
      try {
        const result = taskManager.listTasks({ ownerKey: 'list-owner' });
        assert.ok(result.tasks.length > 0);
        assert.ok(result.tasks.some((t) => t.taskId === task.taskId));
      } finally {
        cleanupTask(task.taskId);
      }
    });

    it('returns empty for unknown owner', () => {
      const result = taskManager.listTasks({
        ownerKey: 'no-such-owner-' + Date.now(),
      });
      assert.equal(result.tasks.length, 0);
    });

    it('throws for a cursor whose anchor task no longer exists', () => {
      const cursor = encodeTaskCursor('missing-anchor-task');

      assert.throws(
        () => taskManager.listTasks({ ownerKey: 'cursor-owner', cursor }),
        (error: unknown) => error instanceof Error
      );
    });
  });

  // ── shrinkTtlAfterDelivery ──────────────────────────────────────

  describe('shrinkTtlAfterDelivery', () => {
    it('reduces TTL on a completed task', () => {
      const task = taskManager.createTask(
        { ttl: 60_000 },
        'test',
        'shrink-owner'
      );
      taskManager.updateTask(task.taskId, { status: 'completed' });
      const before = taskManager.getTask(task.taskId)?.ttl ?? 0;
      taskManager.shrinkTtlAfterDelivery(task.taskId);
      const after = taskManager.getTask(task.taskId)?.ttl ?? 0;
      assert.ok(after <= before, 'TTL should shrink or stay the same');
    });

    it('is a no-op for a working task', () => {
      const task = createTestTask('shrink-owner');
      try {
        const before = task.ttl;
        taskManager.shrinkTtlAfterDelivery(task.taskId);
        const after = taskManager.getTask(task.taskId)?.ttl ?? 0;
        assert.equal(after, before);
      } finally {
        cleanupTask(task.taskId);
      }
    });
  });
});

// ── Cursor encoding / decoding ──────────────────────────────────────

describe('encodeTaskCursor / decodeTaskCursor', () => {
  it('round-trips a valid cursor', () => {
    const cursor = encodeTaskCursor('anchor-id-123');
    const decoded = decodeTaskCursor(cursor);
    assert.ok(decoded);
    assert.equal(decoded.anchorTaskId, 'anchor-id-123');
  });

  it('returns null for empty string', () => {
    assert.equal(decodeTaskCursor(''), null);
  });

  it('returns null for tampered payload', () => {
    const cursor = encodeTaskCursor('anchor-id');
    const [payload, signature] = cursor.split('.');
    assert.ok(payload);
    assert.ok(signature);
    // Tamper with the payload.
    const tampered = `${payload}X.${signature}`;
    assert.equal(decodeTaskCursor(tampered), null);
  });

  it('returns null for tampered signature', () => {
    const cursor = encodeTaskCursor('anchor-id');
    const parts = cursor.split('.');
    assert.ok(parts[0]);
    const tampered = `${parts[0]}.invalidsig`;
    assert.equal(decodeTaskCursor(tampered), null);
  });

  it('returns null for overly long cursor', () => {
    const longCursor = 'a'.repeat(300);
    assert.equal(decodeTaskCursor(longCursor), null);
  });
});
