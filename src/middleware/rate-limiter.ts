import type { Request, Response, NextFunction } from 'express';

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

interface RateLimiterOptions {
  maxRequests: number;
  windowMs: number;
  cleanupIntervalMs: number;
}

const DEFAULT_OPTIONS: RateLimiterOptions = {
  maxRequests: 100,
  windowMs: 60000,
  cleanupIntervalMs: 60000,
};

class RateLimiter {
  private readonly store = new Map<string, RateLimitEntry>();
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options: Partial<RateLimiterOptions> = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    this.maxRequests = opts.maxRequests;
    this.windowMs = opts.windowMs;

    // Start cleanup interval
    this.cleanupInterval = setInterval(
      () => this.cleanup(),
      opts.cleanupIntervalMs
    );

    // Ensure interval doesn't prevent process exit
    this.cleanupInterval.unref();
  }

  /**
   * Destroys the rate limiter and cleans up resources
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.store.clear();
  }

  /**
   * Rate limiting middleware
   */
  middleware(): (req: Request, res: Response, next: NextFunction) => void {
    return (req: Request, res: Response, next: NextFunction): void => {
      const key = this.getKey(req);
      const now = Date.now();

      // Get or create entry
      let entry = this.store.get(key);

      // Reset if window has passed
      if (!entry || now > entry.resetTime) {
        entry = { count: 0, resetTime: now + this.windowMs };
        this.store.set(key, entry);
      }

      // Increment count
      entry.count++;

      // Check limit
      if (entry.count > this.maxRequests) {
        const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
        res.set('Retry-After', String(retryAfter));
        res.status(429).json({
          error: 'Too many requests',
          retryAfter,
        });
        return;
      }

      // Add rate limit headers
      res.set('X-RateLimit-Limit', String(this.maxRequests));
      res.set('X-RateLimit-Remaining', String(this.maxRequests - entry.count));
      res.set('X-RateLimit-Reset', String(Math.ceil(entry.resetTime / 1000)));

      next();
    };
  }

  /**
   * Get key for request (IP address)
   * Handles proxy configurations and provides fallback
   */
  private getKey(req: Request): string {
    // Priority: X-Real-IP > first X-Forwarded-For > req.ip > socket
    const realIp = req.headers['x-real-ip'];
    if (typeof realIp === 'string' && realIp) {
      return realIp;
    }

    const forwardedFor = req.headers['x-forwarded-for'];
    if (typeof forwardedFor === 'string') {
      const firstIp = forwardedFor.split(',')[0]?.trim();
      if (firstIp) {
        return firstIp;
      }
    }

    return req.ip ?? req.socket.remoteAddress ?? 'unknown';
  }

  /**
   * Clean up expired entries
   */
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
