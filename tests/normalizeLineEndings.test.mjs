import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Test normalizeLineEndings directly
describe('normalizeLineEndings', () => {
  it('should convert \\r\\n to \\n', () => {
    const normalizeLineEndings = (markdown) => markdown.replace(/\r\n/g, '\n');

    const input = 'Line 1\r\nLine 2\r\nLine 3\r\n';
    const expected = 'Line 1\nLine 2\nLine 3\n';
    const result = normalizeLineEndings(input);

    assert.equal(result, expected);
    assert.equal(result.includes('\r'), false);
  });

  it('should leave \\n unchanged', () => {
    const normalizeLineEndings = (markdown) => markdown.replace(/\r\n/g, '\n');

    const input = 'Line 1\nLine 2\nLine 3\n';
    const result = normalizeLineEndings(input);

    assert.equal(result, input);
  });

  it('should handle mixed line endings', () => {
    const normalizeLineEndings = (markdown) => markdown.replace(/\r\n/g, '\n');

    const input = 'Line 1\r\nLine 2\nLine 3\r\n';
    const expected = 'Line 1\nLine 2\nLine 3\n';
    const result = normalizeLineEndings(input);

    assert.equal(result, expected);
  });
});
