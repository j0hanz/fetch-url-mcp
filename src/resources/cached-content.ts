import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import * as cache from '../services/cache.js';
import { logWarn } from '../services/logger.js';

import { getErrorMessage } from '../utils/error-utils.js';
import { isRecord } from '../utils/guards.js';

const VALID_NAMESPACES = new Set(['markdown', 'links']);
const HASH_PATTERN = /^[a-f0-9.]+$/i;

interface CachedPayload {
  content?: string;
  markdown?: string;
}

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
    mimeType: resolveCacheMimeType(namespace),
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
  cacheKey: string,
  namespace: string
): { contents: { uri: string; mimeType: string; text: string }[] } {
  const cached = cache.get(cacheKey);

  if (!cached) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Content not found in cache for key: ${cacheKey}`
    );
  }

  if (namespace !== 'markdown') {
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: resolveCacheMimeType(namespace),
          text: cached.content,
        },
      ],
    };
  }

  const payload = parseCachedPayload(cached.content);
  const resolvedContent = payload ? resolvePayloadContent(payload) : null;

  if (!resolvedContent) {
    throw new McpError(
      ErrorCode.InternalError,
      `Cached content is missing for namespace ${namespace}`
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

function registerCacheContentResource(server: McpServer): void {
  server.registerResource(
    'cached-content',
    new ResourceTemplate('superfetch://cache/{namespace}/{urlHash}', {
      list: listCachedResources,
    }),
    {
      title: 'Cached Content',
      description:
        'Access previously fetched web content from cache. Namespace: markdown, links. UrlHash: SHA-256 hash of the URL.',
      mimeType: 'text/plain',
    },
    (uri, params) => {
      const { namespace, urlHash } = resolveCacheParams(params);
      const cacheKey = `${namespace}:${urlHash}`;
      return buildCachedContentResponse(uri, cacheKey, namespace);
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

function resolveCacheMimeType(namespace: string): string {
  if (namespace === 'markdown') return 'text/markdown';
  return 'application/json';
}

function isValidNamespace(namespace: string): boolean {
  return VALID_NAMESPACES.has(namespace);
}

function isValidHash(hash: string): boolean {
  return HASH_PATTERN.test(hash) && hash.length >= 8 && hash.length <= 64;
}

function resolveStringParam(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseCachedPayload(raw: string): CachedPayload | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isCachedPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isCachedPayload(value: unknown): value is CachedPayload {
  if (!isRecord(value)) return false;
  return (
    (value.content === undefined || typeof value.content === 'string') &&
    (value.markdown === undefined || typeof value.markdown === 'string')
  );
}

function resolvePayloadContent(payload: CachedPayload): string | null {
  if (typeof payload.markdown === 'string') {
    return payload.markdown;
  }
  if (typeof payload.content === 'string') {
    return payload.content;
  }
  return null;
}
