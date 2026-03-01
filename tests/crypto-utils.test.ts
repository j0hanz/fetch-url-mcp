import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  hmacSha256Hex,
  sha256Hex,
  timingSafeEqualUtf8,
} from '../dist/lib/utils.js';

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

describe('hmacSha256Hex', () => {
  it('matches createHmac output', () => {
    const key = 'secret-key';
    const input = 'hello';
    const expected = createHmac('sha256', key).update(input).digest('hex');
    assert.equal(hmacSha256Hex(key, input), expected);
  });
});
