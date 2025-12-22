import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import * as cache from '../services/cache.js';
import { logWarn } from '../services/logger.js';

export function registerCachedContentResource(server: McpServer): void {
  server.registerResource(
    'cached-content',
    new ResourceTemplate('superfetch://cache/{namespace}/{urlHash}', {
      list: () => {
        const resources = cache
          .keys()
          .map((key) => {
            const parts = cache.parseCacheKey(key);
            if (!parts) return null;
            return {
              name: `${parts.namespace}:${parts.urlHash}`,
              uri: `superfetch://cache/${parts.namespace}/${parts.urlHash}`,
              description: `Cached content entry for ${parts.namespace}`,
              mimeType: 'application/json',
            };
          })
          .filter(
            (entry): entry is NonNullable<typeof entry> => entry !== null
          );

        return { resources };
      },
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

  server.registerResource(
    'cached-urls',
    'superfetch://cache/list',
    {
      title: 'Cached URLs List',
      description: 'List all URLs currently in cache with their namespaces',
      mimeType: 'application/json',
    },
    (uri) => {
      const cacheKeys = cache.keys();
      const cacheList = {
        totalEntries: cacheKeys.length,
        entries: cacheKeys.map((key: string) => {
          const parts = cache.parseCacheKey(key);
          const namespace = parts?.namespace ?? 'unknown';
          const urlHash = parts?.urlHash ?? 'unknown';
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

  const unsubscribe = cache.onCacheUpdate(({ cacheKey }) => {
    const resourceUri = cache.toResourceUri(cacheKey);
    if (!resourceUri) return;

    if (server.isConnected()) {
      void server.server
        .sendResourceUpdated({ uri: resourceUri })
        .catch((error: unknown) => {
          logWarn('Failed to send resource update notification', {
            uri: resourceUri,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        });
      void server.server
        .sendResourceUpdated({ uri: 'superfetch://cache/list' })
        .catch((error: unknown) => {
          logWarn('Failed to send cache list update notification', {
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        });
      server.sendResourceListChanged();
    }
  });

  const previousOnClose = server.server.onclose;
  server.server.onclose = () => {
    previousOnClose?.();
    unsubscribe();
  };
}
