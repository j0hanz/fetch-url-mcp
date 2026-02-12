import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { posix as pathPosix } from 'node:path';

import { z } from 'zod';

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
  listChanged: boolean;
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

/* -------------------------------------------------------------------------------------------------
 * Core: In-Memory Store
 * ------------------------------------------------------------------------------------------------- */

class InMemoryCacheStore {
  private readonly max = config.cache.maxKeys;
  private readonly maxBytes = config.cache.maxSizeBytes;
  private readonly ttlMs = config.cache.ttl * 1000;

  private readonly entries = new Map<string, StoredCacheEntry>();
  private readonly updateEmitter = new EventEmitter();

  private currentBytes = 0;

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
      this.delete(cacheKey);
      this.notify(cacheKey, true);
      return undefined;
    }

    // Refresh LRU position
    this.entries.delete(cacheKey);
    this.entries.set(cacheKey, entry);

    return entry;
  }

  private delete(cacheKey: string): boolean {
    const entry = this.entries.get(cacheKey);
    if (entry) {
      this.currentBytes -= entry.content.length;
      this.entries.delete(cacheKey);
      return true;
    }
    return false;
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

    // Check size limit before insertion
    const entrySize = content.length;
    if (entrySize > this.maxBytes) {
      logWarn('Cache entry exceeds max size', {
        key: cacheKey,
        size: entrySize,
        max: this.maxBytes,
      });
      return;
    }

    let listChanged = !this.entries.has(cacheKey);

    // Evict if needed (size-based)
    while (this.currentBytes + entrySize > this.maxBytes) {
      const firstKey = this.entries.keys().next();
      if (firstKey.done) break;
      if (this.delete(firstKey.value)) {
        listChanged = true;
      }
    }

    const entry: StoredCacheEntry = {
      url: metadata.url,
      content,
      fetchedAt: new Date(now).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
      ...(metadata.title ? { title: metadata.title } : {}),
    };

    if (this.entries.has(cacheKey)) {
      this.delete(cacheKey);
    }

    this.entries.set(cacheKey, entry);
    this.currentBytes += entrySize;

    // Eviction (LRU: first insertion-order key) - Count based
    if (this.entries.size > this.max) {
      const firstKey = this.entries.keys().next();
      if (!firstKey.done && this.delete(firstKey.value)) {
        listChanged = true;
      }
    }

    this.notify(cacheKey, listChanged);
  }

  private notify(cacheKey: string, listChanged: boolean): void {
    if (this.updateEmitter.listenerCount('update') === 0) return;
    const parts = parseCacheKey(cacheKey);
    if (!parts) return;
    this.updateEmitter.emit('update', { cacheKey, ...parts, listChanged });
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
