import {
  type McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  GetPromptResult,
  ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js';
import {
  ErrorCode,
  McpError,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  get as getCacheEntry,
  getEntryMeta,
  keys as listCacheKeys,
  onCacheUpdate,
  parseCacheKey,
  toCacheScopeId,
} from '../lib/cache.js';
import { config, logWarn, resolveMcpSessionIdByServer } from '../lib/core.js';
import { registerServerLifecycleCleanup } from '../lib/mcp-interop.js';
import { buildOptionalIcons, type IconInfo } from '../lib/utils.js';
import { isObject } from '../lib/utils.js';

import { parseCachedPayload, resolveCachedPayloadContent } from '../schemas.js';
import { FETCH_URL_TOOL_NAME } from '../tools/fetch-url.js';

const RESOURCE_NOT_FOUND_ERROR_CODE = -32002;

interface CompletionContext {
  arguments?: Record<string, string> | undefined;
}

interface CacheResourceParts {
  namespace: string;
  hash: string;
}

type TemplateVariableValue = string | string[] | undefined;

const CACHE_RESOURCE_TEMPLATE_URI = 'internal://cache/{namespace}/{hash}';
const CACHE_RESOURCE_PREFIX = 'internal://cache/';
const CACHE_NAMESPACE_PATTERN = /^[a-z0-9_-]{1,64}$/i;
const CACHE_HASH_PATTERN = /^[a-f0-9.]{8,64}$/i;
const MAX_COMPLETION_VALUES = 100;

interface CacheEntryMetaView {
  scopeIds: string[];
}

function normalizeCompletionPrefix(value: string): string {
  return value.trim().toLowerCase();
}

function sortAndLimitValues(values: Iterable<string>): string[] {
  return [...values]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, MAX_COMPLETION_VALUES);
}

