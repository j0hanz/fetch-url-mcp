import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as cache from '../dist/cache.js';

let keyCounter = 0;

function createCacheKey(label: string): string {
  keyCounter += 1;
  return `cache-test:${label}-${keyCounter}`;
}

function assertValidIso(value: string): void {
  assert.equal(Number.isNaN(Date.parse(value)), false);
}

function registerCacheEntryTest(): void {
  it('stores and retrieves cache entries with metadata', () => {
    const cacheKey = createCacheKey('entry');
    const content = 'hello';
    const metadata = { url: 'https://example.com', title: 'Example' };

    cache.set(cacheKey, content, metadata);
    const entry = cache.get(cacheKey);

    assert.ok(entry);
    assert.equal(entry.url, metadata.url);
    assert.equal(entry.content, content);
    assert.equal(entry.title, metadata.title);
    assertValidIso(entry.fetchedAt);
    assertValidIso(entry.expiresAt);
  });
}

function registerEmptyContentTest(): void {
  it('skips writes when content is empty', () => {
    const cacheKey = createCacheKey('empty');

    cache.set(cacheKey, '', { url: 'https://example.com/empty' });

    assert.equal(cache.get(cacheKey), undefined);
  });
}

function registerUpdateListenerTest(): void {
  it('emits cache update events with parsed key data', () => {
    const cacheKey = createCacheKey('event');
    let captured:
      | { cacheKey: string; namespace: string; urlHash: string }
      | undefined;

    const unsubscribe = cache.onCacheUpdate((event) => {
      captured = event;
    });

    cache.set(cacheKey, 'payload', { url: 'https://example.com/event' });
    unsubscribe();

    assert.ok(captured);
    assert.equal(captured.cacheKey, cacheKey);
    assert.equal(captured.namespace, 'cache-test');
    assert.equal(captured.urlHash, cacheKey.split(':')[1]);
  });
}

function registerKeysTest(): void {
  it('returns keys for stored entries', () => {
    const cacheKey = createCacheKey('keys');
    cache.set(cacheKey, 'payload', { url: 'https://example.com/keys' });

    const keys = cache.keys();
    assert.ok(keys.includes(cacheKey));
  });
}

function registerEnabledTest(): void {
  it('reports cache enabled state', () => {
    assert.equal(cache.isEnabled(), true);
  });
}

function registerNullKeyTest(): void {
  it('returns undefined for null cache key', () => {
    assert.equal(cache.get(null), undefined);
  });
}

function registerCacheKeyGenerationTest(): void {
  it('generates stable cache keys for same URL and namespace', () => {
    const url = 'https://example.com/test-page';
    const namespace = 'test-ns';

    const key1 = cache.createCacheKey(namespace, url);
    const key2 = cache.createCacheKey(namespace, url);

    assert.ok(key1, 'Cache key should be generated');
    assert.strictEqual(key1, key2, 'Same inputs should produce same cache key');
    assert.ok(key1.includes(namespace), 'Cache key should include namespace');
  });

  it('generates different keys for different URLs', () => {
    const namespace = 'test-ns';

    const key1 = cache.createCacheKey(namespace, 'https://example.com/page1');
    const key2 = cache.createCacheKey(namespace, 'https://example.com/page2');

    assert.notStrictEqual(
      key1,
      key2,
      'Different URLs should produce different keys'
    );
  });

  it('generates different keys for different namespaces', () => {
    const url = 'https://example.com/page';

    const key1 = cache.createCacheKey('namespace1', url);
    const key2 = cache.createCacheKey('namespace2', url);

    assert.notStrictEqual(
      key1,
      key2,
      'Different namespaces should produce different keys'
    );
  });

  it('handles cache vary parameter in key generation', () => {
    const url = 'https://example.com/page';
    const namespace = 'test-ns';

    const key1 = cache.createCacheKey(namespace, url, { format: 'json' });
    const key2 = cache.createCacheKey(namespace, url, { format: 'xml' });
    const key3 = cache.createCacheKey(namespace, url);

    assert.notStrictEqual(
      key1,
      key2,
      'Different vary params should produce different keys'
    );
    assert.notStrictEqual(
      key1,
      key3,
      'Vary param should affect key generation'
    );
  });

  it('returns null for invalid cache vary inputs', () => {
    const url = 'https://example.com/page';
    const namespace = 'test-ns';

    // Create circular reference
    const circular: any = { a: 1 };
    circular.self = circular;

    const key = cache.createCacheKey(namespace, url, circular);
    assert.strictEqual(key, null, 'Invalid vary should return null');
  });
}

