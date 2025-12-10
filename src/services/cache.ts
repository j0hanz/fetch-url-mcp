import NodeCache from 'node-cache';
import { config } from '../config/index.js';
import { logWarn } from './logger.js';
import type { CacheEntry } from '../types/index.js';

const cache = new NodeCache({
  stdTTL: config.cache.ttl,
  checkperiod: Math.floor(config.cache.ttl / 10),
  useClones: false,
  maxKeys: config.cache.maxKeys,
});

const stats = { hits: 0, misses: 0, sets: 0, errors: 0 };
// 5MB default max content size for cache entries
const MAX_CONTENT_SIZE = 5242880;
// Maximum cache key length to prevent memory issues
const MAX_KEY_LENGTH = 500;

/**
 * Creates a cache key from namespace and URL
 * Truncates long URLs to prevent memory issues
 * @returns Cache key string or null if inputs are invalid
 */
export function createCacheKey(namespace: string, url: string): string | null {
  if (!namespace || !url) {
    return null;
  }
  const key = `${namespace}:${url}`;
  // Truncate extremely long keys
  if (key.length > MAX_KEY_LENGTH) {
    return key.substring(0, MAX_KEY_LENGTH);
  }
  return key;
}

export function get(cacheKey: string | null): CacheEntry | undefined {
  if (!config.cache.enabled) return undefined;
  if (!cacheKey) return undefined;

  try {
    const entry = cache.get<CacheEntry>(cacheKey);
    if (entry) {
      stats.hits++;
      return entry;
    }

    stats.misses++;
    return undefined;
  } catch (error) {
    stats.errors++;
    logWarn('Cache get error', {
      key: cacheKey.substring(0, 100),
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return undefined;
  }
}

export function set(cacheKey: string | null, content: string): void {
  if (!config.cache.enabled) return;
  if (!cacheKey) return;
  if (!content || typeof content !== 'string') return;
  if (content.length > MAX_CONTENT_SIZE) {
    logWarn('Cache set skipped: content too large', {
      key: cacheKey.substring(0, 100),
      size: content.length,
      maxSize: MAX_CONTENT_SIZE,
    });
    return;
  }

  try {
    const nowMs = Date.now();
    const entry: CacheEntry = {
      url: cacheKey,
      content,
      fetchedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + config.cache.ttl * 1000).toISOString(),
    };

    cache.set(cacheKey, entry);
    stats.sets++;
  } catch (error) {
    stats.errors++;
    logWarn('Cache set error', {
      key: cacheKey.substring(0, 100),
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

export function getStats() {
  const total = stats.hits + stats.misses;
  const hitRate = total > 0 ? ((stats.hits / total) * 100).toFixed(2) : '0.00';

  return {
    size: cache.keys().length,
    maxKeys: config.cache.maxKeys,
    ttl: config.cache.ttl,
    hits: stats.hits,
    misses: stats.misses,
    sets: stats.sets,
    errors: stats.errors,
    hitRate: `${hitRate}%`,
  };
}
