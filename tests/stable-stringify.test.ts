import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { stableStringify } from '../dist/lib/utils.js';

describe('stableStringify', () => {
  it('serializes shared references without treating them as circular', () => {
    const shared = { a: 1 };
    const value = { y: shared, x: shared };

    const result = stableStringify(value);

    assert.equal(result, '{"x":{"a":1},"y":{"a":1}}');
  });

  it('throws on circular references', () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;

    assert.throws(() => stableStringify(obj), /Circular reference/);
  });
});
