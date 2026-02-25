import { EventEmitter } from 'node:events';

import { z } from 'zod';

import { config } from './config.js';
import { sha256Hex } from './crypto.js';
import { getErrorMessage } from './errors.js';
import { stableStringify as stableJsonStringify } from './json.js';
import { logWarn } from './observability.js';

/* -------------------------------------------------------------------------------------------------
 * Schemas & Types
 * ------------------------------------------------------------------------------------------------- */

const CachedPayloadSchema = z.strictObject({
  content: z.string().optional(),
  markdown: z.string().optional(),
  title: z.string().optional(),
});
type CachedPayload = z.infer<typeof CachedPayloadSchema>;

// Cache Entry (Memory)
interface CacheEntry {
  url: string;
  title?: string;
  content: string;
  fetchedAt: string;
  expiresAt: string;
}

interface CacheKeyParts {
  namespace: string;
  urlHash: string;
}

interface CacheSetOptions {
  force?: boolean;
}

interface CacheGetOptions {
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

function resolveVaryString(
  vary: Record<string, unknown> | string
): string | null {
  if (typeof vary === 'string') return vary;

  try {
    return stableJsonStringify(vary);
  } catch {
    return null;
  }
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
    const varyString = resolveVaryString(vary);
    if (varyString === null) return null;

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

  private isExpired(entry: StoredCacheEntry, now = Date.now()): boolean {
    return entry.expiresAtMs <= now;
  }

  keys(): readonly string[] {
    if (!this.isEnabled()) return [];
    const now = Date.now();

    const result: string[] = [];
    for (const [key, entry] of this.entries) {
      if (!this.isExpired(entry, now)) result.push(key);
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
    if (this.isExpired(entry, now)) {
      this.delete(cacheKey);
      // listChanged=false: lazy eviction on read is silent — only writes change
      // the list. Clients must not rely on list-changed events from reads.
      this.notify(cacheKey, false);
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

  private evictOldestEntry(): boolean {
    const firstKey = this.entries.keys().next();
    return !firstKey.done && this.delete(firstKey.value);
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
      if (this.evictOldestEntry()) {
        listChanged = true;
      } else {
        break;
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
    if (this.entries.size > this.max && this.evictOldestEntry()) {
      listChanged = true;
    }

    this.notify(cacheKey, listChanged);
  }

  private notify(cacheKey: string, listChanged: boolean): void {
    if (this.updateEmitter.listenerCount('update') === 0) return;
    const parts = parseCacheKey(cacheKey);
    if (!parts) return;
    this.updateEmitter.emit('update', { cacheKey, ...parts, listChanged });
  }

  /**
   * Read an entry without updating its LRU position.
   * Use this for metadata access (e.g. resource listing) to avoid polluting the
   * eviction order; expired entries are treated as absent but not evicted here.
   */
  peek(cacheKey: string | null): CacheEntry | undefined {
    if (!cacheKey) return undefined;
    const entry = this.entries.get(cacheKey);
    if (!entry) return undefined;
    if (this.isExpired(entry)) return undefined;
    return entry;
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

/**
 * Return lightweight metadata (url and optional page title) for a cache entry.
 * Returns `undefined` if the key is not found or cache is disabled.
 */
export function getEntryMeta(
  cacheKey: string
): { url: string; title?: string } | undefined {
  const entry = store.peek(cacheKey);
  if (!entry) return undefined;
  return entry.title !== undefined
    ? { url: entry.url, title: entry.title }
    : { url: entry.url };
}

export function isEnabled(): boolean {
  return store.isEnabled();
}
