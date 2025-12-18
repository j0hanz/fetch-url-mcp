import NodeCache from 'node-cache';

import { config } from '../config/index.js';
import type { CacheEntry } from '../config/types.js';

import { logWarn } from './logger.js';

const MAX_KEY_LENGTH = 500;

const contentCache = new NodeCache({
  stdTTL: config.cache.ttl,
  checkperiod: Math.floor(config.cache.ttl / 10),
  useClones: false,
  maxKeys: config.cache.maxKeys,
});

export function createCacheKey(namespace: string, url: string): string | null {
  if (!namespace || !url) return null;

  const key = `${namespace}:${url}`;
  return key.length <= MAX_KEY_LENGTH ? key : key.substring(0, MAX_KEY_LENGTH);
}

export function get(cacheKey: string | null): CacheEntry | undefined {
  if (!config.cache.enabled || !cacheKey) {
    return undefined;
  }

  try {
    return contentCache.get<CacheEntry>(cacheKey);
  } catch (error) {
    logWarn('Cache get error', {
      key: cacheKey.substring(0, 100),
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return undefined;
  }
}

export function set(cacheKey: string | null, content: string): void {
  if (!config.cache.enabled || !cacheKey || !content) return;

  try {
    const entry: CacheEntry = {
      url: cacheKey,
      content,
      fetchedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + config.cache.ttl * 1000).toISOString(),
    };
    contentCache.set(cacheKey, entry);
  } catch (error) {
    logWarn('Cache set error', {
      key: cacheKey.substring(0, 100),
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

export function keys(): string[] {
  return contentCache.keys();
}
