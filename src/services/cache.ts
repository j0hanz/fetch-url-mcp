import { setInterval as setIntervalPromise } from 'node:timers/promises';

import { config } from '../config/index.js';
import type { CacheEntry } from '../config/types/content.js';

import { getErrorMessage } from '../utils/error-utils.js';

import type { CacheKeyParts } from './cache-keys.js';
import { parseCacheKey } from './cache-keys.js';
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
  void runCleanupLoop(cleanupController.signal).catch((error: unknown) => {
    if (error instanceof Error && error.name !== 'AbortError') {
      logWarn('Cache cleanup loop failed', { error: getErrorMessage(error) });
    }
  });
}

async function runCleanupLoop(signal: AbortSignal): Promise<void> {
  const intervalMs = Math.floor(config.cache.ttl * 1000);
  for await (const _ of setIntervalPromise(intervalMs, undefined, {
    signal,
    ref: false,
  })) {
    enforceCacheLimits();
  }
}

function enforceCacheLimits(): void {
  const now = Date.now();
  for (const [key, item] of contentCache.entries()) {
    if (now > item.expiresAt) {
      contentCache.delete(key);
    }
  }
  trimCacheToMaxKeys();
}

interface CacheUpdateEvent extends CacheKeyParts {
  cacheKey: string;
}

interface CacheEntryMetadata {
  url: string;
  title?: string;
}

type CacheUpdateListener = (event: CacheUpdateEvent) => void;

const updateListeners = new Set<CacheUpdateListener>();

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
  if (!isCacheReadable(cacheKey)) return undefined;
  return runCacheOperation(cacheKey, 'Cache get error', () =>
    readCacheEntry(cacheKey)
  );
}

function isCacheReadable(cacheKey: string | null): cacheKey is string {
  return config.cache.enabled && Boolean(cacheKey);
}

function isCacheWritable(
  cacheKey: string | null,
  content: string
): cacheKey is string {
  return config.cache.enabled && Boolean(cacheKey) && Boolean(content);
}

function runCacheOperation<T>(
  cacheKey: string,
  message: string,
  operation: () => T
): T | undefined {
  try {
    return operation();
  } catch (error) {
    logCacheError(message, cacheKey, error);
    return undefined;
  }
}

function readCacheEntry(cacheKey: string): CacheEntry | undefined {
  return readCacheItem(cacheKey)?.entry;
}

function isExpired(item: CacheItem): boolean {
  return Date.now() > item.expiresAt;
}

function readCacheItem(cacheKey: string): CacheItem | undefined {
  const item = contentCache.get(cacheKey);
  if (!item) return undefined;

  if (isExpired(item)) {
    contentCache.delete(cacheKey);
    return undefined;
  }

  return item;
}

export function set(
  cacheKey: string | null,
  content: string,
  metadata: CacheEntryMetadata
): void {
  if (!isCacheWritable(cacheKey, content)) return;
  runCacheOperation(cacheKey, 'Cache set error', () => {
    startCleanupLoop();
    const entry = buildCacheEntry(content, metadata);
    persistCacheEntry(cacheKey, entry);
  });
}

export function keys(): readonly string[] {
  return Array.from(contentCache.keys());
}

export function isEnabled(): boolean {
  return config.cache.enabled;
}

function buildCacheEntry(
  content: string,
  metadata: CacheEntryMetadata
): CacheEntry {
  return {
    url: metadata.url,
    content,
    fetchedAt: new Date().toISOString(),
    expiresAt: new Date(resolveExpiryTimestamp()).toISOString(),
    ...(metadata.title === undefined ? {} : { title: metadata.title }),
  };
}

function persistCacheEntry(cacheKey: string, entry: CacheEntry): void {
  const expiresAt = resolveExpiryTimestamp();
  contentCache.set(cacheKey, { entry, expiresAt });
  trimCacheToMaxKeys();
  emitCacheUpdate(cacheKey);
}

function trimCacheToMaxKeys(): void {
  if (contentCache.size <= config.cache.maxKeys) return;
  removeOldestEntries(contentCache.size - config.cache.maxKeys);
}

function removeOldestEntries(count: number): void {
  if (count <= 0) return;

  let removed = 0;
  for (const key of contentCache.keys()) {
    contentCache.delete(key);
    removed += 1;
    if (removed >= count) return;
  }
}

function resolveExpiryTimestamp(): number {
  return Date.now() + config.cache.ttl * 1000;
}

function logCacheError(
  message: string,
  cacheKey: string,
  error: unknown
): void {
  logWarn(message, {
    key: cacheKey.length > 100 ? cacheKey.slice(0, 100) : cacheKey,
    error: getErrorMessage(error),
  });
}
