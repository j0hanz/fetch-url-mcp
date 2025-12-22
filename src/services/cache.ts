import { createHash } from 'node:crypto';

import NodeCache from 'node-cache';

import { config } from '../config/index.js';
import type { CacheEntry } from '../config/types.js';

import { logWarn } from './logger.js';

const contentCache = new NodeCache({
  stdTTL: config.cache.ttl,
  checkperiod: Math.floor(config.cache.ttl / 10),
  useClones: false,
  maxKeys: config.cache.maxKeys,
});

export interface CacheKeyParts {
  namespace: string;
  urlHash: string;
}

interface CacheUpdateEvent extends CacheKeyParts {
  cacheKey: string;
}

type CacheUpdateListener = (event: CacheUpdateEvent) => void;

const updateListeners = new Set<CacheUpdateListener>();

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([key, entryValue]) =>
        `${JSON.stringify(key)}:${stableStringify(entryValue)}`
    );

  return `{${entries.join(',')}}`;
}

export function createCacheKey(
  namespace: string,
  url: string,
  vary?: Record<string, unknown> | string
): string | null {
  if (!namespace || !url) return null;

  // Hash URL for consistent key length and smaller memory footprint
  const urlHash = createHash('sha256')
    .update(url)
    .digest('hex')
    .substring(0, 16);

  if (!vary) {
    return `${namespace}:${urlHash}`;
  }

  const varyString = typeof vary === 'string' ? vary : stableStringify(vary);
  if (!varyString) {
    return `${namespace}:${urlHash}`;
  }

  const varyHash = createHash('sha256')
    .update(varyString)
    .digest('hex')
    .substring(0, 12);
  return `${namespace}:${urlHash}.${varyHash}`;
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

export function onCacheUpdate(listener: CacheUpdateListener): () => void {
  updateListeners.add(listener);
  return () => {
    updateListeners.delete(listener);
  };
}

function emitCacheUpdate(cacheKey: string): void {
  const parts = parseCacheKey(cacheKey);
  if (!parts) return;
  for (const listener of updateListeners) {
    listener({ cacheKey, ...parts });
  }
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
    emitCacheUpdate(cacheKey);
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
