import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { stableStringify } from '../dist/json.js';

describe('stableStringify', () => {
  it('should stringify normal objects with sorted keys', () => {
    const obj = { b: 2, a: 1, c: 3 };
    const result = stableStringify(obj);
    assert.equal(result, '{"a":1,"b":2,"c":3}');
  });

  it('should detect circular references in objects', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj; // Circular ref

    assert.throws(
      () => {
        stableStringify(obj);
      },
      /Circular reference detected/,
      'Expected circular reference error'
    );
  });

  it('should reject deeply nested objects (depth > 20)', () => {
    let deep: Record<string, unknown> = { value: 1 };
    for (let i = 0; i < 25; i++) {
      deep = { nested: deep };
    }

    assert.throws(
      () => {
        stableStringify(deep);
      },
      /Max depth.*exceeded/,
      'Expected max depth error'
    );
  });

  it('should accept objects at max depth (20)', () => {
    let deep: Record<string, unknown> = { value: 1 };
    for (let i = 0; i < 19; i++) {
      deep = { nested: deep };
    }

    const result = stableStringify(deep);
    assert.ok(result.includes('"value":1'), 'Should stringify deep object');
  });

  it('should detect circular refs in arrays', () => {
    const arr: unknown[] = [1, 2];
    arr.push(arr); // Circular

    assert.throws(
      () => {
        stableStringify(arr);
      },
      /Circular reference detected/,
      'Expected circular reference error in array'
    );
  });

  it('should handle primitives', () => {
    assert.equal(stableStringify(42), '42');
    assert.equal(stableStringify('hello'), '"hello"');
    assert.equal(stableStringify(true), 'true');
    assert.equal(stableStringify(null), 'null');
  });

  it('matches JSON stringify omission/null behavior for unsupported values', () => {
    const fn = (): void => {};
    const sym = Symbol('x');
    const value = {
      keep: 1,
      dropUndefined: undefined,
      dropFn: fn,
      dropSymbol: sym,
      arr: [undefined, fn, sym, 1],
    };

    const result = stableStringify(value);

    assert.equal(result, '{"arr":[null,null,null,1],"keep":1}');
  });

  it('treats Date objects as plain objects (no toJSON conversion)', () => {
    const result = stableStringify({
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
    });

    assert.equal(result, '{"createdAt":{}}');
  });

  it('should sort nested object keys', () => {
    const obj = {
      z: { b: 2, a: 1 },
      a: { y: 3, x: 2 },
    };
    const result = stableStringify(obj);
    // Keys should be sorted at every level
    assert.ok(result.includes('"a":{"x":2,"y":3}'));
    assert.ok(result.includes('"z":{"a":1,"b":2}'));
  });
});
