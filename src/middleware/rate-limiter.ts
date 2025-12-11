import type { Request, Response, NextFunction } from 'express';
import type { RateLimitEntry, RateLimiterOptions } from '../config/types.js';

const DEFAULT_OPTIONS: RateLimiterOptions = {
  maxRequests: 100,
  windowMs: 60000,
  cleanupIntervalMs: 60000,
};

const MIN_MAX_REQUESTS = 1;
const MAX_MAX_REQUESTS = 10000;
const MIN_WINDOW_MS = 1000;
const MAX_WINDOW_MS = 3600000;

class RateLimiter {
  private readonly store = new Map<string, RateLimitEntry>();
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options: Partial<RateLimiterOptions> = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    this.maxRequests = Math.min(
      Math.max(opts.maxRequests, MIN_MAX_REQUESTS),
      MAX_MAX_REQUESTS
    );
    this.windowMs = Math.min(
      Math.max(opts.windowMs, MIN_WINDOW_MS),
      MAX_WINDOW_MS
    );
    const cleanupInterval = Math.max(opts.cleanupIntervalMs, MIN_WINDOW_MS);

    this.cleanupInterval = setInterval(() => this.cleanup(), cleanupInterval);
    this.cleanupInterval.unref();
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.store.clear();
  }

  middleware(): (req: Request, res: Response, next: NextFunction) => void {
    return (req: Request, res: Response, next: NextFunction): void => {
      const key = this.getKey(req);
      const now = Date.now();

      let entry = this.store.get(key);

      if (!entry || now > entry.resetTime) {
        entry = { count: 0, resetTime: now + this.windowMs };
        this.store.set(key, entry);
      }

      entry.count++;

      if (entry.count > this.maxRequests) {
        const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
        res.set('Retry-After', String(retryAfter));
        res.status(429).json({
          error: 'Too many requests',
          retryAfter,
        });
        return;
      }

      res.set('X-RateLimit-Limit', String(this.maxRequests));
      res.set('X-RateLimit-Remaining', String(this.maxRequests - entry.count));
      res.set('X-RateLimit-Reset', String(Math.ceil(entry.resetTime / 1000)));

      next();
    };
  }

  private getKey(req: Request): string {
    let ip: string;

    const realIp = req.headers['x-real-ip'];
    if (typeof realIp === 'string' && realIp) {
      ip = realIp;
    } else {
      const forwardedFor = req.headers['x-forwarded-for'];
      if (typeof forwardedFor === 'string') {
        const firstIp = forwardedFor.split(',')[0]?.trim();
        if (firstIp) {
          ip = firstIp;
        } else {
          ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
        }
      } else {
        ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
      }
    }

    return ip.replace(/[^a-fA-F0-9.:]/g, '').substring(0, 45) || 'unknown';
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.resetTime < now) {
        this.store.delete(key);
      }
    }
  }
}

// Create default rate limiter instance
// Override via RateLimiter constructor if different values needed
export const rateLimiter = new RateLimiter({
  maxRequests: 100,
  windowMs: 60000,
});
