import crypto from 'crypto';
import NodeCache from 'node-cache';

import { config } from '../config/index.js';
import type { CacheEntry } from '../config/types.js';

import { logDebug, logWarn } from './logger.js';

const contentCache = new NodeCache({
  stdTTL: config.cache.ttl,
  checkperiod: Math.floor(config.cache.ttl / 10),
  useClones: false,
  maxKeys: config.cache.maxKeys,
});

const HTML_CACHE_TTL = 60;
const HTML_CACHE_MAX_KEYS = 50;
const htmlCache = new NodeCache({
  stdTTL: HTML_CACHE_TTL,
  checkperiod: 30,
  useClones: false,
  maxKeys: HTML_CACHE_MAX_KEYS,
});

// Track cache evictions
contentCache.on('del', (key) => {
  stats.evictions++;
  logDebug('Cache eviction', { key: String(key).substring(0, 100) });
});

htmlCache.on('del', () => {
  stats.htmlEvictions++;
});

const stats = {
  hits: 0,
  misses: 0,
  sets: 0,
  errors: 0,
  evictions: 0,
  htmlHits: 0,
  htmlMisses: 0,
  htmlEvictions: 0,
};

const MAX_CONTENT_SIZE = 5242880;
const MAX_HTML_SIZE = 10485760;
const MAX_KEY_LENGTH = 500;

// LRU cache for hash results to avoid recomputing hashes
const hashCache = new Map<string, string>();
const MAX_HASH_CACHE_SIZE = 100;

export function createCacheKey(namespace: string, url: string): string | null {
  if (!namespace || !url) return null;
  const key = `${namespace}:${url}`;
  if (key.length <= MAX_KEY_LENGTH) return key;

  // Check hash cache first
  let hash = hashCache.get(url);
  if (!hash) {
    // Use SHA-1 (faster than SHA-256) with truncation for cache keys
    hash = crypto.createHash('sha1').update(url).digest('hex').substring(0, 40);

    // Maintain LRU behavior
    if (hashCache.size >= MAX_HASH_CACHE_SIZE) {
      const firstKey = hashCache.keys().next().value;
      if (firstKey) hashCache.delete(firstKey);
    }
    hashCache.set(url, hash);
  }

  return `${namespace}:hash:${hash}`;
}

export function get(cacheKey: string | null): CacheEntry | undefined {
  if (!config.cache.enabled) return undefined;
  if (!cacheKey) return undefined;

  try {
    const entry = contentCache.get<CacheEntry>(cacheKey);
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

    contentCache.set(cacheKey, entry);
    stats.sets++;
  } catch (error) {
    stats.errors++;
    logWarn('Cache set error', {
      key: cacheKey.substring(0, 100),
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

export function getHtml(url: string): string | undefined {
  if (!config.cache.enabled) return undefined;

  try {
    const html = htmlCache.get<string>(url);
    if (html) {
      // Validate cached HTML is within limits
      if (typeof html === 'string' && html.length <= MAX_HTML_SIZE) {
        stats.htmlHits++;
        logDebug('HTML cache hit', { url: url.substring(0, 100) });
        return html;
      }
      // Invalid cache entry, remove it
      htmlCache.del(url);
      logWarn('Removed oversized HTML from cache', {
        url: url.substring(0, 100),
        size: html.length,
      });
    }
    stats.htmlMisses++;
    return undefined;
  } catch {
    return undefined;
  }
}

export function setHtml(url: string, html: string): void {
  if (!config.cache.enabled) return;
  if (!html || html.length > MAX_HTML_SIZE) return;

  try {
    htmlCache.set(url, html);
    logDebug('HTML cached', { url: url.substring(0, 100), size: html.length });
  } catch {
    // Ignore HTML cache errors
  }
}

export function getStats(): {
  size: number;
  maxKeys: number;
  ttl: number;
  hits: number;
  misses: number;
  sets: number;
  errors: number;
  evictions: number;
  hitRate: string;
  htmlCacheSize: number;
  htmlCacheMaxKeys: number;
  htmlCacheTtl: number;
  htmlHits: number;
  htmlMisses: number;
  htmlEvictions: number;
  htmlHitRate: string;
  efficiency: {
    hitRate: string;
    missRate: string;
    errorRate: string;
  };
} {
  const total = stats.hits + stats.misses;
  const hitRate = total > 0 ? ((stats.hits / total) * 100).toFixed(2) : '0.00';

  const htmlTotal = stats.htmlHits + stats.htmlMisses;
  const htmlHitRate =
    htmlTotal > 0 ? ((stats.htmlHits / htmlTotal) * 100).toFixed(2) : '0.00';

  const missRate =
    total > 0 ? ((stats.misses / total) * 100).toFixed(2) : '0.00';
  const errorRate =
    stats.sets > 0 ? ((stats.errors / stats.sets) * 100).toFixed(2) : '0.00';

  return {
    size: contentCache.keys().length,
    maxKeys: config.cache.maxKeys,
    ttl: config.cache.ttl,
    hits: stats.hits,
    misses: stats.misses,
    sets: stats.sets,
    errors: stats.errors,
    evictions: stats.evictions,
    hitRate: `${hitRate}%`,
    htmlCacheSize: htmlCache.keys().length,
    htmlCacheMaxKeys: HTML_CACHE_MAX_KEYS,
    htmlCacheTtl: HTML_CACHE_TTL,
    htmlHits: stats.htmlHits,
    htmlMisses: stats.htmlMisses,
    htmlEvictions: stats.htmlEvictions,
    htmlHitRate: `${htmlHitRate}%`,
    efficiency: {
      hitRate: `${hitRate}%`,
      missRate: `${missRate}%`,
      errorRate: `${errorRate}%`,
    },
  };
}
