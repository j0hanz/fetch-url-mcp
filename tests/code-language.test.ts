import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  detectLanguageFromCode,
  resolveLanguageFromAttributes,
} from '../dist/utils/code-language.js';

describe('detectLanguageFromCode', () => {
  it('detects JavaScript snippets', () => {
    assert.equal(detectLanguageFromCode('const x = 1;'), 'javascript');
  });

  it('detects Python snippets', () => {
    assert.equal(
      detectLanguageFromCode('def run():\n  print(\"ok\")'),
      'python'
    );
  });

  it('returns undefined for unknown snippets', () => {
    assert.equal(detectLanguageFromCode('this is not code'), undefined);
  });

  const languageCases = [
    {
      name: 'TypeScript',
      code: 'interface User { id: string; }',
      expected: 'typescript',
    },
    {
      name: 'Rust',
      code: 'fn main() { let mut x = 1; }',
      expected: 'rust',
    },
    {
      name: 'Bash',
      code: '#!/usr/bin/env bash\nnpm run build',
      expected: 'bash',
    },
    {
      name: 'CSS',
      code: '.container { display: flex; }',
      expected: 'css',
    },
    {
      name: 'HTML',
      code: '<!doctype html><html><body></body></html>',
      expected: 'html',
    },
    {
      name: 'JSON',
      code: '{"name":"superfetch"}',
      expected: 'json',
    },
    {
      name: 'YAML',
      code: 'name: superfetch\nversion: 1',
      expected: 'yaml',
    },
    {
      name: 'SQL',
      code: 'SELECT 1;',
      expected: 'sql',
    },
    {
      name: 'Go',
      code: 'package main\nfunc main() {}',
      expected: 'go',
    },
    {
      name: 'JSX',
      code: 'export const App = () => <div className=\"x\" />;',
      expected: 'jsx',
    },
  ];

  for (const testCase of languageCases) {
    it(`detects ${testCase.name} snippets`, () => {
      assert.equal(detectLanguageFromCode(testCase.code), testCase.expected);
    });
  }

  it('extracts language from class names', () => {
    assert.equal(
      resolveLanguageFromAttributes('language-typescript', ''),
      'typescript'
    );
  });

  it('extracts language from data-language', () => {
    assert.equal(resolveLanguageFromAttributes('', 'python'), 'python');
  });
});
