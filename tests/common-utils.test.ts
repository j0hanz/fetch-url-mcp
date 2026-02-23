import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createContentMetadataBlock,
  determineContentExtractionSource,
  isExtractionSufficient,
} from '../dist/transform/transform.js';

const retainedText = {
  longText: 'a'.repeat(200),
  articleText: 'a'.repeat(100),
};

const lowRetentionText = {
  longText: 'a'.repeat(500),
  articleText: 'a'.repeat(50),
};

function testExtractionSourceEnabledWithArticle() {
  const result = determineContentExtractionSource({
    content: '<p>content</p>',
    textContent: 'content',
  });
  assert.equal(result, true);
}

function testBuildsMetadataWhenEnabled() {
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
}

function testReturnsUndefinedWhenMetadataDisabled() {
  const metadata = createContentMetadataBlock(
    'https://example.com',
    null,
    { title: 'Fallback' },
    false,
    false
  );
  assert.equal(metadata, undefined);
}

describe('determineContentExtractionSource', () => {
  it('returns true when extraction is enabled and article exists', () => {
    testExtractionSourceEnabledWithArticle();
  });
});

describe('createContentMetadataBlock', () => {
  it('builds metadata when enabled', () => {
    testBuildsMetadataWhenEnabled();
  });
  it('returns undefined when metadata is disabled', () => {
    testReturnsUndefinedWhenMetadataDisabled();
  });
});

describe('isExtractionSufficient', () => {
  it('returns false for null article', () => {
    const result = isExtractionSufficient(null, '<p>some content</p>');
    assert.equal(result, false);
  });

  it('returns true for short original HTML (below threshold)', () => {
    const result = isExtractionSufficient(
      { content: '<p>x</p>', textContent: 'x' },
      '<p>short</p>'
    );
    assert.equal(result, true);
  });

  it('returns true when article retains sufficient content (>30%)', () => {
    const result = isExtractionSufficient(
      {
        content: `<p>${retainedText.articleText}</p>`,
        textContent: retainedText.articleText,
      },
      `<div><p>${retainedText.longText}</p></div>`
    );
    assert.equal(result, true);
  });

  it('returns false when article retains too little content (<30%)', () => {
    const result = isExtractionSufficient(
      {
        content: `<p>${lowRetentionText.articleText}</p>`,
        textContent: lowRetentionText.articleText,
      },
      `<div><p>${lowRetentionText.longText}</p></div>`
    );
    assert.equal(result, false);
  });

  it('handles article with empty textContent', () => {
    const result = isExtractionSufficient(
      { content: '<p></p>', textContent: '' },
      '<div><p>test content here</p></div>'.repeat(10)
    );
    assert.equal(result, false);
  });
});
