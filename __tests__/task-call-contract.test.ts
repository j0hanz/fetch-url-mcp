import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildRelatedTaskMeta,
  sanitizeToolCallMeta,
  withRelatedTaskMeta,
} from '../src/tasks/manager.js';

function getRelatedTaskId(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const taskId = (value as Record<string, unknown>)['taskId'];
  return typeof taskId === 'string' ? taskId : undefined;
}

// ── sanitizeToolCallMeta ────────────────────────────────────────────

describe('sanitizeToolCallMeta', () => {
  it('returns undefined for undefined input', () => {
    assert.equal(sanitizeToolCallMeta(undefined), undefined);
  });

  it('strips io.modelcontextprotocol/related-task key', () => {
    const meta = {
      progressToken: 'tok-1',
      'io.modelcontextprotocol/related-task': { taskId: 'x' },
    };
    const result = sanitizeToolCallMeta(meta);
    assert.equal(result?.progressToken, 'tok-1');
    assert.equal(result?.['io.modelcontextprotocol/related-task'], undefined);
  });

  it('returns undefined when only related-task key exists', () => {
    const meta = {
      'io.modelcontextprotocol/related-task': { taskId: 'x' },
    };
    assert.equal(sanitizeToolCallMeta(meta), undefined);
  });
});

// ── buildRelatedTaskMeta ────────────────────────────────────────────

describe('buildRelatedTaskMeta', () => {
  it('builds meta with related-task entry', () => {
    const result = buildRelatedTaskMeta('task-123');
    assert.deepEqual(result['io.modelcontextprotocol/related-task'], {
      taskId: 'task-123',
    });
  });

  it('preserves existing meta keys', () => {
    const result = buildRelatedTaskMeta('task-123', {
      progressToken: 'tok-x',
    });
    assert.equal(result['progressToken'], 'tok-x');
    assert.deepEqual(result['io.modelcontextprotocol/related-task'], {
      taskId: 'task-123',
    });
  });

  it('strips incoming related-task from base meta', () => {
    const result = buildRelatedTaskMeta('task-new', {
      progressToken: 'tok-1',
      'io.modelcontextprotocol/related-task': { taskId: 'task-old' },
    });
    assert.deepEqual(result['io.modelcontextprotocol/related-task'], {
      taskId: 'task-new',
    });
  });
});

// ── withRelatedTaskMeta ─────────────────────────────────────────────

describe('withRelatedTaskMeta', () => {
  it('adds related-task _meta to a result', () => {
    const original = {
      content: [{ type: 'text' as const, text: 'ok' }],
    };
    const result = withRelatedTaskMeta(original, 'task-456');
    assert.deepEqual(result._meta?.['io.modelcontextprotocol/related-task'], {
      taskId: 'task-456',
    });
  });

  it('preserves existing _meta keys', () => {
    const original = {
      content: [{ type: 'text' as const, text: 'ok' }],
      _meta: { existingKey: 'value' },
    };
    const result = withRelatedTaskMeta(original, 'task-789');
    assert.equal(result._meta?.['existingKey'], 'value');
    assert.deepEqual(result._meta?.['io.modelcontextprotocol/related-task'], {
      taskId: 'task-789',
    });
  });
});
