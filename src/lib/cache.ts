import { EventEmitter } from 'node:events';

import { config } from './config.js';
import { logWarn } from './core.js';
import {
  getErrorMessage,
  sha256Hex,
  stableStringify as stableJsonStringify,
} from './utils.js';

const PRIMARY_HASH_LENGTH = 32;
const VARY_HASH_LENGTH = 16;

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

export function createCacheKey(
  namespace: string,
  url: string,
  vary?: Record<string, unknown> | string
): string | null {
  if (!namespace || !url) return null;

  const urlHash = sha256Hex(url).substring(0, PRIMARY_HASH_LENGTH);

  if (!vary) return `${namespace}:${urlHash}`;

  const varyString =
    typeof vary === 'string'
      ? vary
      : (() => {
          try {
            return stableJsonStringify(vary);
          } catch {
            return null;
          }
        })();
  if (varyString === null) return null;

  const varyHash = varyString
    ? sha256Hex(varyString).substring(0, VARY_HASH_LENGTH)
    : undefined;
  return varyHash
    ? `${namespace}:${urlHash}.${varyHash}`
    : `${namespace}:${urlHash}`;
}

export function parseCacheKey(cacheKey: string): CacheKeyParts | null {
  if (!cacheKey) return null;
  const separatorIndex = cacheKey.indexOf(':');
  if (separatorIndex === -1) return null;

  const namespace = cacheKey.slice(0, separatorIndex);
  const urlHash = cacheKey.slice(separatorIndex + 1);
  if (!namespace || !urlHash) return null;
  return { namespace, urlHash };
}

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

  private ensureCapacity(
    cacheKey: string,
    entrySize: number
  ): { ok: boolean; listChanged: boolean } {
    if (entrySize > this.maxBytes) {
      logWarn('Cache entry exceeds max size', {
        key: cacheKey,
        size: entrySize,
        max: this.maxBytes,
      });
      return { ok: false, listChanged: false };
    }

    let listChanged = false;
    while (this.currentBytes + entrySize > this.maxBytes) {
      if (this.evictOldestEntry()) {
        listChanged = true;
      } else {
        break;
      }
    }
    return { ok: true, listChanged };
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
    const entrySize = content.length;

    // Reject oversized entries before deleting the old one to avoid data loss
    if (entrySize > this.maxBytes) {
      logWarn('Cache entry exceeds max size', {
        key: cacheKey,
        size: entrySize,
        max: this.maxBytes,
      });
      return;
    }

    const isUpdate = this.entries.has(cacheKey);
    if (isUpdate) {
      this.delete(cacheKey);
    }

    const capacity = this.ensureCapacity(cacheKey, entrySize);
    if (!capacity.ok) return;

    let listChanged = !isUpdate || capacity.listChanged;

    const entry: StoredCacheEntry = {
      url: metadata.url,
      content,
      fetchedAt: new Date(now).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
      ...(metadata.title ? { title: metadata.title } : {}),
    };

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

const store = new InMemoryCacheStore();

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
export function getEntryMeta(
  cacheKey: string
): { url: string; title?: string; fetchedAt?: string } | undefined {
  const entry = store.peek(cacheKey);
  if (!entry) return undefined;
  return {
    url: entry.url,
    ...(entry.title !== undefined ? { title: entry.title } : {}),
    ...(entry.fetchedAt ? { fetchedAt: entry.fetchedAt } : {}),
  };
}
export function isEnabled(): boolean {
  return store.isEnabled();
}
