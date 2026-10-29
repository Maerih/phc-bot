/**
 * Source registry and fan-out.
 *
 * Responsibilities:
 *  - know which connectors exist and which the operator enabled
 *  - run them concurrently, each isolated behind its own timeout
 *  - honour each upstream's minimum fetch interval via the result cache
 *  - never let one failing source fail the request
 *
 * That last point is the whole reason this layer exists: a member searching
 * for a scholarship should still get results when one job board is down.
 */
import { env } from '../config/env.js';
import { TtlCache } from '../core/cache.js';
import { logger } from '../core/logger.js';
import { normalizeMany, type NormalizedOpportunity } from '../domain/normalize.js';
import { arbeitnowConnector } from './jobs/arbeitnow.js';
import { greenhouseConnector } from './jobs/greenhouse.js';
import { jobicyConnector } from './jobs/jobicy.js';
import { remoteOkConnector } from './jobs/remoteok.js';
import { reliefwebConnector } from './jobs/reliefweb.js';
import { remotiveConnector } from './jobs/remotive.js';
import type { SearchQuery, SourceConnector, SourceResult } from './types.js';

const log = logger.child({ component: 'sources' });

/** Hard ceiling on any single upstream call. */
const FETCH_TIMEOUT_MS = 12_000;

/** Every connector that exists, enabled or not. */
export const ALL_CONNECTORS: readonly SourceConnector[] = [
  greenhouseConnector,
  remotiveConnector,
  arbeitnowConnector,
  jobicyConnector,
  remoteOkConnector,
  reliefwebConnector,
];

/**
 * Cache of normalised results per (source, query) pair. TTL comes from each
 * connector's `minFetchIntervalMinutes`, so a polite source is polled politely
 * without any caller having to remember to.
 */
const resultCache = new TtlCache<NormalizedOpportunity[]>(60 * 60 * 1000, 300);

function cacheKey(slug: string, query: SearchQuery): string {
  return [
    slug,
    query.terms.toLowerCase().trim(),
    query.types.join('+'),
    query.countries.join('+'),
    query.region ?? '',
    query.remoteOnly ? 'remote' : '',
  ].join('|');
}

/** Connectors the operator enabled that are also actually usable. */
export function activeConnectors(): SourceConnector[] {
  const enabled = new Set(env.SOURCES_ENABLED);
  return ALL_CONNECTORS.filter((connector) => enabled.has(connector.meta.slug));
}

export interface FanOutResult {
  opportunities: NormalizedOpportunity[];
  results: SourceResult[];
}

/**
 * Query every active connector and return their combined normalised output.
 *
 * Uses `allSettled` semantics deliberately: the array returned always contains
 * one entry per attempted source, including failures, so the caller can report
 * partial degradation honestly instead of pretending it searched everything.
 */
export async function fanOut(query: SearchQuery): Promise<FanOutResult> {
  const connectors = activeConnectors();

  if (connectors.length === 0) {
    log.warn('no sources enabled — set SOURCES_ENABLED in .env');
    return { opportunities: [], results: [] };
  }

  const settled = await Promise.all(
    connectors.map((connector) => runConnector(connector, query)),
  );

  const opportunities = settled.flatMap((entry) => entry.opportunities);
  const results = settled.map((entry) => entry.result);

  const failed = results.filter((result) => !result.ok).map((result) => result.slug);
  if (failed.length > 0) {
    log.warn({ failed, total: results.length }, 'some sources failed; serving partial results');
  }

  return { opportunities, results };
}

interface ConnectorOutcome {
  opportunities: NormalizedOpportunity[];
  result: SourceResult;
}

async function runConnector(connector: SourceConnector, query: SearchQuery): Promise<ConnectorOutcome> {
  const { slug, name, unavailableReason, minFetchIntervalMinutes } = connector.meta;
  const startedAt = Date.now();
  const base = { slug, name };

  // Registered but not usable (missing key or registration): report it rather
  // than silently returning nothing.
  if (unavailableReason) {
    return {
      opportunities: [],
      result: { ...base, ok: true, count: 0, durationMs: 0, fromCache: false, skippedReason: unavailableReason },
    };
  }

  const key = cacheKey(slug, query);
  const cached = resultCache.get(key);
  if (cached) {
    return {
      opportunities: cached,
      result: { ...base, ok: true, count: cached.length, durationMs: 0, fromCache: true },
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const sourceLog = log.child({ source: slug });

  try {
    const raw = await connector.fetch({ query, signal: controller.signal, log: sourceLog });
    const normalized = normalizeMany(raw, { slug, name });

    resultCache.set(key, normalized, minFetchIntervalMinutes * 60 * 1000);

    return {
      opportunities: normalized,
      result: {
        ...base,
        ok: true,
        count: normalized.length,
        durationMs: Date.now() - startedAt,
        fromCache: false,
      },
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // Logged at warn, not error: an upstream being unavailable is expected
    // operational noise, not a platform fault.
    sourceLog.warn({ err: message }, 'source fetch failed');
    return {
      opportunities: [],
      result: {
        ...base,
        ok: false,
        count: 0,
        durationMs: Date.now() - startedAt,
        fromCache: false,
        error: message,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Drop all cached source results — used by `.admin sources refresh`. */
export function clearSourceCache(): void {
  resultCache.clear();
}
