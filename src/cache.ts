import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { posix as pathPosix } from 'node:path';

import { z } from 'zod';

import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ErrorCode,
  McpError,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { config } from './config.js';
import { sha256Hex } from './crypto.js';
import { getErrorMessage } from './errors.js';
import { stableStringify as stableJsonStringify } from './json.js';
import { logWarn } from './observability.js';

/* -------------------------------------------------------------------------------------------------
 * Schemas & Types
 * ------------------------------------------------------------------------------------------------- */

const CacheNamespace = z.literal('markdown');
const HashString = z
  .string()
  .regex(/^[a-f0-9.]+$/i)
  .min(8)
  .max(64);

const CachedPayloadSchema = z.strictObject({
  content: z.string().optional(),
  markdown: z.string().optional(),
  title: z.string().optional(),
});
export type CachedPayload = z.infer<typeof CachedPayloadSchema>;

// Cache Entry (Memory)
export interface CacheEntry {
  url: string;
  title?: string;
  content: string;
  fetchedAt: string;
  expiresAt: string;
}

export interface McpIcon {
  src: string;
  mimeType: string;
  sizes?: string[];
}

export interface CacheKeyParts {
  namespace: string;
  urlHash: string;
}

export interface CacheSetOptions {
  force?: boolean;
}

export interface CacheGetOptions {
  force?: boolean;
}

interface CacheEntryMetadata {
  url: string;
  title?: string;
}

interface StoredCacheEntry extends CacheEntry {
  expiresAtMs: number;
}

interface CacheUpdateEvent {
  cacheKey: string;
  namespace: string;
  urlHash: string;
}

type CacheUpdateListener = (event: CacheUpdateEvent) => unknown;

/* -------------------------------------------------------------------------------------------------
 * Core: Cache Key Logic
 * ------------------------------------------------------------------------------------------------- */

const CACHE_CONSTANTS = {
  URL_HASH_LENGTH: 32,
  VARY_HASH_LENGTH: 16,
} as const;

export function parseCachedPayload(raw: string): CachedPayload | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return CachedPayloadSchema.parse(parsed);
  } catch {
    return null;
  }
}

export function resolveCachedPayloadContent(
  payload: CachedPayload
): string | null {
  return payload.markdown ?? payload.content ?? null;
}

function createHashFragment(input: string, length: number): string {
  return sha256Hex(input).substring(0, length);
}

function buildCacheKey(
  namespace: string,
  urlHash: string,
  varyHash?: string
): string {
  return varyHash
    ? `${namespace}:${urlHash}.${varyHash}`
    : `${namespace}:${urlHash}`;
}

export function createCacheKey(
  namespace: string,
  url: string,
  vary?: Record<string, unknown> | string
): string | null {
  if (!namespace || !url) return null;

  const urlHash = createHashFragment(url, CACHE_CONSTANTS.URL_HASH_LENGTH);

  let varyHash: string | undefined;

  if (vary) {
    let varyString: string | null;
    if (typeof vary === 'string') {
      varyString = vary;
    } else {
      try {
        varyString = stableJsonStringify(vary);
      } catch {
        return null;
      }
    }
    if (varyString) {
      varyHash = createHashFragment(
        varyString,
        CACHE_CONSTANTS.VARY_HASH_LENGTH
      );
    }
  }

  return buildCacheKey(namespace, urlHash, varyHash);
}

export function parseCacheKey(cacheKey: string): CacheKeyParts | null {
  if (!cacheKey) return null;
  const [namespace, ...rest] = cacheKey.split(':');
  const urlHash = rest.join(':');
  if (!namespace || !urlHash) return null;
  return { namespace, urlHash };
}

export function toResourceUri(cacheKey: string): string | null {
  const parts = parseCacheKey(cacheKey);
  if (!parts) return null;
  return `superfetch://cache/${parts.namespace}/${parts.urlHash}`;
}

/* -------------------------------------------------------------------------------------------------
 * Core: In-Memory Store
 * ------------------------------------------------------------------------------------------------- */

class InMemoryCacheStore {
  private readonly max = config.cache.maxKeys;
  private readonly ttlMs = config.cache.ttl * 1000;