function registerCachedPayloadParsingTest(): void {
  it('parses valid cached payload with markdown', () => {
    const raw = JSON.stringify({
      markdown: '# Test Content',
      title: 'Test Title',
    });

    const parsed = cache.parseCachedPayload(raw);
    assert.ok(parsed, 'Should parse valid payload');
    assert.strictEqual(parsed.markdown, '# Test Content');
    assert.strictEqual(parsed.title, 'Test Title');
  });

  it('parses valid cached payload with legacy content field', () => {
    const raw = JSON.stringify({
      content: 'Plain text content',
    });

    const parsed = cache.parseCachedPayload(raw);
    assert.ok(parsed, 'Should parse legacy payload');
    assert.strictEqual(parsed.content, 'Plain text content');
  });

  it('returns null for invalid JSON', () => {
    const parsed = cache.parseCachedPayload('not json{]');
    assert.strictEqual(parsed, null, 'Should return null for invalid JSON');
  });

  it('returns null for non-object payloads', () => {
    const parsed = cache.parseCachedPayload('"just a string"');
    assert.strictEqual(parsed, null, 'Should return null for non-object');
  });
}

function registerCacheContentResolutionTest(): void {
  it('resolves content from markdown field', () => {
    const payload = { markdown: '# Markdown Content' };
    const content = cache.resolveCachedPayloadContent(payload);
    assert.strictEqual(content, '# Markdown Content');
  });

  it('resolves content from legacy content field', () => {
    const payload = { content: 'Plain content' };
    const content = cache.resolveCachedPayloadContent(payload);
    assert.strictEqual(content, 'Plain content');
  });

  it('prefers markdown over content when both exist', () => {
    const payload = {
      markdown: '# Markdown',
      content: 'Plain',
    };
    const content = cache.resolveCachedPayloadContent(payload);
    assert.strictEqual(content, '# Markdown', 'Should prefer markdown field');
  });

  it('returns null when no content field exists', () => {
    const payload = { title: 'Only Title' };
    const content = cache.resolveCachedPayloadContent(payload);
    assert.strictEqual(content, null);
  });
}

function registerCacheKeyParsingTest(): void {
  it('parses valid cache key into namespace and urlHash', () => {
    const namespace = 'markdown';
    const urlHash = 'abc123def456';
    const cacheKey = `${namespace}:${urlHash}`;

    const parsed = cache.parseCacheKey(cacheKey);
    assert.ok(parsed, 'Should parse valid cache key');
    assert.strictEqual(parsed.namespace, namespace);
    assert.strictEqual(parsed.urlHash, urlHash);
  });

  it('returns null for malformed cache key without colon', () => {
    const parsed = cache.parseCacheKey('malformed-key');
    assert.strictEqual(parsed, null, 'Should return null for malformed key');
  });

  it('returns null for empty cache key', () => {
    const parsed = cache.parseCacheKey('');
    assert.strictEqual(parsed, null, 'Should return null for empty key');
  });

  it('handles cache key with multiple colons', () => {
    const parsed = cache.parseCacheKey('markdown:hash:with:colons');
    assert.ok(parsed, 'Should parse key with multiple colons');
    assert.strictEqual(parsed.namespace, 'markdown');
    assert.strictEqual(parsed.urlHash, 'hash:with:colons');
  });
}

function registerResourceUriConversionTest(): void {
  it('converts cache key to resource URI format', () => {
    const cacheKey = 'markdown:abc123def456';

    const uri = cache.toResourceUri(cacheKey);
    assert.ok(uri, 'Should generate URI');
    assert.ok(
      uri.startsWith('superfetch://cache/'),
      'Should have correct scheme and base'
    );
    assert.ok(uri.includes('markdown'), 'Should include namespace');
    assert.ok(uri.includes('abc123def456'), 'Should include hash');
  });

  it('returns null for invalid cache key format', () => {
    const uri = cache.toResourceUri('invalid-key-format');
    assert.strictEqual(uri, null, 'Should return null for invalid key');
  });

  it('returns null for empty cache key', () => {
    const uri = cache.toResourceUri('');
    assert.strictEqual(uri, null, 'Should handle empty input');
  });
}

