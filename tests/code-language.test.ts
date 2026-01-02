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
