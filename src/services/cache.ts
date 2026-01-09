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
  for await (const getNow of setIntervalPromise(intervalMs, Date.now, {
    signal,
    ref: false,
  })) {
    enforceCacheLimits(getNow());
  }
}

function enforceCacheLimits(now: number): void {
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
  const event = resolveCacheUpdateEvent(cacheKey);
  if (!event) return;
  for (const listener of updateListeners) {
    listener(event);
  }
}

function resolveCacheUpdateEvent(cacheKey: string): CacheUpdateEvent | null {
  if (updateListeners.size === 0) return null;
  const parts = parseCacheKey(cacheKey);
  return parts ? { cacheKey, ...parts } : null;
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
  const now = Date.now();
  return readCacheItem(cacheKey, now)?.entry;
}

function isExpired(item: CacheItem, now: number): boolean {
  return now > item.expiresAt;
}

function readCacheItem(cacheKey: string, now: number): CacheItem | undefined {
  const item = contentCache.get(cacheKey);
  if (!item) return undefined;

  if (isExpired(item, now)) {
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
    const now = Date.now();
    const expiresAtMs = now + config.cache.ttl * 1000;
    const entry = buildCacheEntry(content, metadata, now, expiresAtMs);
    persistCacheEntry(cacheKey, entry, expiresAtMs);
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
  metadata: CacheEntryMetadata,
  fetchedAtMs: number,
  expiresAtMs: number
): CacheEntry {
  return {
    url: metadata.url,
    content,
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    ...(metadata.title === undefined ? {} : { title: metadata.title }),
  };
}

function persistCacheEntry(
  cacheKey: string,
  entry: CacheEntry,
  expiresAtMs: number
): void {
  contentCache.set(cacheKey, { entry, expiresAt: expiresAtMs });
  trimCacheToMaxKeys();
  emitCacheUpdate(cacheKey);
}

function trimCacheToMaxKeys(): void {
  if (contentCache.size <= config.cache.maxKeys) return;
  removeOldestEntries(contentCache.size - config.cache.maxKeys);
}

function removeOldestEntries(count: number): void {
  const iterator = contentCache.keys();
  for (let removed = 0; removed < count; removed += 1) {
    const next = iterator.next();
    if (next.done) break;
    contentCache.delete(next.value);
  }
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
