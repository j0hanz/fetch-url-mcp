import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  hasHeaderEntries,
  headersToRecord,
  normalizeHeaderEntries,
  normalizeHeaderRecord,
} from '../dist/utils/header-normalizer.js';

describe('header-normalizer', () => {
  it('filters blocked headers and preserves values by default', () => {
    const blocked = new Set(['authorization']);
    const normalized = normalizeHeaderEntries(
      {
        Authorization: 'Bearer token',
        Accept: 'text/html',
      },
      blocked
    );

    assert.equal(hasHeaderEntries(normalized), true);
    assert.deepEqual(headersToRecord(normalized), { accept: 'text/html' });
  });

  it('returns undefined when no headers remain after filtering', () => {
    const blocked = new Set(['x-test']);
    const result = normalizeHeaderRecord({ 'X-Test': 'value' }, blocked);
    assert.equal(result, undefined);
  });

  it('trims values when requested', () => {
    const blocked = new Set<string>();
    const normalized = normalizeHeaderEntries(
      {
        'X-Test': ' value ',
      },
      blocked,
      { trimValues: true }
    );

    assert.deepEqual(headersToRecord(normalized), { 'x-test': 'value' });
  });
});
