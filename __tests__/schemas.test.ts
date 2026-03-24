import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  normalizeExtractedMetadata,
  normalizePageTitle,
  parseCachedPayload,
  resolveCachedPayloadContent,
} from '../dist/schemas.js';

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

// ── parseCachedPayload ──────────────────────────────────────────────

describe('parseCachedPayload', () => {
  it('parses a valid cached payload', () => {
    const raw = JSON.stringify({ markdown: '# Hello' });
    const result = parseCachedPayload(raw);
    assert.ok(result);
    assert.equal(result.markdown, '# Hello');
  });

  it('parses payload with title and metadata', () => {
    const raw = JSON.stringify({
      markdown: 'Content',
      title: 'Title',
      metadata: { title: 'Meta Title' },
    });
    const result = parseCachedPayload(raw);
    assert.ok(result);
    assert.equal(result.title, 'Title');
    assert.ok(result.metadata);
    assert.equal(result.metadata.title, 'Meta Title');
  });

  it('parses payload with truncated flag', () => {
    const raw = JSON.stringify({ markdown: 'Content', truncated: true });
    const result = parseCachedPayload(raw);
    assert.ok(result);
    assert.equal(result.truncated, true);
  });

  it('returns null for invalid JSON', () => {
    assert.equal(parseCachedPayload('not json'), null);
  });

  it('returns null when markdown is missing', () => {
    const raw = JSON.stringify({ title: 'No Markdown' });
    assert.equal(parseCachedPayload(raw), null);
  });

  it('returns null for non-string markdown', () => {
    const raw = JSON.stringify({ markdown: 42 });
    assert.equal(parseCachedPayload(raw), null);
  });
});

// ── resolveCachedPayloadContent ─────────────────────────────────────

describe('resolveCachedPayloadContent', () => {
  it('returns markdown string when present', () => {
    assert.equal(
      resolveCachedPayloadContent({ markdown: '# Hello' }),
      '# Hello'
    );
  });

  it('returns null when markdown is null', () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
    assert.equal(resolveCachedPayloadContent({ markdown: null } as any), null);
  });

  it('returns null when markdown is undefined', () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
    assert.equal(resolveCachedPayloadContent({} as any), null);
  });

  it('returns empty string for empty markdown', () => {
    assert.equal(resolveCachedPayloadContent({ markdown: '' }), '');
  });
});
