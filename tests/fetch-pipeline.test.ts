import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as cache from '../dist/lib/cache.js';
import { createCacheKey } from '../dist/lib/cache.js';
import { config } from '../dist/lib/config.js';
import { normalizeUrl } from '../dist/lib/fetch.js';
import { executeFetchPipeline } from '../dist/lib/tool-pipeline.js';

type CachedPayload = { value: string };

function createCachedPayload(value: string): CachedPayload {
  return { value };
}

function serializePayload(payload: CachedPayload): string {
  return JSON.stringify(payload);
}

function deserializePayload(value: string): CachedPayload | undefined {
  return JSON.parse(value) as CachedPayload;
}

function serializeString(value: string): string {
  return JSON.stringify(value);
}

function deserializeString(value: string): string | undefined {
  const parsed = JSON.parse(value) as unknown;
  return typeof parsed === 'string' ? parsed : undefined;
}

function buildTestUrl(): string {
  return 'https://example.com/pipeline-test';
}

describe('executeFetchPipeline', () => {
  it('returns cached data and cache metadata when a cache hit occurs', async () => {
    const url = buildTestUrl();
    const normalizedUrl = normalizeUrl(url).normalizedUrl;
    const cacheNamespace = 'pipeline-test';
    const cacheVary = { locale: 'en' };
    const cacheKey = createCacheKey(cacheNamespace, normalizedUrl, cacheVary);

    assert.ok(cacheKey);

    const payload = createCachedPayload('cached');
    cache.set(cacheKey, serializePayload(payload), { url: normalizedUrl });
    const cachedEntry = cache.get(cacheKey);

    assert.ok(cachedEntry);

    const result = await executeFetchPipeline<CachedPayload>({
      url,
      cacheNamespace,
      cacheVary,
      deserialize: deserializePayload,
      transform: async () => {
        throw new Error('transform should not run on cache hit');
      },
    });

    assert.equal(result.fromCache, true);
    assert.equal(result.cacheKey, cacheKey);
    assert.equal(result.url, normalizedUrl);
    assert.equal(result.fetchedAt, cachedEntry.fetchedAt);
    assert.deepEqual(result.data, payload);
  });

  it('bypasses cache when a deserializer is missing', async (t) => {
    const url = buildTestUrl();
    const normalizedUrl = normalizeUrl(url).normalizedUrl;
    const cacheNamespace = 'pipeline-test-missing-deserializer';
    const cacheKey = createCacheKey(cacheNamespace, normalizedUrl);

    assert.ok(cacheKey);

    cache.set(cacheKey, serializePayload(createCachedPayload('cached')), {
      url: normalizedUrl,
    });

    t.mock.method(globalThis, 'fetch', async () => {
      return new Response('<p>fresh</p>', { status: 200 });
    });

    const result = await executeFetchPipeline<CachedPayload>({
      url,
      cacheNamespace,
      transform: async (input) => {
        const text = new TextDecoder(input.encoding).decode(input.buffer);
        return createCachedPayload(`fresh:${text}`);
      },
    });

    assert.equal(result.fromCache, false);
    assert.equal(result.cacheKey, cacheKey);
    assert.equal(result.url, normalizedUrl);
    assert.equal(result.data.value, 'fresh:<p>fresh</p>');
  });

  it('caches even when cacheVary is large', async (t) => {
    const url = buildTestUrl();
    const normalizedUrl = normalizeUrl(url).normalizedUrl;
    const cacheNamespace = 'pipeline-test-large-vary';
    const cacheVary = 'x'.repeat(10_000);

    const cacheKey = createCacheKey(cacheNamespace, normalizedUrl, cacheVary);
    assert.ok(cacheKey);

    let transformCalls = 0;

    t.mock.method(globalThis, 'fetch', async () => {
      return new Response('<p>fresh</p>', { status: 200 });
    });

    const first = await executeFetchPipeline<CachedPayload>({
      url,
      cacheNamespace,
      cacheVary,
      deserialize: deserializePayload,
      serialize: serializePayload,
      transform: async (input) => {
        const text = new TextDecoder(input.encoding).decode(input.buffer);
        transformCalls += 1;
        return createCachedPayload(`fresh:${text}`);
      },
    });

    const second = await executeFetchPipeline<CachedPayload>({
      url,
      cacheNamespace,
      cacheVary,
      deserialize: deserializePayload,
      serialize: serializePayload,
      transform: async (input) => {
        const text = new TextDecoder(input.encoding).decode(input.buffer);
        transformCalls += 1;
        return createCachedPayload(`fresh:${text}`);
      },
    });

    assert.equal(first.fromCache, false);
    assert.equal(second.fromCache, true);
    assert.equal(first.cacheKey, cacheKey);
    assert.equal(second.cacheKey, cacheKey);
    assert.equal(first.url, normalizedUrl);
    assert.equal(second.url, normalizedUrl);
    assert.equal(transformCalls, 1);
  });

  it('returns transformed raw URL when source is a GitHub blob', async (t) => {
    const url = 'https://github.com/octocat/Hello-World/blob/main/README.md';
    const expectedRaw =
      'https://raw.githubusercontent.com/octocat/Hello-World/main/README.md';
    const cacheNamespace = 'pipeline-test-raw-url';

    t.mock.method(globalThis, 'fetch', async () => {
      return new Response('raw content', { status: 200 });
    });

    const result = await executeFetchPipeline<string>({
      url,
      cacheNamespace,
      transform: async (input, normalizedUrl) => {
        assert.equal(normalizedUrl, expectedRaw);
        const text = new TextDecoder(input.encoding).decode(input.buffer);
        return text;
      },
    });

    assert.equal(result.fromCache, false);
    assert.equal(result.url, expectedRaw);
  });

  it('revalidates transformed raw URLs against blocked hosts', async () => {
    const blockedHost = 'raw.githubusercontent.com';
    const hadBlockedHost = config.security.blockedHosts.has(blockedHost);
    config.security.blockedHosts.add(blockedHost);

    try {
      await assert.rejects(
        () =>
          executeFetchPipeline<string>({
            url: 'https://github.com/octocat/Hello-World/blob/main/README.md',
            cacheNamespace: 'pipeline-test-raw-blocked-host',
            transform: async () => 'unreachable',
          }),
        (error) => {
          assert.ok(error instanceof Error);
          assert.match(
            error.message,
            /Blocked host: raw\.githubusercontent\.com/i
          );
          return true;
        }
      );
    } finally {
      if (!hadBlockedHost) {
        config.security.blockedHosts.delete(blockedHost);
      }
    }
  });

  it('rejects when a transformed raw URL exceeds max URL length', async () => {
    const maxLen = config.constants.maxUrlLength;
    const githubPrefix = 'https://github.com/o/r/blob/main/';
    const rawPrefix = 'https://raw.githubusercontent.com/o/r/main/';
    const delta = rawPrefix.length - githubPrefix.length;

    assert.ok(delta > 0);

    const path = 'a'.repeat(maxLen - githubPrefix.length);
    const url = `${githubPrefix}${path}`;
    assert.equal(url.length, maxLen);

    await assert.rejects(
      () =>
        executeFetchPipeline<string>({
          url,
          cacheNamespace: 'pipeline-test-raw-length-revalidation',
          transform: async () => 'unreachable',
        }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          new RegExp(`maximum length of ${maxLen} characters`, 'i')
        );
        return true;
      }
    );
  });

  it('caches final redirect URL under an alias key', async (t) => {
    const originalCacheEnabled = config.cache.enabled;
    config.cache.enabled = true;

    const url = 'https://example.com/redirect-start';
    const finalUrl = 'https://example.com/redirect-final';
    const cacheNamespace = 'pipeline-test-redirect-alias';

    let callCount = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: finalUrl },
        });
      }
      return new Response('<p>ok</p>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });

    try {
      const result = await executeFetchPipeline<string>({
        url,
        cacheNamespace,
        serialize: serializeString,
        deserialize: deserializeString,
        transform: async (input) => {
          const text = new TextDecoder(input.encoding).decode(input.buffer);
          return text;
        },
      });

      const normalizedUrl = normalizeUrl(url).normalizedUrl;
      const primaryKey = createCacheKey(cacheNamespace, normalizedUrl);
      const finalKey = createCacheKey(cacheNamespace, finalUrl);

      assert.ok(primaryKey);
      assert.ok(finalKey);
      assert.ok(cache.get(primaryKey));
      assert.ok(cache.get(finalKey));
      assert.equal(result.finalUrl, finalUrl);

      const cached = await executeFetchPipeline<string>({
        url,
        cacheNamespace,
        serialize: serializeString,
        deserialize: deserializeString,
        transform: async () => {
          throw new Error('transform should not run on cache hit');
        },
      });

      assert.equal(cached.fromCache, true);
      assert.equal(cached.finalUrl, finalUrl);
      assert.equal(callCount, 2);
    } finally {
      config.cache.enabled = originalCacheEnabled;
    }
  });
});
