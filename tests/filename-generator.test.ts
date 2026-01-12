import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { generateSafeFilename } from '../dist/cache.js';

type FilenameCase = {
  url: string;
  title?: string;
  hash?: string;
  expected: string;
};

type RegexCase = {
  url: string;
  title?: string;
  hash?: string;
  pattern: RegExp;
};

function assertFilenameCase(testCase: FilenameCase): void {
  const result = generateSafeFilename(
    testCase.url,
    testCase.title,
    testCase.hash
  );
  assert.equal(result, testCase.expected);
}

function assertRegexCase(testCase: RegexCase): void {
  const result = generateSafeFilename(
    testCase.url,
    testCase.title,
    testCase.hash
  );
  assert.equal(testCase.pattern.test(result), true);
}

describe('generateSafeFilename', () => {
  describe('URL path extraction', () => {
    it('extracts filename from URL path', () => {
      assertFilenameCase({
        url: 'https://example.com/blog/my-article',
        expected: 'my-article.md',
      });
    });

    it('removes HTML extension', () => {
      assertFilenameCase({
        url: 'https://example.com/page.html',
        expected: 'page.md',
      });
    });

    it('handles nested paths', () => {
      assertFilenameCase({
        url: 'https://example.com/a/b/c/article-name',
        expected: 'article-name.md',
      });
    });

    it('skips index pages', () => {
      assertFilenameCase({
        url: 'https://example.com/blog/index.html',
        title: 'Blog Title',
        expected: 'blog-title.md',
      });
    });
  });

  describe('title fallback', () => {
    it('uses title when URL has no usable path', () => {
      assertFilenameCase({
        url: 'https://example.com/',
        title: 'My Great Article',
        expected: 'my-great-article.md',
      });
    });

    it('slugifies title with spaces', () => {
      assertFilenameCase({
        url: 'https://example.com/',
        title: 'Hello World Example',
        expected: 'hello-world-example.md',
      });
    });
  });

  describe('hash fallback', () => {
    it('uses hash when no URL path or title', () => {
      assertFilenameCase({
        url: 'https://example.com/',
        hash: 'abc123def456',
        expected: 'abc123def456.md',
      });
    });

    it('truncates long hashes', () => {
      assertFilenameCase({
        url: 'https://example.com/',
        hash: 'a'.repeat(32),
        expected: 'aaaaaaaaaaaaaaaa.md',
      });
    });
  });

  describe('sanitization', () => {
    it('removes unsafe characters', () => {
      assertFilenameCase({
        url: 'https://example.com/file-name',
        expected: 'file-name.md',
      });
    });

    it('replaces spaces with hyphens', () => {
      assertFilenameCase({
        url: 'https://example.com/my-file-name',
        expected: 'my-file-name.md',
      });
    });
  });

  describe('timestamp fallback', () => {
    it('handles timestamp fallback', () => {
      assertRegexCase({
        url: 'https://example.com/',
        pattern: /^download-\d+\.md$/,
      });
    });
  });

  describe('extensions', () => {
    it('supports custom extensions', () => {
      assertFilenameCase({
        url: 'https://example.com/data/export',
        hash: 'abc',
        expected: 'export.md',
      });
    });
  });
});
