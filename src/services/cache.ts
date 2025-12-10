import NodeCache from 'node-cache';
import { config } from '../config/index.js';
import type { CacheEntry } from '../types/index.js';

const cache = new NodeCache({
  stdTTL: config.cache.ttl,
  checkperiod: Math.floor(config.cache.ttl / 10),
  useClones: false,
  maxKeys: config.cache.maxKeys,
});

const stats = { hits: 0, misses: 0, sets: 0 };
// 5MB default max content size for cache entries
const maxContentSize = 5242880;

export function createCacheKey(namespace: string, url: string): string {
  return `${namespace}:${url}`;
}

export function get(cacheKey: string): CacheEntry | undefined {
  if (!config.cache.enabled) return undefined;

  // Use cache key directly - no need for cryptographic hashing
  // node-cache handles arbitrary string keys efficiently
  const entry = cache.get<CacheEntry>(cacheKey);
  if (entry) {
    stats.hits++;
    return entry;
  }

  stats.misses++;
  return undefined;
}

export function set(cacheKey: string, content: string): void {
  if (!config.cache.enabled) return;
  if (content.length > maxContentSize) return;

  const nowMs = Date.now();
  const entry: CacheEntry = {
    url: cacheKey,
    content,
    fetchedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + config.cache.ttl * 1000).toISOString(),
  };

  // Use cache key directly for better performance and debuggability
  cache.set(cacheKey, entry);
  stats.sets++;
}

export function clear(): void {
  cache.flushAll();
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
    hitRate: `${hitRate}%`,
  };
}

export function keys(): string[] {
  return cache.keys();
}