  private readonly entries = new Map<string, StoredCacheEntry>();
  private readonly updateEmitter = new EventEmitter();

  isEnabled(): boolean {
    return config.cache.enabled;
  }

  keys(): readonly string[] {
    if (!this.isEnabled()) return [];
    const now = Date.now();

    const result: string[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs > now) result.push(key);
    }
    return result;
  }

  onUpdate(listener: CacheUpdateListener): () => void {
    const wrapped = (event: CacheUpdateEvent): void => {
      try {
        const result = listener(event);
        if (result instanceof Promise) {
          void result.catch((error: unknown) => {
            this.logError(
              'Cache update listener failed (async)',
              event.cacheKey,
              error
            );
          });
        }
      } catch (error) {
        this.logError('Cache update listener failed', event.cacheKey, error);
      }
    };

    this.updateEmitter.on('update', wrapped);
    return () => {
      this.updateEmitter.off('update', wrapped);
    };
  }

  get(
    cacheKey: string | null,
    options?: CacheGetOptions
  ): CacheEntry | undefined {
    if (!cacheKey || (!this.isEnabled() && !options?.force)) return undefined;

    const entry = this.entries.get(cacheKey);
    if (!entry) return undefined;

    const now = Date.now();
    if (entry.expiresAtMs <= now) {
      this.entries.delete(cacheKey);
      return undefined;
    }

    // Refresh LRU position
    this.entries.delete(cacheKey);
    this.entries.set(cacheKey, entry);

    return entry;
  }

  set(
    cacheKey: string | null,
    content: string,
    metadata: CacheEntryMetadata,
    options?: CacheSetOptions
  ): void {
    if (!cacheKey || !content) return;
    if (!this.isEnabled() && !options?.force) return;

    const now = Date.now();
    const expiresAtMs = now + this.ttlMs;

    const entry: StoredCacheEntry = {
      url: metadata.url,
      content,
      fetchedAt: new Date(now).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
      ...(metadata.title ? { title: metadata.title } : {}),
    };

    this.entries.delete(cacheKey);
    this.entries.set(cacheKey, entry);

    // Eviction (LRU: first insertion-order key)
    if (this.entries.size > this.max) {
      const firstKey = this.entries.keys().next();
      if (!firstKey.done) this.entries.delete(firstKey.value);
    }

    this.notify(cacheKey);
  }

  private notify(cacheKey: string): void {
    if (this.updateEmitter.listenerCount('update') === 0) return;
    const parts = parseCacheKey(cacheKey);
    if (!parts) return;
    this.updateEmitter.emit('update', { cacheKey, ...parts });
  }

  private logError(message: string, cacheKey: string, error: unknown): void {
    logWarn(message, {
      key: cacheKey.length > 100 ? cacheKey.slice(0, 100) : cacheKey,
      error: getErrorMessage(error),
    });
  }
}

// Singleton Instance
const store = new InMemoryCacheStore();

// Public Proxy API
export function onCacheUpdate(listener: CacheUpdateListener): () => void {
  return store.onUpdate(listener);
}

export function get(
  cacheKey: string | null,
  options?: CacheGetOptions
): CacheEntry | undefined {
  return store.get(cacheKey, options);
}

export function set(
  cacheKey: string | null,
  content: string,
  metadata: CacheEntryMetadata,
  options?: CacheSetOptions
): void {
  store.set(cacheKey, content, metadata, options);
}

export function keys(): readonly string[] {
  return store.keys();
}

export function isEnabled(): boolean {
  return store.isEnabled();
}

/* -------------------------------------------------------------------------------------------------
 * Adapter: MCP Cached Content Resource
 * ------------------------------------------------------------------------------------------------- */

const CacheResourceParamsSchema = z.strictObject({
  namespace: CacheNamespace,
  urlHash: HashString,
});

