import crypto from 'crypto';
import NodeCache from 'node-cache';

import { config } from '../config/index.js';
import type { CacheEntry } from '../config/types.js';

import { logDebug, logWarn } from './logger.js';

const HTML_CACHE_TTL = 60;
const HTML_CACHE_MAX_KEYS = 50;
const MAX_CONTENT_SIZE = 5242880;
const MAX_HTML_SIZE = 10485760;
const MAX_KEY_LENGTH = 500;

const contentCache = new NodeCache({
  stdTTL: config.cache.ttl,
  checkperiod: Math.floor(config.cache.ttl / 10),
  useClones: false,
  maxKeys: config.cache.maxKeys,
});

const htmlCache = new NodeCache({
  stdTTL: HTML_CACHE_TTL,
  checkperiod: 30,
  useClones: false,
  maxKeys: HTML_CACHE_MAX_KEYS,
});

export function createCacheKey(namespace: string, url: string): string | null {
  if (!namespace || !url) return null;
  const key = `${namespace}:${url}`;
  if (key.length <= MAX_KEY_LENGTH) return key;

  // SHA-256 hash for long URLs (consistent with cached-content.ts)
  const hash = crypto
    .createHash('sha256')
    .update(url)
    .digest('hex')
    .substring(0, 64);
  return `${namespace}:hash:${hash}`;
}

export function get(cacheKey: string | null): CacheEntry | undefined {
  if (!config.cache.enabled) return undefined;
  if (!cacheKey) return undefined;

  try {
    const entry = contentCache.get<CacheEntry>(cacheKey);
    if (entry) return entry;
    return undefined;
  } catch (error) {
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
  } catch (error) {
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
    if (html && typeof html === 'string' && html.length <= MAX_HTML_SIZE) {
      return html;
    }
    if (html) {
      // Invalid cache entry, remove it
      htmlCache.del(url);
      logWarn('Removed oversized HTML from cache', {
        url: url.substring(0, 100),
        size: html.length,
      });
    }
    return undefined;
  } catch (error) {
    logDebug('HTML cache get error (non-critical)', {
      url: url.substring(0, 100),
      error: error instanceof Error ? error.message : 'Unknown',
    });
    return undefined;
  }
}

export function setHtml(url: string, html: string): void {
  if (!config.cache.enabled) return;
  if (!html || html.length > MAX_HTML_SIZE) return;

  try {
    htmlCache.set(url, html);
  } catch (error) {
    logDebug('HTML cache set error (non-critical)', {
      url: url.substring(0, 100),
      error: error instanceof Error ? error.message : 'Unknown',
    });
  }
}

export function keys(): string[] {
  return [...contentCache.keys(), ...htmlCache.keys()];
}
