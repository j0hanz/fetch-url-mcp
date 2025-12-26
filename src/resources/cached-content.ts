import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import * as cache from '../services/cache.js';
import { logWarn } from '../services/logger.js';

import { getErrorMessage } from '../utils/error-utils.js';

function buildResourceEntry(
  namespace: string,
  urlHash: string
): {
  name: string;
  uri: string;
  description: string;
  mimeType: string;
} {
  return {
    name: `${namespace}:${urlHash}`,
    uri: `superfetch://cache/${namespace}/${urlHash}`,
    description: `Cached content entry for ${namespace}`,
    mimeType: 'application/json',
  };
}

function listCachedResources(): {
  resources: ReturnType<typeof buildResourceEntry>[];
} {
  const resources = cache
    .keys()
    .map((key) => {
      const parts = cache.parseCacheKey(key);
      return parts ? buildResourceEntry(parts.namespace, parts.urlHash) : null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  return { resources };
}

function buildCacheListPayload(): Record<string, unknown> {
  const cacheKeys = cache.keys();
  return {
    totalEntries: cacheKeys.length,
    entries: cacheKeys.map((key) => {
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
}

function notifyResourceUpdate(server: McpServer, uri: string): void {
  if (!server.isConnected()) return;
  void server.server.sendResourceUpdated({ uri }).catch((error: unknown) => {
    logWarn('Failed to send resource update notification', {
      uri,
      error: getErrorMessage(error),
    });
  });
}

export function registerCachedContentResource(server: McpServer): void {
  registerCacheContentResource(server);
  registerCacheListResource(server);
  registerCacheUpdateSubscription(server);
}

function resolveCacheParams(params: Record<string, unknown>): {
  namespace: string;
  urlHash: string;
} {
  const namespace = params.namespace as string;
  const urlHash = params.urlHash as string;

  if (!namespace || !urlHash) {
    throw new Error('Both namespace and urlHash parameters are required');
  }

  return { namespace, urlHash };
}

function buildCachedContentResponse(
  uri: URL,
  cacheKey: string
): { contents: { uri: string; mimeType: string; text: string }[] } {
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

function registerCacheContentResource(server: McpServer): void {
  server.registerResource(
    'cached-content',
    new ResourceTemplate('superfetch://cache/{namespace}/{urlHash}', {
      list: listCachedResources,
    }),
    {
      title: 'Cached Content',
      description:
        'Access previously fetched web content from cache. Namespace: url, links, markdown. UrlHash: SHA-256 hash of the URL.',
      mimeType: 'application/json',
    },
    (uri, params) => {
      const { namespace, urlHash } = resolveCacheParams(
        params as Record<string, unknown>
      );
      const cacheKey = `${namespace}:${urlHash}`;
      return buildCachedContentResponse(uri, cacheKey);
    }
  );
}

function registerCacheListResource(server: McpServer): void {
  server.registerResource(
    'cached-urls',
    'superfetch://cache/list',
    {
      title: 'Cached URLs List',
      description: 'List all URLs currently in cache with their namespaces',
      mimeType: 'application/json',
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(buildCacheListPayload(), null, 2),
        },
      ],
    })
  );
}

function registerCacheUpdateSubscription(server: McpServer): void {
  const unsubscribe = cache.onCacheUpdate(({ cacheKey }) => {
    const resourceUri = cache.toResourceUri(cacheKey);
    if (!resourceUri) return;

    notifyResourceUpdate(server, resourceUri);
    notifyResourceUpdate(server, 'superfetch://cache/list');
    if (server.isConnected()) {
      server.sendResourceListChanged();
    }
  });

  const previousOnClose = server.server.onclose;
  server.server.onclose = () => {
    previousOnClose?.();
    unsubscribe();
  };
}
