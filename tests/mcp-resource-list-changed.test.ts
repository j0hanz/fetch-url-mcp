import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import * as cache from '../dist/lib/cache.js';
import { createMcpServer } from '../dist/server.js';

interface MutableServerMethods {
  isConnected: () => boolean;
  sendResourceListChanged: () => void;
}

describe('cache resource list changed notifications', () => {
  it('emits when cache key set changes and stops after close', async () => {
    const server = await createMcpServer();
    const mutable = server as unknown as MutableServerMethods;
    const originalIsConnected = mutable.isConnected;
    const originalSendResourceListChanged = mutable.sendResourceListChanged;

    let notifications = 0;
    mutable.isConnected = () => true;
    mutable.sendResourceListChanged = () => {
      notifications += 1;
    };

    const url = `https://example.com/cache-notify-${randomUUID()}`;
    const cacheKey = cache.createCacheKey('markdown', url);
    assert.ok(cacheKey);

    try {
      cache.set(cacheKey, JSON.stringify({ markdown: '# cached' }), { url });
      assert.equal(notifications, 1);

      cache.set(cacheKey, JSON.stringify({ markdown: '# refreshed' }), { url });
      assert.equal(notifications, 1);

      await server.close();

      const postCloseUrl = `https://example.com/cache-notify-${randomUUID()}`;
      const postCloseKey = cache.createCacheKey('markdown', postCloseUrl);
      assert.ok(postCloseKey);

      cache.set(postCloseKey, JSON.stringify({ markdown: '# post-close' }), {
        url: postCloseUrl,
      });
      assert.equal(notifications, 1);
    } finally {
      mutable.isConnected = originalIsConnected;
      mutable.sendResourceListChanged = originalSendResourceListChanged;
      await server.close();
    }
  });
});
