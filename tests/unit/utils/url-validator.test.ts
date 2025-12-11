import { describe, expect, test } from 'vitest';

import {
  UrlValidationError,
  ValidationError,
} from '../../../src/errors/app-error.js';
import {
  isInternalUrl,
  validateAndNormalizeUrl,
} from '../../../src/utils/url-validator.js';

describe('url-validator', () => {
  describe('validateAndNormalizeUrl', () => {
    describe('Valid URLs', () => {
      test('accepts valid HTTP URL', () => {
        const result = validateAndNormalizeUrl('http://example.com');
        expect(result).toBe('http://example.com/');
      });

      test('accepts valid HTTPS URL', () => {
        const result = validateAndNormalizeUrl('https://example.com/path');
        expect(result).toBe('https://example.com/path');
      });

      test('normalizes URL with query params', () => {
        const result = validateAndNormalizeUrl(
          'https://example.com/path?query=value'
        );
        expect(result).toBe('https://example.com/path?query=value');
      });

      test('normalizes URL with hash', () => {
        const result = validateAndNormalizeUrl(
          'https://example.com/path#section'
        );
        expect(result).toBe('https://example.com/path#section');
      });

      test('trims whitespace from URL', () => {
        const result = validateAndNormalizeUrl('  https://example.com  ');
        expect(result).toBe('https://example.com/');
      });
    });

    describe('Security - SSRF Protection', () => {
      test('blocks localhost', () => {
        expect(() => validateAndNormalizeUrl('http://localhost:8080')).toThrow(
          UrlValidationError
        );
        expect(() => validateAndNormalizeUrl('http://localhost:8080')).toThrow(
          /Blocked host: localhost/
        );
      });

      test('blocks 127.0.0.1 (loopback)', () => {
        expect(() => validateAndNormalizeUrl('http://127.0.0.1')).toThrow(
          UrlValidationError
        );
        expect(() => validateAndNormalizeUrl('http://127.0.0.1')).toThrow(
          /Blocked host: 127\.0\.0\.1/
        );
      });

      test('blocks 127.0.0.2 (any 127.x)', () => {
        expect(() => validateAndNormalizeUrl('http://127.0.0.2')).toThrow(
          UrlValidationError
        );
      });

      test('blocks private 10.x network', () => {
        expect(() => validateAndNormalizeUrl('http://10.0.0.1')).toThrow(
          UrlValidationError
        );
        expect(() => validateAndNormalizeUrl('http://10.255.255.255')).toThrow(
          UrlValidationError
        );
      });

      test('blocks private 172.16-31.x network', () => {
        expect(() => validateAndNormalizeUrl('http://172.16.0.1')).toThrow(
          UrlValidationError
        );
        expect(() => validateAndNormalizeUrl('http://172.20.0.1')).toThrow(
          UrlValidationError
        );
        expect(() => validateAndNormalizeUrl('http://172.31.255.255')).toThrow(
          UrlValidationError
        );
      });

      test('blocks private 192.168.x network', () => {
        expect(() => validateAndNormalizeUrl('http://192.168.1.1')).toThrow(
          UrlValidationError
        );
        expect(() => validateAndNormalizeUrl('http://192.168.255.255')).toThrow(
          UrlValidationError
        );
      });

      test('blocks AWS metadata service', () => {
        expect(() => validateAndNormalizeUrl('http://169.254.169.254')).toThrow(
          UrlValidationError
        );
        expect(() =>
          validateAndNormalizeUrl('http://169.254.169.254/latest/meta-data')
        ).toThrow(/Blocked host: 169\.254\.169\.254/);
      });

      test('blocks 0.0.0.0', () => {
        expect(() => validateAndNormalizeUrl('http://0.0.0.0')).toThrow(
          UrlValidationError
        );
      });

      test('blocks .local domains (mDNS)', () => {
        expect(() => validateAndNormalizeUrl('http://server.local')).toThrow(
          UrlValidationError
        );
        expect(() => validateAndNormalizeUrl('http://server.local')).toThrow(
          /Blocked hostname pattern/
        );
      });

      test('blocks .internal domains', () => {
        expect(() => validateAndNormalizeUrl('http://api.internal')).toThrow(
          UrlValidationError
        );
      });

      test('blocks URLs with embedded credentials', () => {
        expect(() =>
          validateAndNormalizeUrl('http://user:pass@example.com')
        ).toThrow(UrlValidationError);
        expect(() =>
          validateAndNormalizeUrl('http://user:pass@example.com')
        ).toThrow(/URLs with embedded credentials/);
      });
    });

    describe('Invalid Protocols', () => {
      test('blocks FTP protocol', () => {
        expect(() => validateAndNormalizeUrl('ftp://example.com')).toThrow(
          UrlValidationError
        );
        expect(() => validateAndNormalizeUrl('ftp://example.com')).toThrow(
          /Invalid protocol: ftp:/
        );
      });

      test('blocks file protocol', () => {
        expect(() => validateAndNormalizeUrl('file:///etc/passwd')).toThrow(
          UrlValidationError
        );
        expect(() => validateAndNormalizeUrl('file:///etc/passwd')).toThrow(
          /Invalid protocol: file:/
        );
      });

      test('blocks javascript protocol', () => {
        expect(() => validateAndNormalizeUrl('javascript:alert(1)')).toThrow();
      });

      test('blocks data protocol', () => {
        expect(() =>
          validateAndNormalizeUrl('data:text/html,<h1>test</h1>')
        ).toThrow();
      });
    });

    describe('Input Validation', () => {
      test('throws ValidationError for empty string', () => {
        expect(() => validateAndNormalizeUrl('')).toThrow(ValidationError);
        expect(() => validateAndNormalizeUrl('')).toThrow(/URL is required/);
      });

      test('throws ValidationError for whitespace-only string', () => {
        expect(() => validateAndNormalizeUrl('   ')).toThrow(ValidationError);
      });

      test('throws ValidationError for null input', () => {
        expect(() =>
          validateAndNormalizeUrl(null as unknown as string)
        ).toThrow(ValidationError);
      });

      test('throws ValidationError for undefined input', () => {
        expect(() =>
          validateAndNormalizeUrl(undefined as unknown as string)
        ).toThrow(ValidationError);
      });

      test('throws ValidationError for URL exceeding max length', () => {
        const longUrl = 'https://example.com/' + 'a'.repeat(2100);
        expect(() => validateAndNormalizeUrl(longUrl)).toThrow(ValidationError);
        expect(() => validateAndNormalizeUrl(longUrl)).toThrow(
          /URL exceeds maximum length/
        );
      });

      test('throws UrlValidationError for malformed URL', () => {
        expect(() => validateAndNormalizeUrl('not a url')).toThrow(
          UrlValidationError
        );
        expect(() => validateAndNormalizeUrl('not a url')).toThrow(
          /Invalid URL format/
        );
      });

      test('throws UrlValidationError for URL without hostname', () => {
        expect(() => validateAndNormalizeUrl('http://')).toThrow(
          UrlValidationError
        );
      });
    });

    describe('Edge Cases', () => {
      test('accepts URL with port', () => {
        const result = validateAndNormalizeUrl('https://example.com:8443/path');
        expect(result).toBe('https://example.com:8443/path');
      });

      test('accepts URL with subdomain', () => {
        const result = validateAndNormalizeUrl('https://api.example.com');
        expect(result).toBe('https://api.example.com/');
      });

      test('accepts URL with multiple subdomains', () => {
        const result = validateAndNormalizeUrl(
          'https://api.v2.example.com/endpoint'
        );
        expect(result).toBe('https://api.v2.example.com/endpoint');
      });

      test('accepts URL with international domain', () => {
        const result = validateAndNormalizeUrl('https://例え.jp');
        expect(result).toContain('xn--'); // Punycode encoded
      });
    });
  });

  describe('isInternalUrl', () => {
    test('returns true for same hostname', () => {
      const result = isInternalUrl(
        'http://example.com/page',
        'http://example.com'
      );
      expect(result).toBe(true);
    });

    test('returns true for same hostname with different paths', () => {
      const result = isInternalUrl(
        'http://example.com/other',
        'http://example.com/base'
      );
      expect(result).toBe(true);
    });

    test('returns false for different hostname', () => {
      const result = isInternalUrl('http://other.com', 'http://example.com');
      expect(result).toBe(false);
    });

    test('returns false for different subdomain', () => {
      const result = isInternalUrl(
        'http://api.example.com',
        'http://www.example.com'
      );
      expect(result).toBe(false);
    });

    test('returns true for relative URL', () => {
      const result = isInternalUrl('/page', 'http://example.com');
      expect(result).toBe(true);
    });

    test('handles protocol difference (http vs https)', () => {
      const result = isInternalUrl('https://example.com', 'http://example.com');
      expect(result).toBe(true); // Same hostname, different protocol
    });

    test('returns true for malformed relative URL (treated as path)', () => {
      // URL constructor treats invalid URLs as paths relative to base
      const result = isInternalUrl('not a url', 'http://example.com');
      expect(result).toBe(true); // Resolved as http://example.com/not%20a%20url
    });
  });
});
