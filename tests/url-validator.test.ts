import { describe, expect, it } from 'vitest';

import {
  isInternalUrl,
  validateAndNormalizeUrl,
} from '../src/utils/url-validator.js';

describe('validateAndNormalizeUrl', () => {
  it('returns a normalized URL for valid input', () => {
    const url = validateAndNormalizeUrl('https://example.com/path');
    expect(url).toBe('https://example.com/path');
  });

  it('rejects empty input', () => {
    expect(() => validateAndNormalizeUrl('')).toThrow('URL is required');
  });

  it('rejects unsupported protocols', () => {
    expect(() => validateAndNormalizeUrl('ftp://example.com')).toThrow(
      'Invalid protocol'
    );
  });

  it('rejects embedded credentials', () => {
    expect(() =>
      validateAndNormalizeUrl('https://user:pass@example.com')
    ).toThrow('embedded credentials');
  });

  it('rejects blocked hosts', () => {
    expect(() => validateAndNormalizeUrl('http://localhost')).toThrow(
      'Blocked host'
    );
  });
});

describe('isInternalUrl', () => {
  it('treats same-host urls as internal', () => {
    expect(isInternalUrl('/docs', 'https://example.com')).toBe(true);
  });

  it('treats different host urls as external', () => {
    expect(isInternalUrl('https://other.com', 'https://example.com')).toBe(
      false
    );
  });
});
