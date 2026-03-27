import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildRelatedTaskMeta,
  parseExtendedCallToolRequest,
  sanitizeToolCallMeta,
  withRelatedTaskMeta,
} from '../dist/tasks/call-contract.js';

function getRelatedTaskId(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const taskId = (value as Record<string, unknown>)['taskId'];
  return typeof taskId === 'string' ? taskId : undefined;
}

// ── Extended tool call request parsing ──────────────────────────────

describe('parseExtendedCallToolRequest', () => {
  it('parses a minimal valid request', () => {
    const request = {
      method: 'tools/call',
      params: { name: 'fetch-url', arguments: { url: 'https://example.com' } },
    };
    const parsed = parseExtendedCallToolRequest(request);
    assert.equal(parsed.params.name, 'fetch-url');
    assert.deepEqual(parsed.params.arguments, {
      url: 'https://example.com',
    });
  });

  it('parses a request with task TTL', () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'fetch-url',
        arguments: {},
        task: { ttl: 30_000 },
      },
    };
    const parsed = parseExtendedCallToolRequest(request);
    assert.equal(parsed.params.task?.ttl, 30_000);
  });

  it('accepts a request without arguments', () => {
    const request = {
      method: 'tools/call',
      params: { name: 'my-tool' },
    };
    const parsed = parseExtendedCallToolRequest(request);
    assert.equal(parsed.params.name, 'my-tool');
    assert.equal(parsed.params.arguments, undefined);
  });

  it('accepts _meta with progressToken', () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'fetch-url',
        _meta: { progressToken: 'tok-1' },
      },
    };
    const parsed = parseExtendedCallToolRequest(request);
    assert.equal(parsed.params._meta?.progressToken, 'tok-1');
  });

  it('accepts _meta with related-task', () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'fetch-url',
        _meta: {
          'io.modelcontextprotocol/related-task': { taskId: 'task-abc' },
        },
      },
    };
    const parsed = parseExtendedCallToolRequest(request);
    assert.equal(
      getRelatedTaskId(
        parsed.params._meta?.['io.modelcontextprotocol/related-task']
      ),
      'task-abc'
    );
  });

  // ── Validation errors ─────────────────────────────────────────

  it('throws for wrong method', () => {
    assert.throws(
      () =>
        parseExtendedCallToolRequest({
          method: 'resources/read',
          params: { name: 'x' },
        }),
      (err: unknown) => err instanceof Error
    );
  });

  it('throws for missing tool name', () => {
    assert.throws(
      () =>
        parseExtendedCallToolRequest({
          method: 'tools/call',
          params: { name: '' },
        }),
      (err: unknown) => err instanceof Error
    );
  });

  it('throws for task TTL below minimum', () => {
    assert.throws(
      () =>
        parseExtendedCallToolRequest({
          method: 'tools/call',
          params: { name: 'x', task: { ttl: 100 } },
        }),
      (err: unknown) => err instanceof Error
    );
  });

  it('throws for task TTL above maximum', () => {
    assert.throws(
      () =>
        parseExtendedCallToolRequest({
          method: 'tools/call',
          params: { name: 'x', task: { ttl: 100_000_000 } },
        }),
      (err: unknown) => err instanceof Error
    );
  });

  it('throws for non-integer task TTL', () => {
    assert.throws(
      () =>
        parseExtendedCallToolRequest({
          method: 'tools/call',
          params: { name: 'x', task: { ttl: 5000.5 } },
        }),
      (err: unknown) => err instanceof Error
    );
  });

  it('throws for non-object input', () => {
    assert.throws(
      () => parseExtendedCallToolRequest('not an object'),
      (err: unknown) => err instanceof Error
    );
  });
});

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
