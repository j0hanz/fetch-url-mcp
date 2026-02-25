import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import * as cache from '../dist/lib/cache.js';
import { createMcpServer } from '../dist/server.js';

interface SubscriptionRequest {
  method: 'resources/subscribe' | 'resources/unsubscribe';
  params: {
    uri: string;
  };
}

interface MutableServerMethods {
  isConnected: () => boolean;
  sendResourceListChanged: () => void;
}

interface MutableProtocolMethods {
  sendResourceUpdated: (params: { uri: string }) => Promise<void>;
}

type SubscriptionHandler = (
  request: SubscriptionRequest,
  extra?: unknown
) => Promise<Record<string, never>>;

function getSubscriptionHandler(
  server: Awaited<ReturnType<typeof createMcpServer>>,
  method: SubscriptionRequest['method']
): SubscriptionHandler {
  const handlers = (
    server.server as unknown as {
      _requestHandlers: Map<string, SubscriptionHandler>;
    }
  )._requestHandlers;

  const handler = handlers.get(method);
  assert.ok(handler, `${method} handler should be registered`);
  return handler;
}

describe('resource subscriptions', () => {
  it('sends resources/updated only for subscribed cache URIs', async () => {
    const server = await createMcpServer();
    const mutableServer = server as unknown as MutableServerMethods;
    const mutableProtocol = server.server as unknown as MutableProtocolMethods;
    const originalIsConnected = mutableServer.isConnected;
    const originalSendResourceListChanged =
      mutableServer.sendResourceListChanged;
    const originalSendResourceUpdated = mutableProtocol.sendResourceUpdated;

    let sentUris: string[] = [];
    mutableServer.isConnected = () => true;
    mutableServer.sendResourceListChanged = () => {};
    mutableProtocol.sendResourceUpdated = async ({ uri }) => {
      sentUris.push(uri);
    };

    const subscribe = getSubscriptionHandler(server, 'resources/subscribe');
    const unsubscribe = getSubscriptionHandler(server, 'resources/unsubscribe');

    const url = `https://example.com/subscription-${randomUUID()}`;
    const cacheKey = cache.createCacheKey('markdown', url);
    assert.ok(cacheKey);
    const parsed = cache.parseCacheKey(cacheKey);
    assert.ok(parsed);
    const cacheUri = `internal://cache/${parsed.namespace}/${parsed.urlHash}`;

    try {
      await subscribe({
        method: 'resources/subscribe',
        params: { uri: cacheUri },
      });

      cache.set(cacheKey, JSON.stringify({ markdown: '# one' }), { url });
      assert.deepEqual(sentUris, [cacheUri]);

      await unsubscribe({
        method: 'resources/unsubscribe',
        params: { uri: cacheUri },
      });

      cache.set(cacheKey, JSON.stringify({ markdown: '# two' }), { url });
      assert.deepEqual(sentUris, [cacheUri]);
    } finally {
      mutableServer.isConnected = originalIsConnected;
      mutableServer.sendResourceListChanged = originalSendResourceListChanged;
      mutableProtocol.sendResourceUpdated = originalSendResourceUpdated;
      await server.close();
      sentUris = [];
    }
  });
});
