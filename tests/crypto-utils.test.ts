import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { sha256Hex, timingSafeEqualUtf8 } from '../dist/crypto.js';

describe('timingSafeEqualUtf8', () => {
  it('returns true for identical strings', () => {
    assert.equal(timingSafeEqualUtf8('token', 'token'), true);
  });

  it('returns false without throwing on byte-length mismatch', () => {
    assert.doesNotThrow(() => timingSafeEqualUtf8('a', '\u00E9'));
    assert.equal(timingSafeEqualUtf8('a', '\u00E9'), false);
  });
});

describe('sha256Hex', () => {
  it('matches createHash output for small inputs', () => {
    const input = 'hello';
    const expected = createHash('sha256').update(input).digest('hex');
    assert.equal(sha256Hex(input), expected);
  });

  it('matches createHash output for large inputs', () => {
    const fiveMb = 5 * 1024 * 1024;
    const input = 'a'.repeat(fiveMb + 1);
    const expected = createHash('sha256').update(input).digest('hex');
    assert.equal(sha256Hex(input), expected);
  });
});
