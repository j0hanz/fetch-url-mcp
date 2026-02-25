import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeHost } from '../dist/lib/host-normalization.js';

describe('normalizeHost', () => {
  it('lowercases and strips ports', () => {
    assert.equal(normalizeHost('Example.COM:443'), 'example.com');
  });

  it('strips brackets and port from IPv6', () => {
    assert.equal(normalizeHost('[::1]:3000'), '::1');
  });

  it('takes the first comma-separated host', () => {
    assert.equal(normalizeHost(' host1, host2'), 'host1');
  });

  it('returns null for empty input', () => {
    assert.equal(normalizeHost(''), null);
    assert.equal(normalizeHost('   '), null);
  });
});
