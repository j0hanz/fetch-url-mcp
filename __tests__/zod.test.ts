import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod';

import { formatZodError } from '../src/lib/zod.js';

describe('formatZodError', () => {
  it('formats a single root-level issue', () => {
    const schema = z.string();
    const result = schema.safeParse(42);
    assert.ok(!result.success);
    const message = formatZodError(result.error);
    assert.ok(message.length > 0);
  });

  it('formats a nested path issue', () => {
    const schema = z.object({ name: z.string() });
    const result = schema.safeParse({ name: 123 });
    assert.ok(!result.success);
    const message = formatZodError(result.error);
    assert.ok(message.includes('name'));
  });

  it('formats array index paths', () => {
    const schema = z.array(z.string());
    const result = schema.safeParse(['ok', 42]);
    assert.ok(!result.success);
    const message = formatZodError(result.error);
    assert.ok(message.includes('[1]'));
  });

  it('formats multiple issues with semicolons', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
    });
    const result = schema.safeParse({ name: 123, age: 'old' });
    assert.ok(!result.success);
    const message = formatZodError(result.error);
    assert.ok(message.includes(';'));
  });

  it('deduplicates identical messages', () => {
    const error = new z.ZodError([
      {
        code: 'custom',
        path: [],
        message: 'duplicate',
      },
      {
        code: 'custom',
        path: [],
        message: 'duplicate',
      },
    ]);
    const message = formatZodError(error);
    // Should only contain 'duplicate' once, not twice
    const parts = message.split(';').map((s) => s.trim());
    const unique = new Set(parts);
    assert.equal(parts.length, unique.size);
  });

  it('formats deeply nested paths', () => {
    const schema = z.object({
      config: z.object({
        database: z.object({
          port: z.number(),
        }),
      }),
    });
    const result = schema.safeParse({
      config: { database: { port: 'bad' } },
    });
    assert.ok(!result.success);
    const message = formatZodError(result.error);
    assert.ok(message.includes('config'));
    assert.ok(message.includes('database'));
    assert.ok(message.includes('port'));
  });

  it('falls back to prettifyError when no issues produce text', () => {
    const error = new z.ZodError([
      {
        code: 'custom',
        path: [],
        message: '',
      },
    ]);
    const message = formatZodError(error);
    assert.ok(message.length > 0);
  });
});
