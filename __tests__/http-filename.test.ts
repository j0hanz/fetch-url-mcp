import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { generateSafeFilename } from '../dist/lib/http.js';

describe('generateSafeFilename', () => {
  it('generates filename from URL path', () => {
    const result = generateSafeFilename('https://example.com/my-page.html');
    assert.equal(result, 'my-page.md');
  });

  it('strips common web extensions', () => {
    const result = generateSafeFilename('https://example.com/page.php');
    assert.equal(result, 'page.md');
  });

  it('falls back to title when URL has no usable path', () => {
    const result = generateSafeFilename(
      'https://example.com/',
      'My Great Article'
    );
    assert.equal(result, 'my-great-article.md');
  });

  it('falls back to hash when no URL path or title', () => {
    const result = generateSafeFilename(
      'https://example.com/',
      undefined,
      'abc1234567890def'
    );
    assert.equal(result, 'abc1234567890def.md');
  });

  it('generates fallback from URL hash when nothing else works', () => {
    const result = generateSafeFilename('https://example.com/');
    assert.ok(result.endsWith('.md'));
    assert.ok(result.startsWith('download-'));
  });

  it('sanitizes unsafe characters from filename', () => {
    const result = generateSafeFilename('https://example.com/my:file?q=1');
    assert.ok(!result.includes(':'));
    assert.ok(!result.includes('?'));
    assert.ok(result.endsWith('.md'));
  });

  it('uses custom extension', () => {
    const result = generateSafeFilename(
      'https://example.com/page.html',
      undefined,
      undefined,
      '.txt'
    );
    assert.equal(result, 'page.txt');
  });

  it('collapses multiple dashes', () => {
    const result = generateSafeFilename(
      'https://example.com/',
      'Hello   World   Test'
    );
    // Multiple spaces become single dashes
    assert.ok(!result.includes('--'));
  });

  it('skips "index" filenames from URL', () => {
    const result = generateSafeFilename(
      'https://example.com/index.html',
      'Fallback Title'
    );
    assert.equal(result, 'fallback-title.md');
  });

  it('truncates excessively long filenames', () => {
    const longTitle = 'a'.repeat(300);
    const result = generateSafeFilename('https://example.com/', longTitle);
    // 200 is the max length
    assert.ok(result.length <= 200);
    assert.ok(result.endsWith('.md'));
  });
});
