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
} from '../lib/core.js';
import { logWarn } from '../lib/core.js';
import { config } from '../lib/core.js';
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

class CompletionIndex {
  private namespaces: string[] | null = null;
  private hashIndex: Map<string, string[]> | null = null;

  invalidate(): void {
    this.namespaces = null;
    this.hashIndex = null;
  }

  getNamespaces(): string[] {
    if (!this.namespaces) {
      const seen = new Set<string>();
      for (const key of listCacheKeys()) {
        const parsed = parseCacheKey(key);
        if (parsed) seen.add(parsed.namespace);
      }
      this.namespaces = [...seen].sort((a, b) => a.localeCompare(b));
    }
    return this.namespaces;
  }

  getHashes(namespace: string | undefined): string[] {
    if (!this.hashIndex) {
      const index = new Map<string, Set<string>>();
      for (const key of listCacheKeys()) {
        const parsed = parseCacheKey(key);
        if (!parsed) continue;
        let set = index.get(parsed.namespace);
        if (!set) {
          set = new Set<string>();
          index.set(parsed.namespace, set);
        }
        set.add(parsed.urlHash);
      }
      this.hashIndex = new Map<string, string[]>();
      for (const [ns, set] of index) {
        this.hashIndex.set(
          ns,
          [...set].sort((a, b) => a.localeCompare(b))
        );
      }
    }

    if (namespace) return this.hashIndex.get(namespace) ?? [];

    const all: string[] = [];
    for (const hashes of this.hashIndex.values()) {
      all.push(...hashes);
    }
    return all.sort((a, b) => a.localeCompare(b));
  }
}

const completionIndex = new CompletionIndex();

function completeCacheNamespaces(value: string): string[] {
  const normalized = normalizeCompletionPrefix(value);
  const namespaces = completionIndex
    .getNamespaces()
    .filter((ns) => ns.toLowerCase().startsWith(normalized));
  return sortAndLimitValues(namespaces);
}

function completeCacheHashes(
  value: string,
  context?: CompletionContext
): string[] {
  const normalized = normalizeCompletionPrefix(value);
  const namespace = context?.arguments?.['namespace']?.trim();
  const hashes = completionIndex
    .getHashes(namespace)
    .filter((h) => h.toLowerCase().startsWith(normalized));
  return sortAndLimitValues(hashes);
}

function listCacheResources(): {
  resources: {
    uri: string;
    name: string;
    title: string;
    description: string;
    mimeType: string;
    annotations: { audience: ['assistant']; priority: number };
  }[];
} {
  const resources = listCacheKeys()
    .map((key) => parseCacheKey(key))
    .filter((parts): parts is NonNullable<typeof parts> => Boolean(parts))
    .map((parts) => {
      const cacheParts: CacheResourceParts = {
        namespace: parts.namespace,
        hash: parts.urlHash,
      };
      const cacheKey = `${parts.namespace}:${parts.urlHash}`;
      const meta = getEntryMeta(cacheKey);
      if (!meta) return null; // expired between keys() and meta read — skip
      return {
        uri: toCacheResourceUri(cacheParts),
        name: `${parts.namespace}:${parts.urlHash}`,
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
    completionIndex.invalidate();

    const changedUri = toCacheResourceUri({
      namespace: event.namespace,
      hash: event.urlHash,
    });

    if (server.isConnected() && subscribedResourceUris.has(changedUri)) {
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

    if (!server.isConnected()) return;

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

function readCacheResource(
  uri: URL,
  variables: Record<string, TemplateVariableValue>
): ReadResourceResult {
  const parts = resolveCacheResourceParts(uri, variables);
  const cacheKey = `${parts.namespace}:${parts.hash}`;
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
    list: () => listCacheResources(),
    complete: {
      namespace: (value) => completeCacheNamespaces(value),
      hash: (value, context) => completeCacheHashes(value, context),
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
      readCacheResource(uri, normalizeTemplateVariables(variables))
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
2. Fresh: \`forceRefresh: true\` bypasses cache (does not fix truncation).
3. Async: \`task: { ttl: <ms> }\` in \`tools/call\` → poll \`tasks/get\` → \`tasks/result\`.

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
