import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { generateSafeFilename } from '../dist/utils/filename-generator.js';

describe('generateSafeFilename', () => {
  describe('URL path extraction', () => {
    it('extracts filename from URL path', () => {
      assert.equal(
        generateSafeFilename('https://example.com/blog/my-article'),
        'my-article.md'
      );
    });

    it('removes HTML extension', () => {
      assert.equal(
        generateSafeFilename('https://example.com/page.html'),
        'page.md'
      );
    });

    it('handles nested paths', () => {
      assert.equal(
        generateSafeFilename('https://example.com/a/b/c/article-name'),
        'article-name.md'
      );
    });

    it('skips index pages', () => {
      assert.equal(
        generateSafeFilename(
          'https://example.com/blog/index.html',
          'Blog Title'
        ),
        'blog-title.md'
      );
    });
  });

  describe('title fallback', () => {
    it('uses title when URL has no usable path', () => {
      assert.equal(
        generateSafeFilename('https://example.com/', 'My Great Article'),
        'my-great-article.md'
      );
    });

    it('slugifies title with spaces', () => {
      assert.equal(
        generateSafeFilename('https://example.com/', 'Hello World Example'),
        'hello-world-example.md'
      );
    });
  });

  describe('hash fallback', () => {
    it('uses hash when no URL path or title', () => {
      assert.equal(
        generateSafeFilename('https://example.com/', undefined, 'abc123def456'),
        'abc123def456.md'
      );
    });

    it('truncates long hashes', () => {
      const longHash = 'a'.repeat(32);
      const result = generateSafeFilename(
        'https://example.com/',
        undefined,
        longHash
      );
      assert.equal(result, 'aaaaaaaaaaaaaaaa.md');
    });
  });

  describe('sanitization', () => {
    it('removes unsafe characters', () => {
      assert.equal(
        generateSafeFilename('https://example.com/file-name'),
        'file-name.md'
      );
    });

    it('replaces spaces with hyphens', () => {
      assert.equal(
        generateSafeFilename('https://example.com/my-file-name'),
        'my-file-name.md'
      );
    });

    it('handles timestamp fallback', () => {
      const result = generateSafeFilename('https://example.com/');
      assert.equal(/^download-\d+\.md$/.test(result), true);
    });
  });

  it('supports custom extensions', () => {
    assert.equal(
      generateSafeFilename('https://example.com/data/export', undefined, 'abc'),
      'export.md'
    );
    assert.equal(
      generateSafeFilename(
        'https://example.com/data/export',
        undefined,
        'abc',
        '.jsonl'
      ),
      'export.jsonl'
    );
  });
});
