/**
 * The search service.
 *
 * One pipeline, deliberately independent of WhatsApp: the same call will later
 * back the admin dashboard, an HTTP API and any other client. Nothing in here
 * knows what a chat message is.
 *
 *   query -> fan-out across sources -> filter -> dedupe -> rank -> persist
 */
import { logger } from '../core/logger.js';
import { upsertOpportunities } from '../db/repositories/opportunities.js';
import type { NormalizedOpportunity } from '../domain/normalize.js';
import { ALL_CONNECTORS, activeConnectors, fanOut } from '../sources/registry.js';
import type { SearchQuery, SourceResult } from '../sources/types.js';
import { aiWebFallback } from './ai-fallback.js';
import { dedupe } from './dedupe.js';
import { applyFilters, rank, type MemberContext, type ScoredOpportunity } from './rank.js';

const log = logger.child({ component: 'search' });

export interface SearchOptions {
  member?: MemberContext;
  /**
   * Allow the AI web-search fallback when the configured sources return
   * nothing. Off by default: it costs money per call, so the caller decides
   * and is responsible for any per-member quota.
   */
  allowAiFallback?: boolean;
  /**
   * Run the AI web search alongside the sources every time, not only when
   * they find nothing, and merge the two. For the opportunity-type commands,
   * where the open web carries much of what members want.
   */
  aiAugment?: boolean;
  /** Persist discovered opportunities. Disable for dry runs and tests. */
  persist?: boolean;
  now?: Date;
}

export interface SearchOutcome {
  /** The page the caller asked for. */
  results: ScoredOpportunity[];
  /** Total matches before pagination — drives "showing 1-5 of 23". */
  totalMatched: number;
  /** Per-source outcome, including failures and skips. */
  sources: SourceResult[];
  /** True when at least one enabled source failed: results are incomplete. */
  degraded: boolean;
  /** Sources that must be credited in the rendered output. */
  attributions: string[];
  /** True when these results came from the AI web-search fallback. */
  aiAssisted: boolean;
  durationMs: number;
}

/** Source trust scores, keyed by slug, for dedupe and ranking. */
function trustMap(): Record<string, number> {
  const map: Record<string, number> = {};
  for (const connector of ALL_CONNECTORS) map[connector.meta.slug] = connector.meta.trustScore;
  return map;
}

export async function search(query: SearchQuery, options: SearchOptions = {}): Promise<SearchOutcome> {
  const startedAt = Date.now();
  const now = options.now ?? new Date();
  const trustBySlug = trustMap();

  // The AI web search, when wanted, runs at the same time as the sources.
  const augment = options.aiAugment === true && options.allowAiFallback === true ? aiWebFallback(query, now) : null;
  const { opportunities: fetched, results: sourceResults } = await fanOut(query);

  const filtered = applyFilters(fetched, query, now);
  const { unique, removed } = dedupe(filtered, { trustBySlug });
  const ranked = rank(unique, { query, member: options.member, trustBySlug, now });

  log.info(
    {
      terms: query.terms || '(none)',
      types: query.types,
      fetched: fetched.length,
      afterFilters: filtered.length,
      duplicatesRemoved: removed,
      ranked: ranked.length,
    },
    'search completed',
  );

  // Persistence must never delay or break the member's reply, so it is
  // fire-and-forget — but it is tracked, so shutdown can wait for it instead
  // of tearing the connection pool down mid-write.
  if (options.persist !== false && unique.length > 0) {
    track(persistQuietly(unique));
  }

  let finalRanked = ranked;
  let aiAssisted = false;

  if (augment) {
    const extra = await augment;
    if (extra.opportunities.length > 0) {
      const extraRanked = rank(
        dedupe(applyFilters(extra.opportunities, query, now, { treatUnknownAsMatch: true }), { trustBySlug }).unique,
        { query, ...(options.member ? { member: options.member } : {}), trustBySlug, now, minRelevance: 0 },
      );
      // Merge, dropping AI finds that repeat a source listing (same link or
      // same title from the same organisation), and order by score.
      const seen = new Set(ranked.flatMap((item) => [linkKey(item), titleKey(item)]));
      const added = extraRanked.filter((item) => !seen.has(linkKey(item)) && !seen.has(titleKey(item)));
      finalRanked = [...ranked, ...added].sort((a, b) => b.score - a.score);
      aiAssisted = added.length > 0;
      log.info({ sources: ranked.length, aiAdded: added.length }, 'search augmented with AI web results');
    }
  }

  /**
   * Nothing from the configured sources. Rather than reporting that no such
   * opportunity exists — which is a much stronger claim than "our four
   * connectors do not carry it" — ask the AI provider to search the live web.
   */
  if (finalRanked.length === 0 && !augment && options.allowAiFallback === true) {
    const fallback = await aiWebFallback(query, now);
    if (fallback.opportunities.length > 0) {
      // Lenient: fallback results are already targeted by the search string,
      // and structurally lack posting dates and often country codes.
      const fallbackFiltered = applyFilters(fallback.opportunities, query, now, {
        treatUnknownAsMatch: true,
      });
      const fallbackUnique = dedupe(fallbackFiltered, { trustBySlug }).unique;
      // Relevance is not gated here: the model was given the query directly,
      // so a low text overlap is not evidence of a bad match the way it is for
      // a source that ignored its own search parameter.
      finalRanked = rank(fallbackUnique, {
        query,
        ...(options.member ? { member: options.member } : {}),
        trustBySlug,
        now,
        minRelevance: 0,
      });
      aiAssisted = finalRanked.length > 0;

      log.info(
        { found: fallback.opportunities.length, usable: finalRanked.length },
        'served results from the AI web fallback',
      );
    } else if (fallback.skippedReason) {
      log.debug({ reason: fallback.skippedReason }, 'ai fallback did not run');
    }
  }

  const page = finalRanked.slice(query.offset, query.offset + query.limit);

  return {
    results: page,
    totalMatched: finalRanked.length,
    sources: sourceResults,
    degraded: sourceResults.some((result) => !result.ok),
    attributions: requiredAttributions(page),
    aiAssisted,
    durationMs: Date.now() - startedAt,
  };
}