function isValidCacheResourceParts(parts: CacheResourceParts): boolean {
  return (
    CACHE_NAMESPACE_PATTERN.test(parts.namespace) &&
    CACHE_HASH_PATTERN.test(parts.hash)
  );
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function trimToValue(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function firstVariableValue(value: TemplateVariableValue): string | undefined {
  if (typeof value === 'string') {
    return trimToValue(value);
  }

  if (Array.isArray(value)) {
    const first = value[0];
    if (typeof first !== 'string') return undefined;
    return trimToValue(first);
  }

  return undefined;
}

function validateCacheResourceParts(
  namespace: string,
  hash: string
): CacheResourceParts | null {
  const decoded = {
    namespace: decodeSegment(namespace),
    hash: decodeSegment(hash),
  };
  return isValidCacheResourceParts(decoded) ? decoded : null;
}

function parseCacheResourceFromVariables(
  variables: Record<string, TemplateVariableValue>
): CacheResourceParts | null {
  const namespace = firstVariableValue(variables['namespace']);
  const hash = firstVariableValue(variables['hash']);
  if (!namespace || !hash) return null;

  return validateCacheResourceParts(namespace, hash);
}

function parseCacheResourceFromUri(uri: URL): CacheResourceParts | null {
  if (!uri.href.startsWith(CACHE_RESOURCE_PREFIX)) return null;

  const rawPath = uri.pathname.startsWith('/')
    ? uri.pathname.slice(1)
    : uri.pathname;
  const segments = rawPath.split('/');
  if (segments.length !== 2) return null;

  const namespace = segments[0];
  const hash = segments[1];
  if (!namespace || !hash) return null;

  return validateCacheResourceParts(namespace, hash);
}

function toCacheResourceUri(parts: CacheResourceParts): string {
  const namespace = encodeURIComponent(parts.namespace);
  const hash = encodeURIComponent(parts.hash);
  return `${CACHE_RESOURCE_PREFIX}${namespace}/${hash}`;
}

export function isCacheEntryVisibleToScope(
  scopeId: string,
  meta: CacheEntryMetaView
): boolean {
  return meta.scopeIds.includes(scopeId);
}

function getVisibleCacheEntries(scopeId: string): CacheResourceParts[] {
  return listCacheKeys()
    .map((key) => parseCacheKey(key))
    .filter((parts): parts is NonNullable<typeof parts> => parts !== null)
    .map((parts) => ({ namespace: parts.namespace, hash: parts.urlHash }))
    .filter((parts) => {
      const meta = getEntryMeta(`${parts.namespace}:${parts.hash}`);
      return meta ? isCacheEntryVisibleToScope(scopeId, meta) : false;
    });
}

function completeCacheNamespaces(value: string, scopeId: string): string[] {
  const normalized = normalizeCompletionPrefix(value);
  const namespaces = [
    ...new Set(getVisibleCacheEntries(scopeId).map((entry) => entry.namespace)),
  ].filter((ns) => ns.toLowerCase().startsWith(normalized));
  return sortAndLimitValues(namespaces);
}

function completeCacheHashes(
  value: string,
  scopeId: string,
  context?: CompletionContext
): string[] {
  const normalized = normalizeCompletionPrefix(value);
  const namespace = context?.arguments?.['namespace']?.trim();
  const hashes = getVisibleCacheEntries(scopeId)
    .filter((entry) => namespace === undefined || entry.namespace === namespace)
    .map((entry) => entry.hash)
    .filter((h) => h.toLowerCase().startsWith(normalized));
  return sortAndLimitValues(hashes);
}

function getServerCacheScopeId(server: McpServer): string {
  return toCacheScopeId(resolveMcpSessionIdByServer(server));
}

export function listCacheResourcesForScope(scopeId: string): {
  resources: {
    uri: string;
    name: string;
    title: string;
    description: string;
    mimeType: string;
    annotations: { audience: ['assistant']; priority: number };
  }[];
} {
  const resources = getVisibleCacheEntries(scopeId)
    .map((parts) => {
      const cacheParts: CacheResourceParts = {
        namespace: parts.namespace,
        hash: parts.hash,
      };
      const cacheKey = `${parts.namespace}:${parts.hash}`;
      const meta = getEntryMeta(cacheKey);
      if (!meta) return null; // expired between keys() and meta read — skip
      return {
        uri: toCacheResourceUri(cacheParts),
        name: `${parts.namespace}:${parts.hash}`,
        title: meta.title ?? 'Cached Markdown',
        description: 'Cached markdown output generated by fetch-url',
        mimeType: 'text/markdown',
        annotations: {
          audience: ['assistant'] as ['assistant'],
          priority: 0.6,
          ...(meta.fetchedAt ? { lastModified: meta.fetchedAt } : {}),
        },
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  return { resources };
}

function normalizeSubscriptionUri(uri: string): string {
  const parsedUri = URL.parse(uri);
  if (!parsedUri) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid resource URI');
  }
  const cacheParts = parseCacheResourceFromUri(parsedUri);
  if (cacheParts) return toCacheResourceUri(cacheParts);

  return parsedUri.href;
}

const cacheNotificationServers = new WeakSet<McpServer>();

function registerCacheResourceNotifications(server: McpServer): void {
  if (cacheNotificationServers.has(server)) return;
  cacheNotificationServers.add(server);
  const subscribedResourceUris = new Set<string>();

  const setSubscription = (uri: string, subscribed: boolean): void => {
    const normalized = normalizeSubscriptionUri(uri);
    if (subscribed) {
      subscribedResourceUris.add(normalized);
    } else {
      subscribedResourceUris.delete(normalized);
    }
  };

  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    setSubscription(request.params.uri, true);
    return Promise.resolve({});
  });

  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    setSubscription(request.params.uri, false);
    return Promise.resolve({});
  });

  const unsubscribe = onCacheUpdate((event) => {
    const scopeId = getServerCacheScopeId(server);
    const changedUri = toCacheResourceUri({
      namespace: event.namespace,
      hash: event.urlHash,
    });

    const isVisibleToServer = event.scopeIds.includes(scopeId);

    if (
      isVisibleToServer &&
      server.isConnected() &&
      subscribedResourceUris.has(changedUri)
    ) {
      void server.server
        .sendResourceUpdated({ uri: changedUri })
        .catch((error: unknown) => {
          logWarn('Failed to send resource updated notification', {
            uri: changedUri,
            error,
          });
        });
    }

    if (!event.listChanged) return;

    if (!server.isConnected() || !isVisibleToServer) return;

    try {
      server.sendResourceListChanged();
    } catch (error: unknown) {
      logWarn('Failed to send resources list changed notification', { error });
    }
  });

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    unsubscribe();
  };

  registerServerLifecycleCleanup(server, cleanup);
}

function normalizeTemplateVariables(
  variables: unknown
): Record<string, TemplateVariableValue> {
  if (!isObject(variables)) return {};

  const normalized: Record<string, TemplateVariableValue> = {};

  for (const [key, value] of Object.entries(variables)) {
    if (typeof value === 'string' || value === undefined) {
      normalized[key] = value;
      continue;
    }

    if (Array.isArray(value)) {
      normalized[key] = value.filter(
        (item): item is string => typeof item === 'string'
      );
    }
  }

  return normalized;
}

function resolveCacheResourceParts(
  uri: URL,
  variables: Record<string, TemplateVariableValue>
): CacheResourceParts {
  const fromVariables = parseCacheResourceFromVariables(variables);
  if (fromVariables) return fromVariables;

  const fromUri = parseCacheResourceFromUri(uri);
  if (fromUri) return fromUri;

  throw new McpError(
    ErrorCode.InvalidParams,
    'Invalid cache resource URI or template arguments'
  );
}

export function readCacheResourceForScope(
  uri: URL,
  variables: Record<string, TemplateVariableValue>,
  scopeId: string
): ReadResourceResult {
  const parts = resolveCacheResourceParts(uri, variables);
  const cacheKey = `${parts.namespace}:${parts.hash}`;
  const meta = getEntryMeta(cacheKey);
  if (!meta || !isCacheEntryVisibleToScope(scopeId, meta)) {
    throw new McpError(RESOURCE_NOT_FOUND_ERROR_CODE, 'Resource not found', {
      uri: uri.href,
    });
  }

  const entry = getCacheEntry(cacheKey);
  if (!entry) {
    throw new McpError(RESOURCE_NOT_FOUND_ERROR_CODE, 'Resource not found', {
      uri: uri.href,
    });
  }

  const payload = parseCachedPayload(entry.content);
  const markdown = payload ? resolveCachedPayloadContent(payload) : null;
  const text = markdown ?? entry.content;

  return {
    contents: [
      {
        uri: uri.href,
        mimeType: 'text/markdown',
        text,
      },
    ],
  };
}

