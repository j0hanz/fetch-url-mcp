import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  fetchUrlInputSchema,
  fetchUrlOutputSchema,
  normalizeExtractedMetadata,
  normalizePageTitle,
} from '../src/schemas.js';

// ── normalizePageTitle ──────────────────────────────────────────────

describe('normalizePageTitle', () => {
  it('returns a valid string trimmed', () => {
    assert.equal(normalizePageTitle('  Hello  '), 'Hello');
  });

  it('returns undefined for empty string', () => {
    assert.equal(normalizePageTitle(''), undefined);
  });

  it('returns undefined for non-string values', () => {
    assert.equal(normalizePageTitle(42), undefined);
    assert.equal(normalizePageTitle(null), undefined);
    assert.equal(normalizePageTitle(undefined), undefined);
  });

  it('returns undefined for whitespace-only string', () => {
    assert.equal(normalizePageTitle('   '), undefined);
  });

  it('truncates excessively long titles', () => {
    const long = 'a'.repeat(600);
    assert.equal(normalizePageTitle(long), undefined);
  });
});

// ── normalizeExtractedMetadata ──────────────────────────────────────

describe('normalizeExtractedMetadata', () => {
  it('returns normalized metadata from valid input', () => {
    const result = normalizeExtractedMetadata({
      title: 'Test Title',
      description: 'A description',
    });
    assert.ok(result);
    assert.equal(result.title, 'Test Title');
    assert.equal(result.description, 'A description');
  });

  it('strips invalid fields', () => {
    const result = normalizeExtractedMetadata({
      title: '',
      author: 'Valid Author',
    });
    assert.ok(result);
    assert.equal(result.title, undefined);
    assert.equal(result.author, 'Valid Author');
  });

  it('returns undefined for completely invalid input', () => {
    assert.equal(normalizeExtractedMetadata(42), undefined);
  });

  it('returns undefined for all-empty fields', () => {
    assert.equal(
      normalizeExtractedMetadata({ title: '', description: '' }),
      undefined
    );
  });

  it('trims whitespace from metadata fields', () => {
    const result = normalizeExtractedMetadata({
      title: '  Trimmed  ',
    });
    assert.ok(result);
    assert.equal(result.title, 'Trimmed');
  });

  it('handles non-string field values', () => {
    const result = normalizeExtractedMetadata({
      title: 123,
      author: true,
    });
    // Non-string values should be dropped
    assert.equal(result, undefined);
  });
});

// ── fetchUrlInputSchema ────────────────────────────────────────────

describe('fetchUrlInputSchema', () => {
  it('accepts a valid URL-only input', () => {
    const result = fetchUrlInputSchema.parse({
      url: 'https://example.com',
    });

    assert.equal(result.url, 'https://example.com');
  });
});

describe('fetchUrlOutputSchema', () => {
  it('accepts the full success payload shape returned by fetch-url', () => {
    const result = fetchUrlOutputSchema.parse({
      url: 'https://example.com',
      inputUrl: 'https://example.com',
      resolvedUrl: 'https://example.com',
      markdown: '# Example',
      fetchedAt: '2026-03-27T12:00:00.000Z',
      contentSize: 9,
    });

    assert.equal(result.markdown, '# Example');
    assert.equal(result.contentSize, 9);
  });

  it('requires markdown, fetchedAt, contentSize, inputUrl, and resolvedUrl', () => {
    const result = fetchUrlOutputSchema.safeParse({
      url: 'https://example.com',
    });

    assert.equal(result.success, false);
  });
});
