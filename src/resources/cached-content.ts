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
      const cacheKeys = cache.keys();
      const cacheList = {
        totalEntries: cacheKeys.length,
        entries: cacheKeys.map((key: string) => {
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
