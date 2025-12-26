import { hash } from 'node:crypto';
import { setInterval as setIntervalPromise } from 'node:timers/promises';

import { config } from '../config/index.js';
import type { CacheEntry } from '../config/types.js';

import { logWarn } from './logger.js';

interface CacheItem {
  entry: CacheEntry;
  expiresAt: number;
}

const contentCache = new Map<string, CacheItem>();
let cleanupController: AbortController | null = null;

function startCleanupLoop(): void {
  if (cleanupController) return;
  cleanupController = new AbortController();
  void runCleanupLoop(cleanupController.signal).catch(() => {});
}

async function runCleanupLoop(signal: AbortSignal): Promise<void> {
  const intervalMs = Math.floor(config.cache.ttl * 100);
  for await (const _ of setIntervalPromise(intervalMs, undefined, {
    signal,
    ref: false,
  })) {
    evictExpiredEntries();
  }
}

function evictExpiredEntries(): void {
  const now = Date.now();
  for (const [key, item] of contentCache.entries()) {
    if (now > item.expiresAt) {
      contentCache.delete(key);
    }
  }
  enforceMaxKeys();
}

function enforceMaxKeys(): void {
  if (contentCache.size <= config.cache.maxKeys) return;
  const keysToRemove = contentCache.size - config.cache.maxKeys;
  const iterator = contentCache.keys();
  for (let i = 0; i < keysToRemove; i++) {
    const { value, done } = iterator.next();
    if (done) break;
    contentCache.delete(value);
  }
}

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

function createHashFragment(input: string, length: number): string {
  return hash('sha256', input, 'hex').substring(0, length);
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

function getVaryHash(
  vary?: Record<string, unknown> | string
): string | undefined {
  if (!vary) return undefined;
  const varyString = typeof vary === 'string' ? vary : stableStringify(vary);
  if (!varyString) return undefined;
  return createHashFragment(varyString, 12);
}

export function createCacheKey(
  namespace: string,
  url: string,
  vary?: Record<string, unknown> | string
): string | null {
  if (!namespace || !url) return null;

  const urlHash = createHashFragment(url, 16);
  const varyHash = getVaryHash(vary);
  return buildCacheKey(namespace, urlHash, varyHash);
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
    const item = contentCache.get(cacheKey);
    if (!item) return undefined;
    if (Date.now() > item.expiresAt) {
      contentCache.delete(cacheKey);
      return undefined;
    }
    return item.entry;
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
  if (!content) return;

  try {
    startCleanupLoop();
    const entry = buildCacheEntry(cacheKey, content);
    persistCacheEntry(cacheKey, entry);
  } catch (error) {
    logWarn('Cache set error', {
      key: cacheKey.substring(0, 100),
      error: resolveErrorMessage(error),
    });
  }
}

export function keys(): string[] {
  return Array.from(contentCache.keys());
}

function buildCacheEntry(cacheKey: string, content: string): CacheEntry {
  return {
    url: cacheKey,
    content,
    fetchedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + config.cache.ttl * 1000).toISOString(),
  };
}

function persistCacheEntry(cacheKey: string, entry: CacheEntry): void {
  const expiresAt = Date.now() + config.cache.ttl * 1000;
  contentCache.set(cacheKey, { entry, expiresAt });
  emitCacheUpdate(cacheKey);
}

function resolveErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}
