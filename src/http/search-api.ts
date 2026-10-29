/**
 * Public search API.
 *
 * The same search service the WhatsApp commands use, exposed over HTTP so the
 * web UI — and any future mobile app or partner integration — reads from one
 * implementation. Nothing here re-implements filtering, de-duplication or
 * ranking; it translates query parameters in and serialises results out.
 */
import { Router, type Request, type Response } from 'express';
import { logger } from '../core/logger.js';
import { truncate } from '../core/text.js';
import { CATEGORY_LABELS, TYPE_LABELS, daysUntilDeadline, OPPORTUNITY_TYPES } from '../domain/opportunity.js';
import type { OpportunityType } from '../domain/opportunity.js';
import { parseQuery } from '../search/query.js';
import type { ScoredOpportunity } from '../search/rank.js';
import { describeSources, search } from '../search/search.service.js';
import { rateLimit } from './rate-limit.js';

const log = logger.child({ component: 'search-api' });

/** Page size for the web UI. Capped so one request cannot pull everything. */
const DEFAULT_PAGE_SIZE = 12;
const MAX_PAGE_SIZE = 30;

/** Guard against absurd query strings being used as an amplification vector. */
const MAX_QUERY_CHARS = 120;

function readString(value: unknown, maxChars = MAX_QUERY_CHARS): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxChars);
}

function readPositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number.parseInt(typeof value === 'string' ? value : '', 10);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

/** Only accept a type the domain actually defines. */
function readType(value: unknown): OpportunityType | null {
  const candidate = readString(value, 20).toUpperCase();
  return (OPPORTUNITY_TYPES as readonly string[]).includes(candidate)
    ? (candidate as OpportunityType)
    : null;
}

/** Shape sent to the browser. Deliberately explicit rather than spreading the row. */
function serialize(entry: ScoredOpportunity, now: Date) {
  const { opportunity } = entry;
  const daysLeft = daysUntilDeadline(opportunity, now);

  return {
    title: opportunity.title,
    organization: opportunity.organization,
    // A short snippet only; the full text lives at the source.
    summary: opportunity.description ? truncate(opportunity.description, 260) : null,
    type: opportunity.type,
    typeLabel: TYPE_LABELS[opportunity.type],
    categories: opportunity.categories.map((category) => CATEGORY_LABELS[category]),
    location: opportunity.location,
    country: opportunity.country,
    // null means the source did not say — the UI renders that distinctly.
    remote: opportunity.remote,
    educationLevel: opportunity.educationLevel === 'UNKNOWN' ? null : opportunity.educationLevel,
    experienceLevel: opportunity.experienceLevel === 'UNKNOWN' ? null : opportunity.experienceLevel,
    compensation: opportunity.compensation,
    deadline: opportunity.deadline ? opportunity.deadline.toISOString() : null,
    daysLeft,
    applicationUrl: opportunity.applicationUrl,
    sourceName: opportunity.sourceName,
    verified: opportunity.verificationStatus === 'ADMIN_VERIFIED' ||
      opportunity.verificationStatus === 'SOURCE_VERIFIED',
    aiFound: opportunity.sourceSlug === 'ai-web',
    score: entry.score,
  };
}

export function createSearchRouter(): Router {
  const router = Router();

  // Searching fans out to rate-limited third-party APIs, so this is the
  // tightest limit on the platform.
  const searchLimiter = rateLimit({ name: 'search', max: 30, windowMs: 5 * 60 * 1000 });
  const metaLimiter = rateLimit({ name: 'meta', max: 120, windowMs: 5 * 60 * 1000 });

  /**
   * GET /api/search
   *
   * Query parameters: q, type, location, remote, page, pageSize
   */
  router.get('/search', searchLimiter, async (req: Request, res: Response) => {
    const terms = readString(req.query.q);
    const location = readString(req.query.location, 60);
    const type = readType(req.query.type);
    const remote = readString(req.query.remote, 5) === 'true';
    const pageSize = readPositiveInt(req.query.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const page = readPositiveInt(req.query.page, 1, 100);

    // Reuse the one query parser rather than a second, divergent one: the UI's
    // fields are concatenated into the same text form the commands accept, so
    // "nairobi" is read as a location here exactly as it is in WhatsApp.
    const query = parseQuery([terms, location, remote ? 'remote' : ''].filter(Boolean).join(' '), {
      ...(type ? { forcedTypes: [type] } : {}),
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });

    try {
      const now = new Date();
      // Per-IP rate limiting already bounds how often this can be reached.
      const outcome = await search(query, { now, allowAiFallback: true });

      res.json({
        results: outcome.results.map((entry) => serialize(entry, now)),
        total: outcome.totalMatched,
        page,
        pageSize,
        hasMore: page * pageSize < outcome.totalMatched,
        // Surfaced so the UI can say the list may be incomplete rather than
        // letting a failed source look like "no opportunities exist".
        degraded: outcome.degraded,
        unavailableSources: outcome.sources
          .filter((source) => !source.ok)
          .map((source) => source.name),
        attributions: outcome.attributions,
        // True when the configured sources had nothing and these came from a
        // live AI web search instead. Clients must say so.
        aiAssisted: outcome.aiAssisted,
        durationMs: outcome.durationMs,
        interpreted: {
          terms: query.terms,
          type: query.types[0] ?? null,
          location: query.location,
          countries: query.countries,
          region: query.region,
          remoteOnly: query.remoteOnly,
          postedWithinDays: query.postedWithinDays,
        },
      });
    } catch (cause) {
      log.error({ err: cause instanceof Error ? cause.message : String(cause) }, 'search request failed');
      res.status(503).json({
        error: 'search_unavailable',
        message: 'Search could not be completed right now. Please try again shortly.',
      });
    }
  });

  /** GET /api/sources — which sources are searched, for the UI footer. */
  router.get('/sources', metaLimiter, (_req: Request, res: Response) => {
    res.json({
      sources: describeSources().map((source) => ({
        name: source.name,
        enabled: source.enabled && !source.unavailableReason,
      })),
    });
  });

  /** GET /api/filters — the option lists the UI renders, from the domain. */
  router.get('/filters', metaLimiter, (_req: Request, res: Response) => {
    res.json({
      types: OPPORTUNITY_TYPES.map((type) => ({ value: type, label: TYPE_LABELS[type] })),
    });
  });

  return router;
}
