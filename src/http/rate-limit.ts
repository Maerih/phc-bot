/**
 * Per-client rate limiting for public HTTP endpoints.
 *
 * The web search surface is open to the internet and every request fans out to
 * third-party APIs we are contractually obliged to poll politely. Without a
 * limiter here, one scripted client could burn through an upstream's daily
 * quota — Remotive asks for ~4 requests/day — and get the platform's access
 * revoked for everybody.
 *
 * Fixed-window counters, in-process. Phase 2 moves this to Redis so the limit
 * holds across replicas; the shape of the middleware does not change.
 */
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../core/logger.js';

const log = logger.child({ component: 'rate-limit' });

interface Window {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  /** Requests allowed per window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Label used in logs. */
  name: string;
}

/**
 * Identify the client.
 *
 * Behind a reverse proxy `req.ip` is the proxy, so the leftmost
 * `x-forwarded-for` entry is used when present. That header is client-supplied
 * and therefore spoofable — it is good enough for politeness limiting, which is
 * what this is, and must never be treated as authentication.
 */
function clientKey(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = raw?.split(',')[0]?.trim();
  return first && first.length > 0 ? first : (req.ip ?? 'unknown');
}

export function rateLimit(options: RateLimitOptions) {
  const windows = new Map<string, Window>();

  // Keep the map from growing without bound on a long-running process.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, window] of windows) {
      if (window.resetAt <= now) windows.delete(key);
    }
  }, options.windowMs);
  sweeper.unref();

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    const key = clientKey(req);
    const now = Date.now();
    const existing = windows.get(key);

    if (!existing || existing.resetAt <= now) {
      windows.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    existing.count += 1;

    if (existing.count > options.max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      res.setHeader('retry-after', String(retryAfterSeconds));
      res.status(429).json({
        error: 'too_many_requests',
        message: `Too many requests. Please wait ${retryAfterSeconds} seconds and try again.`,
        retryAfterSeconds,
      });
      // Logged once per window, not per rejected request, to avoid a limiter
      // that floods the logs being its own denial of service.
      if (existing.count === options.max + 1) {
        log.warn({ limiter: options.name }, 'client exceeded rate limit');
      }
      return;
    }

    next();
  };
}
