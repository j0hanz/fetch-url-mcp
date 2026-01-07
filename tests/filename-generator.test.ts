import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { generateSafeFilename } from '../dist/utils/filename-generator.js';

type FilenameCase = {
  name: string;
  url: string;
  title?: string;
  hash?: string;
  expected: string;
};

type RegexCase = {
  name: string;
  url: string;
  title?: string;
  hash?: string;
  pattern: RegExp;
};

const URL_PATH_CASES: readonly FilenameCase[] = [
  {
    name: 'extracts filename from URL path',
    url: 'https://example.com/blog/my-article',
    expected: 'my-article.md',
  },
  {
    name: 'removes HTML extension',
    url: 'https://example.com/page.html',
    expected: 'page.md',
  },
  {
    name: 'handles nested paths',
    url: 'https://example.com/a/b/c/article-name',
    expected: 'article-name.md',
  },
  {
    name: 'skips index pages',
    url: 'https://example.com/blog/index.html',
    title: 'Blog Title',
    expected: 'blog-title.md',
  },
];

const TITLE_FALLBACK_CASES: readonly FilenameCase[] = [
  {
    name: 'uses title when URL has no usable path',
    url: 'https://example.com/',
    title: 'My Great Article',
    expected: 'my-great-article.md',
  },
  {
    name: 'slugifies title with spaces',
    url: 'https://example.com/',
    title: 'Hello World Example',
    expected: 'hello-world-example.md',
  },
];

const HASH_FALLBACK_CASES: readonly FilenameCase[] = [
  {
    name: 'uses hash when no URL path or title',
    url: 'https://example.com/',
    hash: 'abc123def456',
    expected: 'abc123def456.md',
  },
  {
    name: 'truncates long hashes',
    url: 'https://example.com/',
    hash: 'a'.repeat(32),
    expected: 'aaaaaaaaaaaaaaaa.md',
  },
];

const SANITIZATION_CASES: readonly FilenameCase[] = [
  {
    name: 'removes unsafe characters',
    url: 'https://example.com/file-name',
    expected: 'file-name.md',
  },
  {
    name: 'replaces spaces with hyphens',
    url: 'https://example.com/my-file-name',
    expected: 'my-file-name.md',
  },
];

const REGEX_CASES: readonly RegexCase[] = [
  {
    name: 'handles timestamp fallback',
    url: 'https://example.com/',
    pattern: /^download-\d+\.md$/,
  },
];

const EXTENSION_CASES: readonly FilenameCase[] = [
  {
    name: 'supports custom extensions',
    url: 'https://example.com/data/export',
    hash: 'abc',
    expected: 'export.md',
  },
];

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

function registerFilenameCases(
  title: string,
  cases: readonly FilenameCase[]
): void {
  describe(title, () => {
    cases.forEach((testCase) => {
      it(testCase.name, () => {
        assertFilenameCase(testCase);
      });
    });
  });
}

function registerRegexCases(title: string, cases: readonly RegexCase[]): void {
  describe(title, () => {
    cases.forEach((testCase) => {
      it(testCase.name, () => {
        assertRegexCase(testCase);
      });
    });
  });
}

describe('generateSafeFilename', () => {
  registerFilenameCases('URL path extraction', URL_PATH_CASES);
  registerFilenameCases('title fallback', TITLE_FALLBACK_CASES);
  registerFilenameCases('hash fallback', HASH_FALLBACK_CASES);
  registerFilenameCases('sanitization', SANITIZATION_CASES);
  registerRegexCases('timestamp fallback', REGEX_CASES);
  registerFilenameCases('extensions', EXTENSION_CASES);
});
