import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { buildFileDownloadInfo } from '../dist/utils/download-url.js';

let cacheEntry: unknown;
const mockCacheGet = (key: string | null) => {
  if (!key) return undefined;
  return cacheEntry;
};

const mockConfig = {
  cache: { enabled: true, ttl: 3600 },
  runtime: { httpMode: true },
};

const mockCache = {
  parseCacheKey: (key: string) => {
    const [namespace, hash] = key.split(':');
    return namespace && hash ? { namespace, urlHash: hash } : null;
  },
  get: (key: string) => mockCacheGet(key) as never,
};

describe('buildFileDownloadInfo', () => {
  beforeEach(() => {
    mockConfig.cache.enabled = true;
    mockConfig.runtime.httpMode = true;
    cacheEntry = {
      url: 'https://example.com/article',
      title: 'Test Article',
      content: '',
      fetchedAt: '2025-01-01T00:00:00.000Z',
      expiresAt: '2025-01-01T01:00:00.000Z',
    };
  });

  it('builds download info from cache key', () => {
    const result = buildFileDownloadInfo(
      {
        cacheKey: 'markdown:abc123def456',
        url: 'https://example.com/article',
        title: 'Test Article',
      },
      { config: mockConfig, cache: mockCache }
    );

    assert.notEqual(result, null);
    assert.equal(result?.downloadUrl, '/mcp/downloads/markdown/abc123def456');
    assert.equal(result?.fileName.endsWith('.md'), true);
    assert.equal(result?.expiresAt, '2025-01-01T01:00:00.000Z');
  });

  it('returns null when cache key is null', () => {
    const result = buildFileDownloadInfo(
      {
        cacheKey: null,
        url: 'https://example.com',
      },
      { config: mockConfig, cache: mockCache }
    );

    assert.equal(result, null);
  });

  it('uses jsonl extension for url namespace', () => {
    const result = buildFileDownloadInfo(
      {
        cacheKey: 'url:abc123def456',
        url: 'https://example.com/article',
      },
      { config: mockConfig, cache: mockCache }
    );

    assert.equal(result?.fileName.endsWith('.jsonl'), true);
  });

  it('returns null when cache entry is missing', () => {
    cacheEntry = undefined;
    const result = buildFileDownloadInfo(
      {
        cacheKey: 'markdown:missing',
        url: 'https://example.com',
      },
      { config: mockConfig, cache: mockCache }
    );

    assert.equal(result, null);
  });

  it('returns null when cache is disabled', () => {
    mockConfig.cache.enabled = false;

    const result = buildFileDownloadInfo(
      {
        cacheKey: 'markdown:abc123',
        url: 'https://example.com',
      },
      { config: mockConfig, cache: mockCache }
    );

    assert.equal(result, null);
  });

  it('returns null when not in HTTP mode', () => {
    mockConfig.runtime.httpMode = false;

    const result = buildFileDownloadInfo(
      {
        cacheKey: 'markdown:abc123def456',
        url: 'https://example.com',
      },
      { config: mockConfig, cache: mockCache }
    );

    assert.equal(result, null);
  });
});
