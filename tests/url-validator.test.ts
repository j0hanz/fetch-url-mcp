import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isBlockedIp,
  normalizeUrl,
  validateAndNormalizeUrl,
} from '../dist/lib/fetch.js';

describe('validateAndNormalizeUrl', () => {
  it('returns a normalized URL for valid input', () => {
    const result = validateAndNormalizeUrl('https://example.com/path');
    assert.equal(result, 'https://example.com/path');
  });

  it('trims surrounding whitespace', () => {
    const result = validateAndNormalizeUrl('  https://example.com/path  ');
    assert.equal(result, 'https://example.com/path');
  });

  it('rejects empty input', () => {
    assert.throws(() => validateAndNormalizeUrl(''), {
      message: 'URL is required',
    });
  });

  it('rejects whitespace-only input', () => {
    assert.throws(() => validateAndNormalizeUrl('   '), {
      message: 'URL cannot be empty',
    });
  });

  it('rejects overly long URLs', () => {
    assert.throws(
      () => validateAndNormalizeUrl(`https://example.com/${'a'.repeat(2050)}`),
      {
        message: 'URL exceeds maximum length of 2048 characters',
      }
    );
  });

  it('rejects invalid URL formats', () => {
    assert.throws(() => validateAndNormalizeUrl('http://:invalid'), {
      message: 'Invalid URL format',
    });
  });

  it('rejects unsupported protocols', () => {
    assert.throws(() => validateAndNormalizeUrl('ftp://example.com'), {
      message: 'Invalid protocol: ftp:. Only http: and https: are allowed',
    });
  });

  it('rejects embedded credentials', () => {
    assert.throws(
      () => validateAndNormalizeUrl('https://user:pass@example.com'),
      {
        message: 'URLs with embedded credentials are not allowed',
      }
    );
  });

  it('rejects blocked hosts', () => {
    assert.throws(() => validateAndNormalizeUrl('http://localhost'), {
      message: 'Blocked host: localhost. Internal hosts are not allowed',
    });
  });

  it('rejects blocked hosts with trailing dot', () => {
    assert.throws(() => validateAndNormalizeUrl('http://localhost.'), {
      message: 'Blocked host: localhost. Internal hosts are not allowed',
    });
  });

  it('rejects blocked IP ranges', () => {
    assert.throws(() => validateAndNormalizeUrl('http://10.0.0.1'), {
      message: 'Blocked IP range: 10.0.0.1. Private IPs are not allowed',
    });
  });

  it('normalizes trailing-dot hostnames', () => {
    const result = validateAndNormalizeUrl('https://example.com./path');
    assert.equal(result, 'https://example.com/path');
  });

  it('rejects internal hostname suffixes', () => {
    assert.throws(() => validateAndNormalizeUrl('https://example.local'), {
      message:
        'Blocked hostname pattern: example.local. Internal domain suffixes are not allowed',
    });
  });
});

describe('isBlockedIp', () => {
  it('blocks private IPv4 ranges', () => {
    assert.equal(isBlockedIp('10.0.0.1'), true);
  });

  it('blocks IPv6 loopback', () => {
    assert.equal(isBlockedIp('::1'), true);
  });

  it('blocks IPv4-mapped IPv6 addresses (::ffff:10.x.x.x)', () => {
    assert.equal(isBlockedIp('::ffff:10.0.0.1'), true);
  });

  it('blocks IPv4-mapped IPv6 addresses (::ffff:192.168.x.x)', () => {
    assert.equal(isBlockedIp('::ffff:192.168.1.1'), true);
  });

  it('blocks scoped IPv6 link-local addresses', () => {
    assert.equal(isBlockedIp('fe80::1%eth0'), true);
  });

  it('allows public IPs', () => {
    assert.equal(isBlockedIp('8.8.8.8'), false);
  });
});

describe('normalizeUrl', () => {
  it('returns normalized hostnames', () => {
    const result = normalizeUrl('https://Example.COM/Path');

    assert.equal(result.hostname, 'example.com');
    assert.equal(result.normalizedUrl, 'https://example.com/Path');
  });
});
