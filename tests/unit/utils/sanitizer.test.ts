import { describe, expect, test } from 'vitest';

import { sanitizeText, truncateText } from '../../../src/utils/sanitizer.js';

describe('sanitizer', () => {
  describe('sanitizeText', () => {
    test('collapses multiple spaces to single space', () => {
      const result = sanitizeText('hello    world');
      expect(result).toBe('hello world');
    });

    test('collapses tabs and newlines', () => {
      const result = sanitizeText('hello\t\nworld');
      expect(result).toBe('hello world');
    });

    test('trims leading whitespace', () => {
      const result = sanitizeText('   hello world');
      expect(result).toBe('hello world');
    });

    test('trims trailing whitespace', () => {
      const result = sanitizeText('hello world   ');
      expect(result).toBe('hello world');
    });

    test('trims both leading and trailing whitespace', () => {
      const result = sanitizeText('   hello world   ');
      expect(result).toBe('hello world');
    });

    test('handles multiple consecutive newlines', () => {
      const result = sanitizeText('hello\n\n\nworld');
      expect(result).toBe('hello world');
    });

    test('handles null input', () => {
      const result = sanitizeText(null);
      expect(result).toBe('');
    });

    test('handles undefined input', () => {
      const result = sanitizeText(undefined);
      expect(result).toBe('');
    });

    test('handles empty string', () => {
      const result = sanitizeText('');
      expect(result).toBe('');
    });

    test('handles whitespace-only string', () => {
      const result = sanitizeText('   \n\t   ');
      expect(result).toBe('');
    });

    test('handles non-string input', () => {
      const result = sanitizeText(123 as unknown as string);
      expect(result).toBe('123');
    });

    test('preserves single spaces', () => {
      const result = sanitizeText('hello world foo bar');
      expect(result).toBe('hello world foo bar');
    });

    test('handles mixed whitespace characters', () => {
      const result = sanitizeText('hello \t \n \r world');
      expect(result).toBe('hello world');
    });
  });

  describe('truncateText', () => {
    test('returns original text if within maxLength', () => {
      const result = truncateText('hello world', 20);
      expect(result).toBe('hello world');
    });

    test('truncates and adds ellipsis when exceeding maxLength', () => {
      const result = truncateText('hello world', 8);
      expect(result).toBe('hello...');
    });

    test('handles maxLength equal to text length', () => {
      const result = truncateText('hello', 5);
      expect(result).toBe('hello');
    });

    test('handles maxLength less than 4', () => {
      const result = truncateText('hello world', 3);
      expect(result).toBe('h'); // Returns first character only when maxLength < 4
    });

    test('handles maxLength of 1', () => {
      const result = truncateText('hello', 1);
      expect(result).toBe('h');
    });

    test('handles empty string', () => {
      const result = truncateText('', 10);
      expect(result).toBe('');
    });

    test('truncates at exact boundary', () => {
      const result = truncateText('hello world', 5);
      expect(result).toBe('he...');
    });

    test('handles unicode characters', () => {
      const result = truncateText('hello 世界', 8);
      expect(result).toBe('hello 世界'); // Within maxLength, not truncated
    });

    test('truncates long text correctly', () => {
      const longText = 'a'.repeat(100);
      const result = truncateText(longText, 50);
      expect(result).toBe('a'.repeat(47) + '...');
      expect(result.length).toBe(50);
    });
  });
});
