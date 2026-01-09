import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isBlockedIp,
  normalizeUrl,
  validateAndNormalizeUrl,
} from '../dist/utils/url-validator.js';

type ValidCase = {
  name: string;
  url: string;
  expected: string;
};

type InvalidCase = {
  name: string;
  url: string;
  message: string;
};

const VALID_CASES: readonly ValidCase[] = [
  {
    name: 'returns a normalized URL for valid input',
    url: 'https://example.com/path',
    expected: 'https://example.com/path',
  },
  {
    name: 'trims surrounding whitespace',
    url: '  https://example.com/path  ',
    expected: 'https://example.com/path',
  },
];

const INVALID_CASES: readonly InvalidCase[] = [
  { name: 'rejects empty input', url: '', message: 'URL is required' },
  {
    name: 'rejects whitespace-only input',
    url: '   ',
    message: 'URL cannot be empty',
  },
  {
    name: 'rejects overly long URLs',
    url: `https://example.com/${'a'.repeat(2050)}`,
    message: 'URL exceeds maximum length of 2048 characters',
  },
  {
    name: 'rejects invalid URL formats',
    url: 'http://:invalid',
    message: 'Invalid URL format',
  },
  {
    name: 'rejects unsupported protocols',
    url: 'ftp://example.com',
    message: 'Invalid protocol: ftp:. Only http: and https: are allowed',
  },
  {
    name: 'rejects embedded credentials',
    url: 'https://user:pass@example.com',
    message: 'URLs with embedded credentials are not allowed',
  },
  {
    name: 'rejects blocked hosts',
    url: 'http://localhost',
    message: 'Blocked host: localhost. Internal hosts are not allowed',
  },
  {
    name: 'rejects blocked IP ranges',
    url: 'http://10.0.0.1',
    message: 'Blocked IP range: 10.0.0.1. Private IPs are not allowed',
  },
  {
    name: 'rejects internal hostname suffixes',
    url: 'https://example.local',
    message:
      'Blocked hostname pattern: example.local. Internal domain suffixes are not allowed',
  },
];

describe('validateAndNormalizeUrl', () => {
  VALID_CASES.forEach((testCase) => {
    it(testCase.name, () => {
      const result = validateAndNormalizeUrl(testCase.url);
      assert.equal(result, testCase.expected);
    });
  });

  INVALID_CASES.forEach((testCase) => {
    it(testCase.name, () => {
      assert.throws(() => validateAndNormalizeUrl(testCase.url), {
        message: testCase.message,
      });
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
