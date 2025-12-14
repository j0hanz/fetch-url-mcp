import crypto from 'crypto';

import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import * as cache from '../services/cache.js';

export function registerCachedContentResource(server: McpServer): void {
  server.registerResource(
    'cached-content',
    new ResourceTemplate('superfetch://cache/{namespace}/{urlHash}', {
      list: undefined,
    }),
    {
      title: 'Cached Content',
      description:
        'Access previously fetched web content from cache. Namespace: url, links, markdown. UrlHash: SHA-256 hash of the URL.',
      mimeType: 'application/json',
    },
    (uri, params) => {
      const namespace = params.namespace as string;
      const urlHash = params.urlHash as string;

      if (!namespace || !urlHash) {
        throw new Error('Both namespace and urlHash parameters are required');
      }

      const cacheKey = `${namespace}:${urlHash}`;
      const cached = cache.get(cacheKey);

      if (!cached) {
        throw new Error(
          `Content not found in cache for key: ${cacheKey}. Use superfetch://stats to see available cache entries.`
        );
      }

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: cached.content,
          },
        ],
      };
    }
  );

  // Helper resource to list cached URLs
  server.registerResource(
    'cached-urls',
    'superfetch://cache/list',
    {
      title: 'Cached URLs List',
      description: 'List all URLs currently in cache with their namespaces',
      mimeType: 'application/json',
    },
    (uri) => {
      const stats = cache.getStats();
      const cacheList = {
        totalEntries: stats.size + stats.htmlCacheSize,
        entries: cache.keys().map((key: string) => {
          const parts = key.split(':');
          const namespace = parts[0] ?? 'unknown';
          const urlHash = parts.slice(1).join(':') || 'unknown';
          return {
            namespace,
            urlHash,
            resourceUri: `superfetch://cache/${namespace}/${urlHash}`,
          };
        }),
        timestamp: new Date().toISOString(),
      };

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(cacheList, null, 2),
          },
        ],
      };
    }
  );
}

// Helper function to generate URL hash
export function generateUrlHash(url: string): string {
  return crypto.createHash('sha256').update(url).digest('hex');
}

// Track resource subscriptions
const subscriptions = new Map<string, Set<string>>();

export function setupCacheSubscriptions(): void {
  // Listen for cache updates and notify subscribers
  const unsubscribe = cache.onUpdate((key, namespace) => {
    const parts = key.split(':');
    const urlHash = parts.slice(1).join(':') || 'unknown';
    const resourceUri = `superfetch://cache/${namespace}/${urlHash}`;
    const subscribers = subscriptions.get(resourceUri);

    if (subscribers && subscribers.size > 0) {
      // Log subscription notification
      try {
        // Note: Actual notification would be sent via server.sendResourceUpdated()
        // when the SDK fully supports it. For now, we track subscriptions.
        console.log(
          `[Cache Update] Resource: ${resourceUri}, Subscribers: ${subscribers.size}`
        );
      } catch {
        // Silently ignore notification errors
      }
    }
  });

  // Store unsubscribe function for cleanup
  process.on('SIGTERM', unsubscribe);
  process.on('SIGINT', unsubscribe);
}
