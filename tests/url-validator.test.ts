import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateAndNormalizeUrl } from '../dist/utils/url-validator.js';

describe('validateAndNormalizeUrl', () => {
  it('returns a normalized URL for valid input', async () => {
    await assert.doesNotReject(async () => {
      const result = await validateAndNormalizeUrl('https://example.com/path');
      assert.equal(result, 'https://example.com/path');
    });
  });

  it('trims surrounding whitespace', async () => {
    const result = await validateAndNormalizeUrl(
      '  https://example.com/path  '
    );
    assert.equal(result, 'https://example.com/path');
  });

  it('rejects empty input', async () => {
    await assert.rejects(() => validateAndNormalizeUrl(''), {
      message: 'URL is required',
    });
  });

  it('rejects whitespace-only input', async () => {
    await assert.rejects(() => validateAndNormalizeUrl('   '), {
      message: 'URL cannot be empty',
    });
  });

  it('rejects overly long URLs', async () => {
    const longUrl = `https://example.com/${'a'.repeat(2050)}`;
    await assert.rejects(() => validateAndNormalizeUrl(longUrl), {
      message: 'URL exceeds maximum length of 2048 characters',
    });
  });

  it('rejects invalid URL formats', async () => {
    await assert.rejects(() => validateAndNormalizeUrl('http://:invalid'), {
      message: 'Invalid URL format',
    });
  });

  it('rejects unsupported protocols', async () => {
    await assert.rejects(() => validateAndNormalizeUrl('ftp://example.com'), {
      message: 'Invalid protocol: ftp:. Only http: and https: are allowed',
    });
  });

  it('rejects embedded credentials', async () => {
    await assert.rejects(
      () => validateAndNormalizeUrl('https://user:pass@example.com'),
      { message: 'URLs with embedded credentials are not allowed' }
    );
  });

  it('rejects blocked hosts', async () => {
    await assert.rejects(() => validateAndNormalizeUrl('http://localhost'), {
      message: 'Blocked host: localhost. Internal hosts are not allowed',
    });
  });

  it('rejects blocked IP ranges', async () => {
    await assert.rejects(() => validateAndNormalizeUrl('http://10.0.0.1'), {
      message: 'Blocked IP range: 10.0.0.1. Private IPs are not allowed',
    });
  });

  it('rejects internal hostname suffixes', async () => {
    await assert.rejects(
      () => validateAndNormalizeUrl('https://example.local'),
      {
        message:
          'Blocked hostname pattern: example.local. Internal domain suffixes are not allowed',
      }
    );
  });
});
