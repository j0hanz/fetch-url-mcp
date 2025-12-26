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

  void (async () => {
    try {
      for await (const _ of setIntervalPromise(
        options.cleanupIntervalMs,
        undefined,
        { signal: controller.signal, ref: false }
      )) {
        const now = Date.now();
        for (const [key, entry] of store.entries()) {
          if (now - entry.lastAccessed > options.windowMs * 2) {
            store.delete(key);
          }
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
    }
  })();

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
    if (!options.enabled || req.method === 'OPTIONS') {
      next();
      return;
    }

    const now = Date.now();
    const key = getRateLimitKey(req);
    const existing = store.get(key);

    if (!existing || now > existing.resetTime) {
      store.set(key, {
        count: 1,
        resetTime: now + options.windowMs,
        lastAccessed: now,
      });
      next();
      return;
    }

    existing.count += 1;
    existing.lastAccessed = now;

    if (existing.count > options.maxRequests) {
      const retryAfter = Math.max(
        1,
        Math.ceil((existing.resetTime - now) / 1000)
      );
      res.set('Retry-After', String(retryAfter));
      res.status(429).json({
        error: 'Rate limit exceeded',
        retryAfter,
      });
      return;
    }

    next();
  };

  return { middleware, stop, store };
}
