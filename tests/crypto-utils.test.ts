import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { sha256Hex, timingSafeEqualUtf8 } from '../src/utils/crypto.js';

describe('timingSafeEqualUtf8', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeEqualUtf8('token', 'token')).toBe(true);
  });

  it('returns false without throwing on byte-length mismatch', () => {
    expect(() => timingSafeEqualUtf8('a', '\u00E9')).not.toThrow();
    expect(timingSafeEqualUtf8('a', '\u00E9')).toBe(false);
  });
});

describe('sha256Hex', () => {
  it('matches createHash output for small inputs', () => {
    const input = 'hello';
    const expected = createHash('sha256').update(input).digest('hex');
    expect(sha256Hex(input)).toBe(expected);
  });

  it('matches createHash output for large inputs', () => {
    const fiveMb = 5 * 1024 * 1024;
    const input = 'a'.repeat(fiveMb + 1);
    const expected = createHash('sha256').update(input).digest('hex');
    expect(sha256Hex(input)).toBe(expected);
  });
});
