import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createContentMetadataBlock,
  determineContentExtractionSource,
  truncateContent,
} from '../dist/tools/utils/content-shaping.js';

describe('determineContentExtractionSource', () => {
  it('returns true when extraction is enabled and article exists', () => {
    const result = determineContentExtractionSource(true, {
      content: '<p>content</p>',
      textContent: 'content',
    });
    assert.equal(result, true);
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
    assert.equal(metadata?.url, 'https://example.com');
    assert.equal(metadata?.title, 'Example');
    assert.equal(typeof metadata?.fetchedAt, 'string');
  });

  it('returns undefined when metadata is disabled', () => {
    const metadata = createContentMetadataBlock(
      'https://example.com',
      null,
      { title: 'Fallback' },
      false,
      false
    );
    assert.equal(metadata, undefined);
  });
});

describe('truncateContent', () => {
  it('does not truncate when below the limit', () => {
    const result = truncateContent('hello', 10);
    assert.equal(result.truncated, false);
    assert.equal(result.content, 'hello');
  });

  it('truncates when exceeding the limit', () => {
    const result = truncateContent('hello world', 5);
    assert.equal(result.truncated, true);
    assert.equal(result.content.length, 5);
    assert.equal(result.content.startsWith('...['), true);
  });
});