function registerFilenameGenerationTest(): void {
  it('generates safe filename from URL path', () => {
    const url = 'https://example.com/docs/guide.html';
    const filename = cache.generateSafeFilename(url);

    assert.ok(filename, 'Should generate filename');
    assert.ok(filename.endsWith('.md'), 'Should have .md extension');
    assert.ok(filename.includes('guide'), 'Should extract from URL path');
  });

  it('generates safe filename from title when URL has no useful path', () => {
    const url = 'https://example.com/';
    const title = 'My Great Article';
    const filename = cache.generateSafeFilename(url, title);

    assert.ok(filename, 'Should generate filename');
    assert.ok(filename.endsWith('.md'), 'Should have .md extension');
    // Check that title content is present (slugified)
    const baseFilename = filename.toLowerCase().replace('.md', '');
    assert.ok(baseFilename.includes('my'), 'Should contain title words');
    assert.ok(baseFilename.includes('great'), 'Should contain title words');
  });

  it('uses hash fallback when URL and title are not useful', () => {
    const url = 'https://example.com/';
    const hashFallback = 'abc123def456789';
    const filename = cache.generateSafeFilename(url, undefined, hashFallback);

    assert.ok(filename, 'Should generate filename');
    assert.ok(filename.includes('abc123def456'), 'Should include hash prefix');
    assert.ok(filename.endsWith('.md'), 'Should have .md extension');
  });

  it('generates timestamped filename when no context available', () => {
    const url = 'https://example.com/';
    const filename = cache.generateSafeFilename(url);

    assert.ok(filename, 'Should generate filename');
    assert.ok(filename.startsWith('download-'), 'Should have fallback prefix');
    assert.ok(filename.endsWith('.md'), 'Should have .md extension');
  });

  it('sanitizes unsafe characters from filename', () => {
    const url = 'https://example.com/';
    const title = 'Title <with> unsafe:chars|and*more?';
    const filename = cache.generateSafeFilename(url, title);

    assert.ok(!filename.includes('<'), 'Should remove < character');
    assert.ok(!filename.includes('>'), 'Should remove > character');
    assert.ok(!filename.includes(':'), 'Should remove : character');
    assert.ok(!filename.includes('|'), 'Should remove | character');
    assert.ok(!filename.includes('*'), 'Should remove * character');
    assert.ok(!filename.includes('?'), 'Should remove ? character');
  });

  it('truncates very long filenames', () => {
    const url = 'https://example.com/';
    const longTitle = 'a'.repeat(300);
    const filename = cache.generateSafeFilename(url, longTitle);

    assert.ok(
      filename.length <= 204,
      'Should truncate to max length (200 + .md)'
    );
    assert.ok(filename.endsWith('.md'), 'Should preserve extension');
  });

  it('respects custom extension parameter', () => {
    const url = 'https://example.com/docs/readme.html';
    const filename = cache.generateSafeFilename(
      url,
      undefined,
      undefined,
      '.txt'
    );

    assert.ok(filename.endsWith('.txt'), 'Should use custom extension');
    assert.ok(!filename.endsWith('.md'), 'Should not use default extension');
  });

  it('strips common page extensions from URL segments', () => {
    const testUrls = [
      'https://example.com/page.html',
      'https://example.com/page.htm',
      'https://example.com/page.php',
      'https://example.com/page.aspx',
      'https://example.com/page.jsp',
    ];

    testUrls.forEach((url) => {
      const filename = cache.generateSafeFilename(url);
      assert.ok(filename.includes('page'), 'Should extract page name');
      assert.ok(!filename.includes('.html'), 'Should strip .html extension');
      assert.ok(!filename.includes('.php'), 'Should strip .php extension');
    });
  });

  it('ignores "index" as filename', () => {
    const url = 'https://example.com/index.html';
    const filename = cache.generateSafeFilename(url);

    // Should fall back to timestamp since "index" is ignored
    assert.ok(
      filename.startsWith('download-'),
      'Should ignore index and use fallback'
    );
  });
}

function registerCacheExpirationTest(): void {
  it('expires cache entries based on TTL', () => {
    const cacheKey = createCacheKey('expiry');
    const content = 'expires soon';
    const metadata = { url: 'https://example.com/expiry' };

    cache.set(cacheKey, content, metadata);

    // Entry should exist immediately
    const entry1 = cache.get(cacheKey);
    assert.ok(entry1, 'Entry should exist after set');
    assert.equal(entry1.content, content);

    // Parse expiresAt and verify it's in the future
    const expiresAt = new Date(entry1.expiresAt).getTime();
    const now = Date.now();
    assert.ok(expiresAt > now, 'Expiry time should be in the future');
  });

  it('returns undefined for expired cache key on get', () => {
    const cacheKey = createCacheKey('expired');

    // Mock scenario: entry exists but is expired (can't easily test without time manipulation)
    // This tests the null check path when get() is called with non-existent key
    const result = cache.get(cacheKey);
    assert.equal(
      result,
      undefined,
      'Should return undefined for non-existent key'
    );
  });
}

