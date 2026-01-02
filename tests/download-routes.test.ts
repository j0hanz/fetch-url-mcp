import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveDownloadPayload } from '../dist/http/download-routes.js';

describe('resolveDownloadPayload', () => {
  it('returns markdown content for markdown namespace', () => {
    const cacheEntry = {
      url: 'https://example.com/article',
      title: 'Example Article',
      content: JSON.stringify({
        markdown: '# Title\n\nBody',
        title: 'Example Article',
      }),
      fetchedAt: '2025-01-01T00:00:00.000Z',
      expiresAt: '2025-01-01T01:00:00.000Z',
    };

    const result = resolveDownloadPayload(
      { namespace: 'markdown', hash: 'abc123def456' },
      cacheEntry
    );

    assert.equal(result?.content, '# Title\n\nBody');
    assert.equal(result?.contentType, 'text/markdown; charset=utf-8');
    assert.equal(result?.fileName, 'article.md');
  });

  it('falls back to content field for markdown payloads', () => {
    const cacheEntry = {
      url: 'https://example.com/article',
      content: JSON.stringify({
        content: '# Title\n\nBody',
      }),
      fetchedAt: '2025-01-01T00:00:00.000Z',
      expiresAt: '2025-01-01T01:00:00.000Z',
    };

    const result = resolveDownloadPayload(
      { namespace: 'markdown', hash: 'abc123def456' },
      cacheEntry
    );

    assert.equal(result?.content, '# Title\n\nBody');
  });

  it('returns jsonl content for url namespace', () => {
    const cacheEntry = {
      url: 'https://example.com/article',
      content: JSON.stringify({
        content: '{"type":"paragraph","text":"Hello"}\n',
      }),
      fetchedAt: '2025-01-01T00:00:00.000Z',
      expiresAt: '2025-01-01T01:00:00.000Z',
    };

    const result = resolveDownloadPayload(
      { namespace: 'url', hash: 'abc123def456' },
      cacheEntry
    );

    assert.equal(result?.content, '{"type":"paragraph","text":"Hello"}\n');
    assert.equal(result?.contentType, 'application/x-ndjson; charset=utf-8');
    assert.equal(result?.fileName, 'article.jsonl');
  });

  it('returns null for invalid cached payloads', () => {
    const cacheEntry = {
      url: 'https://example.com/article',
      content: 'not-json',
      fetchedAt: '2025-01-01T00:00:00.000Z',
      expiresAt: '2025-01-01T01:00:00.000Z',
    };

    const result = resolveDownloadPayload(
      { namespace: 'markdown', hash: 'abc123def456' },
      cacheEntry
    );

    assert.equal(result, null);
  });
});
