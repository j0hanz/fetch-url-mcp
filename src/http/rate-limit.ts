import { setInterval as setIntervalPromise } from 'node:timers/promises';

import type { NextFunction, Request, Response } from 'express';

import type { RateLimitEntry, RateLimiterOptions } from '../config/types.js';

interface RateLimitConfig extends RateLimiterOptions {
  enabled: boolean;
}

interface RateLimitMiddlewareResult {
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  stop: () => void;
  store: Map<string, RateLimitEntry>;
}

function getRateLimitKey(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

function createCleanupInterval(
  store: Map<string, RateLimitEntry>,
  options: RateLimitConfig
): AbortController {
  const controller = new AbortController();

  void startCleanupLoop(store, options, controller.signal).catch(
    handleCleanupError
  );

  return controller;
}

export function createRateLimitMiddleware(
  options: RateLimitConfig
): RateLimitMiddlewareResult {
  const store = new Map<string, RateLimitEntry>();
  const cleanupController = createCleanupInterval(store, options);
  const stop = (): void => {
    cleanupController.abort();
  };

  const middleware = (
    req: Request,
    res: Response,
    next: NextFunction
  ): void => {
    if (shouldSkipRateLimit(req, options)) {
      next();
      return;
    }

    const now = Date.now();
    const key = getRateLimitKey(req);
    const resolution = resolveRateLimitEntry(store, key, now, options);

    if (resolution.isNew) {
      next();
      return;
    }

    if (handleRateLimitExceeded(res, resolution.entry, now, options)) {
      return;
    }

    next();
  };

  return { middleware, stop, store };
}

async function startCleanupLoop(
  store: Map<string, RateLimitEntry>,
  options: RateLimitConfig,
  signal: AbortSignal
): Promise<void> {
  for await (const _ of setIntervalPromise(
    options.cleanupIntervalMs,
    undefined,
    { signal, ref: false }
  )) {
    evictStaleEntries(store, options, Date.now());
  }
}

function evictStaleEntries(
  store: Map<string, RateLimitEntry>,
  options: RateLimitConfig,
  now: number
): void {
  for (const [key, entry] of store.entries()) {
    if (now - entry.lastAccessed > options.windowMs * 2) {
      store.delete(key);
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function handleCleanupError(error: unknown): void {
  if (isAbortError(error)) {
    return;
  }
}

function shouldSkipRateLimit(req: Request, options: RateLimitConfig): boolean {
  return !options.enabled || req.method === 'OPTIONS';
}

function resolveRateLimitEntry(
  store: Map<string, RateLimitEntry>,
  key: string,
  now: number,
  options: RateLimitConfig
): { entry: RateLimitEntry; isNew: boolean } {
  const existing = store.get(key);
  if (!existing || now > existing.resetTime) {
    const entry = createNewEntry(now, options);
    store.set(key, entry);
    return { entry, isNew: true };
  }

  updateEntry(existing, now);
  return { entry: existing, isNew: false };
}

function createNewEntry(now: number, options: RateLimitConfig): RateLimitEntry {
  return {
    count: 1,
    resetTime: now + options.windowMs,
    lastAccessed: now,
  };
}

function updateEntry(entry: RateLimitEntry, now: number): void {
  entry.count += 1;
  entry.lastAccessed = now;
}

function handleRateLimitExceeded(
  res: Response,
  entry: RateLimitEntry,
  now: number,
  options: RateLimitConfig
): boolean {
  if (entry.count <= options.maxRequests) {
    return false;
  }

  const retryAfter = Math.max(1, Math.ceil((entry.resetTime - now) / 1000));
  res.set('Retry-After', String(retryAfter));
  res.status(429).json({
    error: 'Rate limit exceeded',
    retryAfter,
  });
  return true;
}
