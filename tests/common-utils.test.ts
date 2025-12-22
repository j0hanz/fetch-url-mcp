import { describe, expect, it } from 'vitest';

import {
  createContentMetadataBlock,
  determineContentExtractionSource,
  enforceContentLengthLimit,
} from '../src/tools/utils/common.js';

describe('determineContentExtractionSource', () => {
  it('returns true when extraction is enabled and article exists', () => {
    const result = determineContentExtractionSource(true, {
      content: '<p>content</p>',
      textContent: 'content',
    });
    expect(result).toBe(true);
  });
});

describe('createContentMetadataBlock', () => {
  it('builds metadata when enabled', () => {
    const metadata = createContentMetadataBlock(
      'https://example.com',
      { title: 'Example', content: '', textContent: '' },
      { title: 'Fallback' },
      true,
      true
    );
    expect(metadata?.url).toBe('https://example.com');
    expect(metadata?.title).toBe('Example');
    expect(typeof metadata?.fetchedAt).toBe('string');
  });

  it('returns undefined when metadata is disabled', () => {
    const metadata = createContentMetadataBlock(
      'https://example.com',
      null,
      { title: 'Fallback' },
      false,
      false
    );
    expect(metadata).toBeUndefined();
  });
});

describe('enforceContentLengthLimit', () => {
  it('does not truncate when below the limit', () => {
    const result = enforceContentLengthLimit('hello', 10);
    expect(result.truncated).toBe(false);
    expect(result.content).toBe('hello');
  });

  it('truncates when exceeding the limit', () => {
    const result = enforceContentLengthLimit('hello world', 5);
    expect(result.truncated).toBe(true);
    expect(result.content).toContain('...[truncated]');
  });
});
