import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import * as cache from '../services/cache.js';
import { logWarn } from '../services/logger.js';

import {
  parseCachedPayload,
  resolveCachedPayloadContent,
} from '../utils/cached-payload.js';
import { getErrorMessage } from '../utils/error-utils.js';
import { isRecord } from '../utils/guards.js';

const CACHE_NAMESPACE = 'markdown';
const HASH_PATTERN = /^[a-f0-9.]+$/i;

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
    mimeType: 'text/markdown',
  };
}

function listCachedResources(): {
  resources: ReturnType<typeof buildResourceEntry>[];
} {
  const resources = cache
    .keys()
    .map((key) => {
      const parts = cache.parseCacheKey(key);
      if (parts?.namespace !== CACHE_NAMESPACE) return null;
      return buildResourceEntry(parts.namespace, parts.urlHash);
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  return { resources };
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
  registerCacheUpdateSubscription(server);
}

function resolveCacheParams(params: unknown): {
  namespace: string;
  urlHash: string;
} {
  if (!isRecord(params)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Invalid cache resource parameters'
    );
  }

  const namespace = resolveStringParam(params.namespace);
  const urlHash = resolveStringParam(params.urlHash);

  if (!namespace || !urlHash) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Both namespace and urlHash parameters are required'
    );
  }

  if (!isValidNamespace(namespace) || !isValidHash(urlHash)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Invalid cache resource parameters'
    );
  }

  return { namespace, urlHash };
}

function buildCachedContentResponse(
  uri: URL,
  cacheKey: string
): { contents: { uri: string; mimeType: string; text: string }[] } {
  const cached = requireCacheEntry(cacheKey);
  return buildMarkdownContentResponse(uri, cached.content);
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
        'Access previously fetched web content from cache. Namespace: markdown. UrlHash: SHA-256 hash of the URL.',
      mimeType: 'text/plain',
    },
    (uri, params) => {
      const { namespace, urlHash } = resolveCacheParams(params);
      const cacheKey = `${namespace}:${urlHash}`;
      return buildCachedContentResponse(uri, cacheKey);
    }
  );
}

function registerCacheUpdateSubscription(server: McpServer): void {
  const unsubscribe = cache.onCacheUpdate(({ cacheKey }) => {
    const resourceUri = cache.toResourceUri(cacheKey);
    if (!resourceUri) return;

    notifyResourceUpdate(server, resourceUri);
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

function isValidNamespace(namespace: string): boolean {
  return namespace === CACHE_NAMESPACE;
}

function isValidHash(hash: string): boolean {
  return HASH_PATTERN.test(hash) && hash.length >= 8 && hash.length <= 64;
}

function resolveStringParam(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function requireCacheEntry(cacheKey: string): { content: string } {
  const cached = cache.get(cacheKey);
  if (!cached) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Content not found in cache for key: ${cacheKey}`
    );
  }
  return cached;
}

function buildMarkdownContentResponse(
  uri: URL,
  content: string
): { contents: { uri: string; mimeType: string; text: string }[] } {
  const payload = parseCachedPayload(content);
  const resolvedContent = payload ? resolveCachedPayloadContent(payload) : null;

  if (!resolvedContent) {
    throw new McpError(
      ErrorCode.InternalError,
      'Cached markdown content is missing'
    );
  }

  return {
    contents: [
      {
        uri: uri.href,
        mimeType: 'text/markdown',
        text: resolvedContent,
      },
    ],
  };
}
