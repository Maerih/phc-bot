/**
 * Per-member AI quota.
 *
 * The generic command rate limiter protects the platform; this protects the
 * bill. AI calls cost real money per token, so one member cannot spend the
 * community's budget — deliberately a separate, tighter limit rather than a
 * tweak to the shared bucket.
 *
 * In-process for Phase 1, like the other caches. Phase 2 moves it to Redis so
 * the limit holds across replicas.
 */
import { TtlCache } from '../core/cache.js';

const WINDOW_MS = 60 * 60 * 1000;

/** Calls allowed per member per hour. */
export const AI_CALLS_PER_HOUR = 15;

interface Usage {
  count: number;
  windowStartedAt: number;
}

const usage = new TtlCache<Usage>(WINDOW_MS, 5000);

export interface QuotaDecision {
  allowed: boolean;
  remaining: number;
  /** Minutes until the window resets, when the quota is exhausted. */
  resetInMinutes: number;
}

export function consumeAiQuota(memberId: string, now = Date.now()): QuotaDecision {
  const current = usage.get(memberId);

  if (!current || now - current.windowStartedAt >= WINDOW_MS) {
    usage.set(memberId, { count: 1, windowStartedAt: now });
    return { allowed: true, remaining: AI_CALLS_PER_HOUR - 1, resetInMinutes: 60 };
  }

  const resetInMinutes = Math.max(1, Math.ceil((current.windowStartedAt + WINDOW_MS - now) / 60_000));

  if (current.count >= AI_CALLS_PER_HOUR) {
    return { allowed: false, remaining: 0, resetInMinutes };
  }

  const next = { count: current.count + 1, windowStartedAt: current.windowStartedAt };
  usage.set(memberId, next);
  return {
    allowed: true,
    remaining: AI_CALLS_PER_HOUR - next.count,
    resetInMinutes,
  };
}

/** Exposed for tests. */
export function resetAiQuota(): void {
  usage.clear();
}
