import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as cache from '../dist/cache.js';
import { createCacheKey } from '../dist/cache.js';
import { normalizeUrl } from '../dist/fetch.js';
import { executeFetchPipeline } from '../dist/tools.js';

type CachedPayload = { value: string };

function withMockedFetch(
  mock: typeof fetch,
  execute: () => Promise<void>
): Promise<void> {
  const originalFetch: typeof fetch = fetch;
  (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = mock;

  return execute().finally(() => {
    (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch =
      originalFetch;
  });
}

function createCachedPayload(value: string): CachedPayload {
  return { value };
}

function serializePayload(payload: CachedPayload): string {
  return JSON.stringify(payload);
}

function deserializePayload(value: string): CachedPayload | undefined {
  return JSON.parse(value) as CachedPayload;
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

  it('bypasses cache when a deserializer is missing', async () => {
    const url = buildTestUrl();
    const normalizedUrl = normalizeUrl(url).normalizedUrl;
    const cacheNamespace = 'pipeline-test-missing-deserializer';
    const cacheKey = createCacheKey(cacheNamespace, normalizedUrl);

    assert.ok(cacheKey);

    cache.set(cacheKey, serializePayload(createCachedPayload('cached')), {
      url: normalizedUrl,
    });

    await withMockedFetch(
      async () => {
        return new Response('<p>fresh</p>', { status: 200 });
      },
      async () => {
        const result = await executeFetchPipeline<CachedPayload>({
          url,
          cacheNamespace,
          transform: async (html) => createCachedPayload(`fresh:${html}`),
        });

        assert.equal(result.fromCache, false);
        assert.equal(result.cacheKey, cacheKey);
        assert.equal(result.url, normalizedUrl);
        assert.equal(result.data.value, 'fresh:<p>fresh</p>');
      }
    );
  });

  it('bypasses cache when cacheVary exceeds safety limits', async () => {
    const url = buildTestUrl();
    const normalizedUrl = normalizeUrl(url).normalizedUrl;
    const cacheNamespace = 'pipeline-test-large-vary';
    const cacheVary = 'x'.repeat(10_000);

    assert.equal(
      createCacheKey(cacheNamespace, normalizedUrl, cacheVary),
      null
    );

    let transformCalls = 0;

    await withMockedFetch(
      async () => {
        return new Response('<p>fresh</p>', { status: 200 });
      },
      async () => {
        const first = await executeFetchPipeline<CachedPayload>({
          url,
          cacheNamespace,
          cacheVary,
          transform: async (html) => {
            transformCalls += 1;
            return createCachedPayload(`fresh:${html}`);
          },
        });

        const second = await executeFetchPipeline<CachedPayload>({
          url,
          cacheNamespace,
          cacheVary,
          transform: async (html) => {
            transformCalls += 1;
            return createCachedPayload(`fresh:${html}`);
          },
        });

        assert.equal(first.fromCache, false);
        assert.equal(second.fromCache, false);
        assert.equal(first.cacheKey, null);
        assert.equal(second.cacheKey, null);
        assert.equal(first.url, normalizedUrl);
        assert.equal(second.url, normalizedUrl);
        assert.equal(transformCalls, 2);
      }
    );
  });

  it('returns transformed raw URL when source is a GitHub blob', async () => {
    const url = 'https://github.com/octocat/Hello-World/blob/main/README.md';
    const expectedRaw =
      'https://raw.githubusercontent.com/octocat/Hello-World/main/README.md';
    const cacheNamespace = 'pipeline-test-raw-url';

    await withMockedFetch(
      async () => {
        return new Response('raw content', { status: 200 });
      },
      async () => {
        const result = await executeFetchPipeline<string>({
          url,
          cacheNamespace,
          transform: async (html, normalizedUrl) => {
            assert.equal(normalizedUrl, expectedRaw);
            return html;
          },
        });

        assert.equal(result.fromCache, false);
        assert.equal(result.url, expectedRaw);
      }
    );
  });
});
