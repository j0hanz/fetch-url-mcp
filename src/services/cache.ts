import NodeCache from 'node-cache';
import { config } from '../config/index.js';
import { logDebug, logWarn } from './logger.js';
import type { CacheEntry } from '../types/index.js';

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

const stats = {
  hits: 0,
  misses: 0,
  sets: 0,
  errors: 0,
  htmlHits: 0,
  htmlMisses: 0,
};

const MAX_CONTENT_SIZE = 5242880;
const MAX_HTML_SIZE = 10485760;
const MAX_KEY_LENGTH = 500;

export function createCacheKey(namespace: string, url: string): string | null {
  if (!namespace || !url) return null;
  const key = `${namespace}:${url}`;
  return key.length > MAX_KEY_LENGTH ? key.substring(0, MAX_KEY_LENGTH) : key;
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
      stats.htmlHits++;
      logDebug('HTML cache hit', { url: url.substring(0, 100) });
      return html;
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

export function getStats() {
  const total = stats.hits + stats.misses;
  const hitRate = total > 0 ? ((stats.hits / total) * 100).toFixed(2) : '0.00';

  const htmlTotal = stats.htmlHits + stats.htmlMisses;
  const htmlHitRate =
    htmlTotal > 0 ? ((stats.htmlHits / htmlTotal) * 100).toFixed(2) : '0.00';

  return {
    size: contentCache.keys().length,
    maxKeys: config.cache.maxKeys,
    ttl: config.cache.ttl,
    hits: stats.hits,
    misses: stats.misses,
    sets: stats.sets,
    errors: stats.errors,
    hitRate: `${hitRate}%`,
    htmlCacheSize: htmlCache.keys().length,
    htmlCacheMaxKeys: HTML_CACHE_MAX_KEYS,
    htmlCacheTtl: HTML_CACHE_TTL,
    htmlHits: stats.htmlHits,
    htmlMisses: stats.htmlMisses,
    htmlHitRate: `${htmlHitRate}%`,
  };
}
