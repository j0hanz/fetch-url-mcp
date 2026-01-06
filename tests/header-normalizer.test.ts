import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeHeaderRecord } from '../dist/utils/header-normalizer.js';

describe('header-normalizer', () => {
  it('filters blocked headers and preserves values by default', () => {
    const blocked = new Set(['authorization']);
    const normalized = normalizeHeaderRecord(
      {
        Authorization: 'Bearer token',
        Accept: 'text/html',
      },
      blocked
    );

    assert.deepEqual(normalized, { accept: 'text/html' });
  });

  it('returns undefined when no headers remain after filtering', () => {
    const blocked = new Set(['x-test']);
    const result = normalizeHeaderRecord({ 'X-Test': 'value' }, blocked);
    assert.equal(result, undefined);
  });

  it('trims values when requested', () => {
    const blocked = new Set<string>();
    const normalized = normalizeHeaderRecord(
      {
        'X-Test': ' value ',
      },
      blocked,
      { trimValues: true }
    );

    assert.deepEqual(normalized, { 'x-test': 'value' });
  });
});