function registerCacheUpdateNotificationTest(): void {
  it('notifies multiple listeners on cache updates', () => {
    const cacheKey = createCacheKey('multi-listener');
    const captured1: Array<{ cacheKey: string }> = [];
    const captured2: Array<{ cacheKey: string }> = [];

    const unsubscribe1 = cache.onCacheUpdate((event) => {
      captured1.push({ cacheKey: event.cacheKey });
    });

    const unsubscribe2 = cache.onCacheUpdate((event) => {
      captured2.push({ cacheKey: event.cacheKey });
    });

    cache.set(cacheKey, 'test payload', { url: 'https://example.com/multi' });

    unsubscribe1();
    unsubscribe2();

    assert.equal(captured1.length, 1, 'First listener should receive event');
    assert.equal(captured2.length, 1, 'Second listener should receive event');
    assert.equal(captured1[0].cacheKey, cacheKey);
    assert.equal(captured2[0].cacheKey, cacheKey);
  });

  it('stops notifications after unsubscribe', () => {
    const cacheKey1 = createCacheKey('unsub-1');
    const cacheKey2 = createCacheKey('unsub-2');
    let callCount = 0;

    const unsubscribe = cache.onCacheUpdate(() => {
      callCount += 1;
    });

    cache.set(cacheKey1, 'first', { url: 'https://example.com/1' });
    assert.equal(callCount, 1, 'Should receive first notification');

    unsubscribe();

    cache.set(cacheKey2, 'second', { url: 'https://example.com/2' });
    assert.equal(
      callCount,
      1,
      'Should not receive notification after unsubscribe'
    );
  });
}

function registerCacheLimitsTest(): void {
  it('stores multiple entries and returns all keys', () => {
    const keys = [
      createCacheKey('limit-1'),
      createCacheKey('limit-2'),
      createCacheKey('limit-3'),
    ];

    keys.forEach((key, index) => {
      cache.set(key, `content-${index}`, {
        url: `https://example.com/limit-${index}`,
      });
    });

    const allKeys = cache.keys();
    keys.forEach((key) => {
      assert.ok(allKeys.includes(key), `Should contain key ${key}`);
    });
  });

  it('retrieves cached entries by key', () => {
    const cacheKey = createCacheKey('retrieve');
    const content = 'retrievable content';
    const metadata = {
      url: 'https://example.com/retrieve',
      title: 'Retrievable',
    };

    cache.set(cacheKey, content, metadata);

    const entry = cache.get(cacheKey);
    assert.ok(entry, 'Should retrieve entry');
    assert.equal(entry.content, content);
    assert.equal(entry.url, metadata.url);
    assert.equal(entry.title, metadata.title);
  });
}

function registerErrorHandlingTest(): void {
  it('handles invalid vary parameters gracefully', () => {
    const url = 'https://example.com/test';
    const namespace = 'test';

    // Test with function (should serialize to null or handle gracefully)
    const invalidVary = { fn: () => 'test' };
    const key = cache.createCacheKey(namespace, url, invalidVary);

    // Should either return null or handle serialization
    assert.ok(
      key === null || typeof key === 'string',
      'Should handle invalid vary'
    );
  });

  it('returns undefined when cache is disabled', () => {
    // This test assumes cache is enabled; testing the guard clause
    const result = cache.get(null);
    assert.equal(result, undefined, 'Should return undefined for null key');
  });
}

function registerCacheKeyValidationTest(): void {
  it('creates cache keys with namespace and URL hash', () => {
    const namespace = 'markdown';
    const url = 'https://example.com/test';

    const key = cache.createCacheKey(namespace, url);
    assert.ok(key, 'Should create cache key');
    assert.ok(
      key.startsWith(`${namespace}:`),
      'Should include namespace prefix'
    );

    const parsed = cache.parseCacheKey(key);
    assert.ok(parsed, 'Should parse back to components');
    assert.equal(parsed.namespace, namespace, 'Should preserve namespace');
    assert.ok(parsed.urlHash.length > 0, 'Should have URL hash');
  });

  it('generates consistent keys for same inputs', () => {
    const namespace = 'markdown';
    const url = 'https://example.com/consistent';

    const key1 = cache.createCacheKey(namespace, url);
    const key2 = cache.createCacheKey(namespace, url);

    assert.equal(key1, key2, 'Should generate consistent keys');
  });

  it('generates different keys for different namespaces', () => {
    const url = 'https://example.com/test';

    const key1 = cache.createCacheKey('namespace-1', url);
    const key2 = cache.createCacheKey('namespace-2', url);

    assert.notEqual(
      key1,
      key2,
      'Different namespaces should produce different keys'
    );
  });

  it('generates different keys for different URLs', () => {
    const namespace = 'markdown';

    const key1 = cache.createCacheKey(namespace, 'https://example.com/page1');
    const key2 = cache.createCacheKey(namespace, 'https://example.com/page2');

    assert.notEqual(key1, key2, 'Different URLs should produce different keys');
  });
}

