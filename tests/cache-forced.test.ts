import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import * as cache from '../dist/cache.js';
import { config } from '../dist/config.js';
import { normalizeUrl } from '../dist/fetch.js';
import { fetchUrlToolHandler } from '../dist/tools.js';
import { shutdownTransformWorkerPool } from '../dist/transform/transform.js';

after(async () => {
  await shutdownTransformWorkerPool();
});

describe('Forced Cache on Truncation', () => {
  it('does not emit resource links or force cache when disabled', async (t) => {
    const originalCacheEnabled = config.cache.enabled;
    const originalInlineLimit = config.constants.maxInlineContentChars;
    config.cache.enabled = false;
    config.constants.maxInlineContentChars = 20000;

    const url = `https://example.com/forced-cache-${Date.now()}`;
    const normalizedUrl = normalizeUrl(url).normalizedUrl;
    const cacheKey = cache.createCacheKey('markdown', normalizedUrl);
    assert.ok(cacheKey);

    const largeContent = 'a'.repeat(25000);
    const html = `<html><body><p>${largeContent}</p></body></html>`;

    try {
      t.mock.method(globalThis, 'fetch', async () => {
        return new Response(html, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      });

      const response = await fetchUrlToolHandler({ url });

      const resourceLinkBlock = response.content.find(
        (b) => b.type === 'resource_link'
      );
      assert.equal(
        resourceLinkBlock,
        undefined,
        'Resource link should not be emitted when cache is disabled'
      );

      const embeddedResource = response.content.find(
        (b) => b.type === 'resource'
      );
      assert.ok(
        embeddedResource,
        'Embedded resource should still be emitted for markdown preview'
      );

      const cachedEntry = cache.get(cacheKey, { force: true });
      assert.equal(
        cachedEntry,
        undefined,
        'Content should not be forced into cache when disabled'
      );
    } finally {
      config.cache.enabled = originalCacheEnabled;
      config.constants.maxInlineContentChars = originalInlineLimit;
    }
  });
});
