import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as cache from '../dist/services/cache.js';

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

describe('cache', () => {
  registerCacheEntryTest();
  registerEmptyContentTest();
  registerUpdateListenerTest();
  registerKeysTest();
  registerEnabledTest();
  registerNullKeyTest();
});