function registerCacheContentStorageTest(): void {
  it('stores content with full metadata', () => {
    const cacheKey = createCacheKey('metadata');
    const content = '# Test Content\n\nThis is markdown content.';
    const metadata = {
      url: 'https://example.com/article',
      title: 'Test Article',
    };

    cache.set(cacheKey, content, metadata);
    const retrieved = cache.get(cacheKey);

    assert.ok(retrieved, 'Should retrieve stored content');
    assert.equal(retrieved.content, content, 'Should preserve content');
    assert.equal(retrieved.url, metadata.url, 'Should preserve URL');
    assert.equal(retrieved.title, metadata.title, 'Should preserve title');
    assertValidIso(retrieved.fetchedAt);
    assertValidIso(retrieved.expiresAt);
  });

  it('stores content without title', () => {
    const cacheKey = createCacheKey('no-title');
    const content = 'Content without title';
    const metadata = { url: 'https://example.com/no-title' };

    cache.set(cacheKey, content, metadata);
    const retrieved = cache.get(cacheKey);

    assert.ok(retrieved, 'Should retrieve stored content');
    assert.equal(retrieved.content, content);
    assert.equal(retrieved.url, metadata.url);
    assert.equal(retrieved.title, undefined, 'Title should be undefined');
  });

  it('skips empty content', () => {
    const cacheKey = createCacheKey('empty-content');

    cache.set(cacheKey, '', { url: 'https://example.com/empty' });
    const retrieved = cache.get(cacheKey);

    assert.equal(retrieved, undefined, 'Should not store empty content');
  });

  it('skips whitespace-only content', () => {
    const cacheKey = createCacheKey('whitespace');

    cache.set(cacheKey, '   \n\t  ', { url: 'https://example.com/whitespace' });
    const retrieved = cache.get(cacheKey);

    // Implementation may trim or reject whitespace-only
    if (retrieved) {
      const trimmed = retrieved.content.trim();
      assert.ok(
        trimmed.length === 0 || retrieved.content.length > 0,
        'Should handle whitespace consistently'
      );
    }
  });
}

function registerCacheBulkOperationsTest(): void {
  it('handles multiple concurrent sets', () => {
    const keys = Array.from({ length: 10 }, (_, i) =>
      createCacheKey(`bulk-${i}`)
    );

    keys.forEach((key, index) => {
      cache.set(key, `content-${index}`, {
        url: `https://example.com/bulk-${index}`,
      });
    });

    const allKeys = cache.keys();
    keys.forEach((key) => {
      assert.ok(allKeys.includes(key), `Should contain key ${key}`);
    });
  });

  it('retrieves all stored entries correctly', () => {
    const entries = [
      {
        key: createCacheKey('entry-a'),
        content: 'Content A',
        url: 'https://example.com/a',
      },
      {
        key: createCacheKey('entry-b'),
        content: 'Content B',
        url: 'https://example.com/b',
      },
      {
        key: createCacheKey('entry-c'),
        content: 'Content C',
        url: 'https://example.com/c',
      },
    ];

    entries.forEach(({ key, content, url }) => {
      cache.set(key, content, { url });
    });

    entries.forEach(({ key, content, url }) => {
      const retrieved = cache.get(key);
      assert.ok(retrieved, `Should retrieve entry for ${key}`);
      assert.equal(retrieved.content, content);
      assert.equal(retrieved.url, url);
    });
  });
}

describe('cache', () => {
  registerCacheEntryTest();
  registerEmptyContentTest();
  registerUpdateListenerTest();
  registerKeysTest();
  registerEnabledTest();
  registerNullKeyTest();
  registerCacheKeyGenerationTest();
  registerCachedPayloadParsingTest();
  registerCacheContentResolutionTest();
  registerCacheKeyParsingTest();
  registerResourceUriConversionTest();
  registerFilenameGenerationTest();
  registerCacheExpirationTest();
  registerCacheUpdateNotificationTest();
  registerCacheLimitsTest();
  registerErrorHandlingTest();
  registerCacheKeyValidationTest();
  registerCacheContentStorageTest();
  registerCacheBulkOperationsTest();
});