export function registerInstructionResource(
  server: McpServer,
  instructions: string,
  iconInfo?: IconInfo
): void {
  server.registerResource(
    'fetch-url-mcp-instructions',
    'internal://instructions',
    {
      title: 'Server Instructions',
      description: 'Guidance for using the Fetch URL MCP server.',
      mimeType: 'text/markdown',
      annotations: {
        audience: ['assistant'],
        priority: 0.9,
      },
      ...buildOptionalIcons(iconInfo),
    },
    (uri): ReadResourceResult => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          text: instructions,
        },
      ],
    })
  );
}

export function registerCacheResourceTemplate(
  server: McpServer,
  iconInfo?: IconInfo
): void {
  const template = new ResourceTemplate(CACHE_RESOURCE_TEMPLATE_URI, {
    list: () => listCacheResourcesForScope(getServerCacheScopeId(server)),
    complete: {
      namespace: (value) =>
        completeCacheNamespaces(value, getServerCacheScopeId(server)),
      hash: (value, context) =>
        completeCacheHashes(value, getServerCacheScopeId(server), context),
    },
  });

  server.registerResource(
    'fetch-url-mcp-cache-entry',
    template,
    {
      title: 'Cached Fetch Output',
      description:
        'Read cached markdown generated by previous fetch-url calls.',
      mimeType: 'text/markdown',
      annotations: {
        audience: ['assistant'],
        priority: 0.6,
      },
      ...buildOptionalIcons(iconInfo),
    },
    (uri, variables): ReadResourceResult =>
      readCacheResourceForScope(
        uri,
        normalizeTemplateVariables(variables),
        getServerCacheScopeId(server)
      )
  );

  registerCacheResourceNotifications(server);
}

export function buildServerInstructions(): string {
  const maxHtmlSizeMb = config.constants.maxHtmlBytes / 1024 / 1024;
  const cacheSizeMb = config.cache.maxSizeBytes / 1024 / 1024;
  const cacheTtlHours = config.cache.ttl / 3600;

  return `# Fetch public webpages and return clean, readable Markdown.

# Capabilities
- Tool: \`${FETCH_URL_TOOL_NAME}\` (fetch URL, return Markdown)
- Resource: \`internal://instructions\` (this document)
- Resource template: \`internal://cache/{namespace}/{hash}\` (cached Markdown)
- Prompt: \`get-help\` (returns these instructions)
- Completions: resource-template argument completion for cache entries

# Workflows
1. Standard: Call \`${FETCH_URL_TOOL_NAME}\` → read \`markdown\`. \`truncated: true\` means content was cut at server size limit.
2. No cache: \`enableCache: false\` skips cache reads and writes for that request.
3. Clean markdown: \`extractMetadata: false\` hides the rendered footer/source block but keeps \`structuredContent.metadata\`.
4. Async: \`task: { ttl: <ms> }\` in \`tools/call\` → poll \`tasks/get\` → \`tasks/result\`.

# Constraints
- Blocked URLs: localhost, private IPs (10.x, 172.16-31.x, 192.168.x), metadata (169.254.169.254), .local/.internal.
- Max HTML: ${maxHtmlSizeMb}MB. Max redirects: ${config.fetcher.maxRedirects}.
- Cache: ${config.cache.maxKeys} entries, ${cacheSizeMb}MB, ${cacheTtlHours}h TTL. Process-local, ephemeral.
- No JS rendering — client-side pages may be incomplete.
- Binary: not supported.
- Batch JSON-RPC (\`[{...}]\`): rejected with HTTP 400.
- \`internal://\` URIs are server-scoped, valid only within current session.
- Tasks API (SDK v1.26): experimental. \`tasks/get\`, \`tasks/result\`, \`tasks/list\`, \`tasks/cancel\` may change.
- Notifications: opt-in. Set \`TASKS_STATUS_NOTIFICATIONS=true\`.

# Errors
- VALIDATION_ERROR: invalid/blocked URL. Do not retry.
- FETCH_ERROR: network failure. Retry once with backoff.
- HTTP_xxx: upstream error. Retry only for 5xx.
- ABORTED: cancelled. Retry if needed.
- queue_full: worker pool busy. Wait and retry, or use task mode.`;
}

export function registerGetHelpPrompt(
  server: McpServer,
  instructions: string,
  iconInfo?: IconInfo
): void {
  const description =
    'Return Fetch URL server instructions: workflows, cache usage, task mode, and error handling.';

  server.registerPrompt(
    'get-help',
    {
      title: 'Get Help',
      description,
      ...buildOptionalIcons(iconInfo),
    },
    (): GetPromptResult => ({
      description,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: instructions,
          },
        },
      ],
    })
  );
}
