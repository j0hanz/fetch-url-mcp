import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { composeCloseHandlers } from '../dist/lib/session.js';

describe('composeCloseHandlers', () => {
  it('invokes both handlers in order when both are defined', () => {
    const calls: string[] = [];
    const first = () => calls.push('first');
    const second = () => calls.push('second');

    const composed = composeCloseHandlers(first, second);
    assert.equal(typeof composed, 'function');

    composed?.();
    assert.deepEqual(calls, ['first', 'second']);
  });

  it('runs second even if first throws', () => {
    const calls: string[] = [];
    const first = () => {
      calls.push('first');
      throw new Error('boom');
    };
    const second = () => calls.push('second');

    const composed = composeCloseHandlers(first, second);

    assert.throws(() => composed?.(), /boom/);
    assert.deepEqual(calls, ['first', 'second']);
  });

  it('returns the defined handler when the other is undefined', () => {
    const calls: string[] = [];
    const handler = () => calls.push('only');

    assert.equal(composeCloseHandlers(undefined, handler), handler);
    assert.equal(composeCloseHandlers(handler, undefined), handler);

    handler();
    assert.deepEqual(calls, ['only']);
  });
});
