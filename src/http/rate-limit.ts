import type { NextFunction, Request, Response } from 'express';

import type { RateLimitEntry, RateLimiterOptions } from '../config/types.js';

interface RateLimitConfig extends RateLimiterOptions {
  enabled: boolean;
}

interface RateLimitMiddlewareResult {
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  cleanupInterval: NodeJS.Timeout;
  store: Map<string, RateLimitEntry>;
}

function getRateLimitKey(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

function createCleanupInterval(
  store: Map<string, RateLimitEntry>,
  options: RateLimitConfig
): NodeJS.Timeout {
  return setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store.entries()) {
      if (now - entry.lastAccessed > options.windowMs * 2) {
        store.delete(key);
      }
    }
  }, options.cleanupIntervalMs);
}

export function createRateLimitMiddleware(
  options: RateLimitConfig
): RateLimitMiddlewareResult {
  const store = new Map<string, RateLimitEntry>();
  const cleanupInterval = createCleanupInterval(store, options);

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

  return { middleware, cleanupInterval, store };
}
