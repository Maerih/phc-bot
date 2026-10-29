/**
 * The source connector contract.
 *
 * Adding a new opportunity source means writing one file that satisfies this
 * interface and registering it. No other part of the platform changes — search,
 * normalisation, storage and ranking are all source-agnostic by construction,
 * which is what keeps the system from being welded to one job board.
 */
import type { Logger } from '../core/logger.js';
import type { OpportunityType, RawOpportunity } from '../domain/opportunity.js';

/** A parsed search request, after filters have been extracted from the text. */
export interface SearchQuery {
  /** Free-text terms, filter keywords already removed. */
  terms: string;
  /** Restrict to these opportunity types; empty means no restriction. */
  types: OpportunityType[];
  /** Free-text location as the member wrote it ("Nairobi", "Kenya", "Africa"). */
  location: string | null;
  /**
   * ISO-3166 alpha-2 codes the member asked for, matched as OR.
   * Empty means no country restriction.
   *
   * A list rather than one value so `.job public health nairobi, kampala`
   * returns both countries instead of silently dropping the filter, which is
   * what a single-country field did whenever two were named.
   */
  countries: string[];
  /**
   * The location words as typed ("nairobi", "kisumu"), kept for display and
   * for ranking. City names are a ranking signal, never a hard filter: a
   * listing that only says "Kenya" should still reach someone who asked for
   * Nairobi, just below the ones that say Nairobi.
   */
  locationTerms: string[];
  /** Region keyword, currently "africa" or "worldwide". */
  region: string | null;
  /** True only when the member explicitly asked for remote. */
  remoteOnly: boolean;
  /** Only opportunities posted within this many days. */
  postedWithinDays: number | null;
  /** Only opportunities whose deadline falls within this many days. */
  deadlineWithinDays: number | null;
  /** Requested experience level filter. */
  experienceLevel: 'ENTRY' | 'GRADUATE' | null;
  /** Page size and offset for pagination. */
  limit: number;
  offset: number;
}

export interface FetchContext {
  query: SearchQuery;
  /** Abort signal carrying the per-source timeout. */
  signal: AbortSignal;
  log: Logger;
}

export interface ConnectorMeta {
  /** Stable identifier used in config, the database and logs. */
  slug: string;
  /** Human-readable name shown to members as the source attribution. */
  name: string;
  kind: 'API' | 'RSS' | 'SCRAPE' | 'MANUAL';
  homepageUrl: string;
  /** Opportunity types this source can actually supply. */
  supplies: OpportunityType[];
  /**
   * Minimum gap between upstream calls, in minutes. Honour the upstream's
   * stated limit here — several grant access on that condition.
   */
  minFetchIntervalMinutes: number;
  /** Source quality, 0-100, used by the ranker. */
  trustScore: number;
  /** Set when the upstream's terms require visible credit and a link back. */
  attributionRequired: boolean;
  attributionText?: string;
  /**
   * Why the connector is unavailable, or null when it is ready. Used for
   * sources that need a key or registration the operator has not supplied —
   * they stay registered and self-describing instead of silently missing.
   */
  unavailableReason?: string | null;
}

export interface SourceConnector {
  readonly meta: ConnectorMeta;
  /**
   * Fetch matching opportunities from the upstream.
   *
   * Implementations must not throw for ordinary upstream problems — they
   * should let the error propagate only for genuine bugs. The search service
   * isolates every connector, so one failing source degrades that source
   * alone, never the request.
   */
  fetch(context: FetchContext): Promise<RawOpportunity[]>;
}

/** Outcome of running one connector, including failures. */
export interface SourceResult {
  slug: string;
  name: string;
  ok: boolean;
  count: number;
  durationMs: number;
  fromCache: boolean;
  error?: string;
  skippedReason?: string;
}