function linkKey(item: { opportunity: { applicationUrl?: string | null; sourceUrl?: string | null } }): string {
  return `url:${(item.opportunity.applicationUrl ?? item.opportunity.sourceUrl ?? '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[/?#]+$/, '')}`;
}

function titleKey(item: { opportunity: { title: string; organization?: string | null } }): string {
  return `title:${item.opportunity.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}|${(item.opportunity.organization ?? '').toLowerCase()}`;
}

/** Background writes still in flight, awaited by `flushPersistence`. */
const inFlight = new Set<Promise<void>>();

function track(task: Promise<void>): void {
  inFlight.add(task);
  void task.finally(() => inFlight.delete(task));
}

/**
 * Wait for background persistence to finish.
 *
 * Called on shutdown and by the CLI. Without it, closing the database pool
 * immediately after a search aborts the upserts with CONNECTION_ENDED and the
 * discovered opportunities are silently lost.
 */
export async function flushPersistence(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled(Array.from(inFlight));
  }
}

async function persistQuietly(records: NormalizedOpportunity[]): Promise<void> {
  try {
    await upsertOpportunities(records);
  } catch (cause) {
    log.warn({ err: cause instanceof Error ? cause.message : String(cause) }, 'persisting results failed');
  }
}

/**
 * Attribution lines required by the sources actually present on this page.
 *
 * Several upstreams grant API access on condition that listings credit them,
 * so this is a licence obligation, not decoration — the renderer appends it.
 */
function requiredAttributions(page: ScoredOpportunity[]): string[] {
  const slugsOnPage = new Set(page.map((entry) => entry.opportunity.sourceSlug));
  const lines = ALL_CONNECTORS.filter(
    (connector) => connector.meta.attributionRequired && slugsOnPage.has(connector.meta.slug),
  ).map((connector) => connector.meta.attributionText ?? `via ${connector.meta.name}`);
  return Array.from(new Set(lines));
}

/** Operator-facing view of connector status, for `.admin sources` and /api/status. */
export function describeSources(): Array<{
  slug: string;
  name: string;
  enabled: boolean;
  trustScore: number;
  unavailableReason: string | null;
}> {
  const enabledSlugs = new Set(activeConnectors().map((connector) => connector.meta.slug));
  return ALL_CONNECTORS.map((connector) => ({
    slug: connector.meta.slug,
    name: connector.meta.name,
    enabled: enabledSlugs.has(connector.meta.slug),
    trustScore: connector.meta.trustScore,
    unavailableReason: connector.meta.unavailableReason ?? null,
  }));
}
