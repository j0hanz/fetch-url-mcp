import { logWarn } from '../lib/core.js';
import { isAbortError } from '../lib/utils.js';
import { startAbortableIntervalLoop } from '../lib/utils.js';

import { type RequestContext, sendJson } from './helpers.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  count: number;
  resetTime: number;
  lastAccessed: number;
}

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  cleanupIntervalMs: number;
  enabled: boolean;
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
    startAbortableIntervalLoop(this.options.cleanupIntervalMs, Date.now, {
      signal: this.cleanup.signal,
      onTick: (getNow) => {
        this.cleanupEntries(getNow());
      },
      onError: (err) => {
        if (!isAbortError(err)) {
          logWarn('Rate limit cleanup failed', { error: err });
        }
      },
    });
  }

  private cleanupEntries(now: number): void {
    const maxIdle = this.options.windowMs * 2;
    for (const [key, entry] of this.store.entries()) {
      if (now - entry.lastAccessed > maxIdle) {
        this.store.delete(key);
      }
    }
  }

  private resetEntry(entry: RateLimitEntry, now: number): void {
    entry.count = 1;
    entry.resetTime = now + this.options.windowMs;
    entry.lastAccessed = now;
  }

  private incrementEntry(entry: RateLimitEntry, now: number): void {
    entry.count += 1;
    entry.lastAccessed = now;
  }

  private createEntry(now: number): RateLimitEntry {
    return {
      count: 1,
      resetTime: now + this.options.windowMs,
      lastAccessed: now,
    };
  }

  check(ctx: RequestContext): boolean {
    if (!this.options.enabled || ctx.method === 'OPTIONS') return true;

    if (!ctx.ip) return true; // no identifiable IP (e.g. Unix socket) — bypass rate limiting
    const key = ctx.ip;
    const now = Date.now();
    let entry = this.store.get(key);

    if (entry) {
      if (now > entry.resetTime) {
        this.resetEntry(entry, now);
      } else {
        this.incrementEntry(entry, now);
      }
    } else {
      entry = this.createEntry(now);
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