function listCachedResources(): {
  resources: {
    name: string;
    uri: string;
    description: string;
    mimeType: string;
  }[];
} {
  const resources = store
    .keys()
    .map((key) => parseCacheKey(key))
    .filter(
      (parts): parts is CacheKeyParts =>
        parts !== null && parts.namespace === 'markdown'
    )
    .map(({ namespace, urlHash }) => ({
      name: `${namespace}:${urlHash}`,
      uri: `superfetch://cache/${namespace}/${urlHash}`,
      description: `Cached content entry for ${namespace}`,
      mimeType: 'text/markdown',
    }));

  return { resources };
}

function resolveCachedMarkdownText(raw: string): string | null {
  if (!raw) return null;

  const payload = parseCachedPayload(raw);
  if (payload) return resolveCachedPayloadContent(payload);

  const trimmed = raw.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return null;

  return raw;
}

export function registerCachedContentResource(
  server: McpServer,
  serverIcons?: McpIcon[]
): void {
  server.registerResource(
    'cached-content',
    new ResourceTemplate('superfetch://cache/{namespace}/{urlHash}', {
      list: listCachedResources,
    }),
    {
      title: 'Cached Content',
      description: 'Access previously fetched web content from cache.',
      mimeType: 'text/markdown',
      ...(serverIcons ? { icons: serverIcons } : {}),
    },
    (uri, params) => {
      const parsed = CacheResourceParamsSchema.safeParse(params);
      if (!parsed.success) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'Invalid resource parameters'
        );
      }

      const { namespace, urlHash } = parsed.data;
      const cacheKey = `${namespace}:${urlHash}`;

      const cached = store.get(cacheKey, { force: true });
      if (!cached) {
        throw new McpError(-32002, `Content not found: ${cacheKey}`);
      }

      const text = resolveCachedMarkdownText(cached.content);
      if (!text) {
        throw new McpError(ErrorCode.InternalError, 'Cached content invalid');
      }

      return {
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text }],
      };
    }
  );

  // Subscriptions (session scoped)
  const subscriptionsByScope = new Map<string, Set<string>>();
  const DEFAULT_SCOPE = '__default__';

  interface SubscriptionExtra {
    sessionId?: string;
    requestInfo?: { headers?: Record<string, string | string[] | undefined> };
  }

  function resolveScope(extra?: SubscriptionExtra): string {
    if (extra?.sessionId) return extra.sessionId;

    const headerValue = extra?.requestInfo?.headers?.['mcp-session-id'];
    if (typeof headerValue === 'string' && headerValue.trim().length > 0) {
      return headerValue.trim();
    }
    if (Array.isArray(headerValue)) {
      const first = headerValue[0];
      if (typeof first === 'string' && first.trim().length > 0) {
        return first.trim();
      }
    }

    return DEFAULT_SCOPE;
  }

  function addSubscription(scope: string, uri: string): void {
    const set = subscriptionsByScope.get(scope);
    if (set) {
      set.add(uri);
      return;
    }
    subscriptionsByScope.set(scope, new Set([uri]));
  }

  function removeSubscription(scope: string, uri: string): void {
    const set = subscriptionsByScope.get(scope);
    if (!set) return;
    set.delete(uri);
    if (set.size === 0) subscriptionsByScope.delete(scope);
  }

  function hasSubscription(uri: string): boolean {
    for (const uris of subscriptionsByScope.values()) {
      if (uris.has(uri)) return true;
    }
    return false;
  }

  server.server.setRequestHandler(SubscribeRequestSchema, (req, extra) => {
    if (!isValidCacheUri(req.params.uri)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid resource URI');
    }

    addSubscription(
      resolveScope(extra as SubscriptionExtra | undefined),
      req.params.uri
    );
    return {};
  });

  server.server.setRequestHandler(UnsubscribeRequestSchema, (req, extra) => {
    if (!isValidCacheUri(req.params.uri)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid resource URI');
    }

    removeSubscription(
      resolveScope(extra as SubscriptionExtra | undefined),
      req.params.uri
    );
    return {};
  });

  // Notifications
  let initialized = false;
  const originalOnInitialized = server.server.oninitialized;
  server.server.oninitialized = () => {
    initialized = true;
    originalOnInitialized?.();
  };

  store.onUpdate(({ cacheKey }) => {
    if (!server.isConnected() || !initialized) return;

    // Check capabilities via unsafe cast (SDK limitation)
    const capabilities = server.server.getClientCapabilities() as
      | { resources?: { listChanged?: boolean; subscribe?: boolean } }
      | undefined;

    const uri = toResourceUri(cacheKey);

    if (capabilities?.resources?.subscribe && uri && hasSubscription(uri)) {
      void server.server
        .sendResourceUpdated({ uri })
        .catch((error: unknown) => {
          logWarn('Failed to send update', {
            uri,
            error: getErrorMessage(error),
          });
        });
    }

    if (capabilities?.resources?.listChanged) {
      void server.server.sendResourceListChanged().catch(() => {});
    }
  });
}

function isValidCacheUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'superfetch:' || url.hostname !== 'cache')
      return false;
    if (url.search || url.hash) return false;
    const parts = url.pathname.split('/').filter(Boolean);
    return parts.length === 2 && parts[0] === 'markdown';
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Utils: Filename Logic
 * ------------------------------------------------------------------------------------------------- */

const FILENAME_RULES = {
  MAX_LEN: 200,
  UNSAFE_CHARS: /[<>:"/\\|?*\p{C}]/gu,
  WHITESPACE: /\s+/g,
  EXTENSIONS: /\.(html?|php|aspx?|jsp)$/i,
} as const;

function sanitizeString(input: string): string {
  return input
    .toLowerCase()
    .replace(FILENAME_RULES.UNSAFE_CHARS, '')
    .replace(FILENAME_RULES.WHITESPACE, '-')
    .replace(/-+/g, '-')
    .replace(/(?:^-|-$)/g, '');
}

export function generateSafeFilename(
  url: string,
  title?: string,
  hashFallback?: string,
  extension = '.md'
): string {
  const tryUrl = (): string | null => {
    try {
      if (!URL.canParse(url)) return null;
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        return null;

      const { pathname } = parsed;
      const basename = pathPosix.basename(pathname);
      if (!basename || basename === 'index') return null;

      const cleaned = basename.replace(FILENAME_RULES.EXTENSIONS, '');
      const sanitized = sanitizeString(cleaned);

      if (sanitized === 'index') return null;
      return sanitized || null;
    } catch {
      return null;
    }
  };

  const tryTitle = (): string | null => {
    if (!title) return null;
    return sanitizeString(title) || null;
  };

  const name =
    tryUrl() ??
    tryTitle() ??
    hashFallback?.substring(0, 16) ??
    `download-${Date.now()}`;

  const maxBase = FILENAME_RULES.MAX_LEN - extension.length;
  const truncated = name.length > maxBase ? name.substring(0, maxBase) : name;

  return `${truncated}${extension}`;
}

/* -------------------------------------------------------------------------------------------------
 * Adapter: Download Handler
 * ------------------------------------------------------------------------------------------------- */

const DownloadParamsSchema = z.strictObject({
  namespace: CacheNamespace,
  hash: HashString,
});

export function handleDownload(
  res: ServerResponse,
  namespace: string,
  hash: string
): void {
  const respond = (status: number, msg: string, code: string): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg, code }));
  };

  const parsed = DownloadParamsSchema.safeParse({ namespace, hash });
  if (!parsed.success) {
    respond(400, 'Invalid namespace or hash', 'BAD_REQUEST');
    return;
  }

  const cacheKey = `${parsed.data.namespace}:${parsed.data.hash}`;
  const entry = store.get(cacheKey, { force: true });

  if (!entry) {
    respond(404, 'Not found or expired', 'NOT_FOUND');
    return;
  }

  const payload = parseCachedPayload(entry.content);
  const content = payload ? resolveCachedPayloadContent(payload) : null;

  if (!content) {
    respond(404, 'Content missing', 'NOT_FOUND');
    return;
  }

  const fileName = generateSafeFilename(
    entry.url,
    payload?.title,
    parsed.data.hash
  );

  // Safe header generation
  const encoded = encodeURIComponent(fileName).replace(/'/g, '%27');

  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${fileName}"; filename*=UTF-8''${encoded}`
  );
  res.setHeader('Cache-Control', `private, max-age=${config.cache.ttl}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(content);
}
