import { setInterval as setIntervalPromise } from 'node:timers/promises';

import { logWarn } from '../observability.js';
import { type RequestContext, sendJson } from './helpers.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  count: number;
  resetTime: number;
  lastAccessed: number;
}

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  cleanupIntervalMs: number;
  enabled: boolean;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export interface RateLimitManagerImpl {
  check(ctx: RequestContext): boolean;
  stop(): void;
}

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

class RateLimiter implements RateLimitManagerImpl {
  private readonly store = new Map<string, RateLimitEntry>();
  private readonly cleanup = new AbortController();

  constructor(private readonly options: RateLimitConfig) {
    this.startCleanupLoop();
  }

  private startCleanupLoop(): void {
    const interval = setIntervalPromise(
      this.options.cleanupIntervalMs,
      Date.now,
      { signal: this.cleanup.signal, ref: false }
    );

    void (async () => {
      try {
        for await (const getNow of interval) {
          this.cleanupEntries(getNow());
        }
      } catch (err) {
        if (!isAbortError(err)) {
          logWarn('Rate limit cleanup failed', { error: err });
        }
      }
    })();
  }

  private cleanupEntries(now: number): void {
    const maxIdle = this.options.windowMs * 2;
    for (const [key, entry] of this.store.entries()) {
      if (now - entry.lastAccessed > maxIdle) {
        this.store.delete(key);
      }
    }
  }

  check(ctx: RequestContext): boolean {
    if (!this.options.enabled || ctx.method === 'OPTIONS') return true;

    const key = ctx.ip ?? 'unknown';
    const now = Date.now();
    let entry = this.store.get(key);

    if (entry) {
      if (now > entry.resetTime) {
        entry.count = 1;
        entry.resetTime = now + this.options.windowMs;
        entry.lastAccessed = now;
      } else {
        entry.count += 1;
        entry.lastAccessed = now;
      }
    } else {
      entry = {
        count: 1,
        resetTime: now + this.options.windowMs,
        lastAccessed: now,
      };
      this.store.set(key, entry);
    }

    if (entry.count > this.options.maxRequests) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetTime - now) / 1000));
      ctx.res.setHeader('Retry-After', String(retryAfter));
      sendJson(ctx.res, 429, { error: 'Rate limit exceeded', retryAfter });
      return false;
    }

    return true;
  }

  stop(): void {
    this.cleanup.abort();
  }
}

export function createRateLimitManagerImpl(
  options: RateLimitConfig
): RateLimitManagerImpl {
  return new RateLimiter(options);
}
