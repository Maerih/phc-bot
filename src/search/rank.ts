/**
 * Ranking.
 *
 * Produces a 0-100 score from weighted components. The weights live in one
 * object so they can be tuned — or later learned from engagement analytics —
 * without touching the scoring logic.
 *
 * `relevance` doubles as a quality gate: several upstreams ignore or loosely
 * honour their own search parameter, so a result that matches none of the
 * member's terms is dropped rather than shown. Returning a backend-engineer
 * vacancy to someone who asked for epidemiology is worse than returning fewer
 * results.
 */
import { canonical, tokens } from '../core/text.js';
import { AFRICA_COUNTRIES } from '../domain/classify.js';
import type { NormalizedOpportunity } from '../domain/normalize.js';
import { daysUntilDeadline } from '../domain/opportunity.js';
import type { SearchQuery } from '../sources/types.js';

export interface RankWeights {
  relevance: number;
  recency: number;
  verification: number;
  deadline: number;
  profile: number;
}

/** Starting point from the product brief; tune freely. Must sum to 1. */
export const DEFAULT_WEIGHTS: RankWeights = {
  relevance: 0.4,
  recency: 0.2,
  verification: 0.2,
  deadline: 0.1,
  profile: 0.1,
};

/** Optional member context for the `profile` component. */
export interface MemberContext {
  country?: string | null;
  interests?: string[];
  skills?: string[];
  preferredLocations?: string[];
  remotePreference?: boolean | null;
}

export interface ScoredOpportunity {
  opportunity: NormalizedOpportunity;
  score: number;
  components: Record<keyof RankWeights, number>;
}

/**
 * Text relevance, 0-1.
 *
 * Three decisions matter here, all learned from bad results:
 *
 *  1. Whole-word matching, not substring. Substring matching made "health"
 *     match "Healthcare SaaS" and "public" match "Public Sector Consulting",
 *     so a search for public health returned software testers.
 *  2. AND semantics. A result missing any of the member's terms is penalised
 *     below the quality gate rather than ranked low, because sources that
 *     ignore their own search parameter otherwise flood the list.
 *  3. A phrase bonus. "public health" appearing intact in a title is a much
 *     stronger signal than the two words appearing separately.
 *
 * With no search terms every result scores 1 — the member asked for a listing,
 * not a match.
 */
export function relevanceScore(opportunity: NormalizedOpportunity, query: SearchQuery): number {
  const queryTokens = tokens(query.terms);
  if (queryTokens.length === 0) return 1;

  const titleText = canonical(opportunity.title);
  const tagText = canonical([...opportunity.tags, ...opportunity.skills].join(' '));
  const bodyText = canonical([opportunity.organization, opportunity.description].filter(Boolean).join(' '));

  const titleTokens = new Set(tokens(opportunity.title));
  const tagTokens = new Set(tokens([...opportunity.tags, ...opportunity.skills].join(' ')));
  const bodyTokens = new Set(tokens(bodyText));

  const inTitle = (token: string): boolean => titleTokens.has(token);
  const inTags = (token: string): boolean => tagTokens.has(token);
  const inBody = (token: string): boolean => bodyTokens.has(token);

  // Single term: a straightforward where-did-it-match score.
  if (queryTokens.length === 1) {
    const token = queryTokens[0] as string;
    if (inTitle(token)) return 1;
    if (inTags(token)) return 0.75;
    if (inBody(token)) return 0.5;
    return 0;
  }

  /**
   * Multi-term queries are treated as a phrase first.
   *
   * "public health" is a field, not two independent words. Scoring the words
   * separately matched "Public Sector Consulting" (public in the title) against
   * "health insurance" (health in the benefits blurb) and called it a public
   * health job. Requiring the phrase — or at least every term in the title —
   * is what makes the difference between four misleading results and an honest
   * "no matches".
   */
  const phrase = canonical(query.terms);
  const allInTitle = queryTokens.every(inTitle);
  const allInTitleOrTags = queryTokens.every((token) => inTitle(token) || inTags(token));

  if (phrase.length > 0 && titleText.includes(phrase)) return 1;
  if (allInTitle) return 0.9;
  if (phrase.length > 0 && tagText.includes(phrase)) return 0.75;
  if (phrase.length > 0 && bodyText.includes(phrase)) return 0.6;
  if (allInTitleOrTags) return 0.55;

  // Scattered partial matches. Scored for ordering, but deliberately left
  // under the default quality gate so they are dropped rather than shown.
  const coverage =
    queryTokens.filter((token) => inTitle(token) || inTags(token) || inBody(token)).length /
    queryTokens.length;
  return coverage * 0.2;
}

/** Recency, 0-1: full marks today, decaying to zero at 60 days. */
function recencyScore(opportunity: NormalizedOpportunity, now: Date): number {
  if (!opportunity.datePosted) return 0.3; // unknown age: neither fresh nor stale
  const ageDays = (now.getTime() - opportunity.datePosted.getTime()) / 86_400_000;
  if (ageDays <= 0) return 1;
  if (ageDays >= 60) return 0;
  return 1 - ageDays / 60;
}

/** Trust in the record, 0-1. */
function verificationScore(opportunity: NormalizedOpportunity, trustBySlug: Record<string, number>): number {
  const byStatus: Record<string, number> = {
    ADMIN_VERIFIED: 1,
    SOURCE_VERIFIED: 0.85,
    AI_ASSISTED: 0.6,
    UNVERIFIED: 0.4,
    FLAGGED: 0,
    EXPIRED: 0,
  };
  const statusScore = byStatus[opportunity.verificationStatus] ?? 0.4;
  const sourceScore = (trustBySlug[opportunity.sourceSlug] ?? 50) / 100;
  // Both matter: a trusted source lifts an unverified record only so far.
  return statusScore * 0.6 + sourceScore * 0.4;
}

/**
 * Deadline urgency, 0-1.
 *
 * Peaks for deadlines 3-21 days out — far enough away to actually apply, close
 * enough to be urgent. Already-passed deadlines score 0.
 */
function deadlineScore(opportunity: NormalizedOpportunity, now: Date): number {
  const days = daysUntilDeadline(opportunity, now);
  if (days === null) return 0.35; // no stated deadline
  if (days < 0) return 0;
  if (days <= 2) return 0.7; // very tight, but still actionable
  if (days <= 21) return 1;
  if (days <= 60) return 0.6;
  return 0.4;
}

/** Fit against the member's stated profile, 0-1. */
function profileScore(opportunity: NormalizedOpportunity, member: MemberContext | undefined): number {
  if (!member) return 0.5; // neutral when we know nothing about them

  let score = 0;
  let considered = 0;

  if (member.interests && member.interests.length > 0) {
    considered += 1;
    const overlap = opportunity.categories.filter((category) => member.interests?.includes(category));
    if (overlap.length > 0) score += 1;
  }

  if (member.country) {
    considered += 1;
    if (opportunity.country === member.country) score += 1;
    else if (opportunity.remote === true) score += 0.7;
  }

  if (member.remotePreference === true) {
    considered += 1;
    if (opportunity.remote === true) score += 1;
  }

  if (member.skills && member.skills.length > 0) {
    considered += 1;
    const haystack = canonical([opportunity.title, opportunity.description, ...opportunity.tags].join(' '));
    if (member.skills.some((skill) => haystack.includes(canonical(skill)))) score += 1;
  }

  return considered === 0 ? 0.5 : score / considered;
}

/**
 * How well the opportunity's location matches the cities the member named.
 *
 * Applied as a small bonus after weighting rather than as a filter: someone
 * asking for Nairobi should still see a listing that only says "Kenya", just
 * below the ones that actually say Nairobi.
 */
function cityBonus(opportunity: NormalizedOpportunity, query: SearchQuery): number {
  if (query.locationTerms.length === 0) return 0;
  const haystack = canonical([opportunity.location, opportunity.title].filter(Boolean).join(' '));
  if (haystack.length === 0) return 0;
  const hit = query.locationTerms.some((term) => {
    const needle = canonical(term);
    return needle.length > 0 && haystack.includes(needle);
  });
  return hit ? 6 : 0;
}

export interface RankOptions {
  query: SearchQuery;
  member?: MemberContext;
  trustBySlug?: Record<string, number>;
  weights?: RankWeights;
  now?: Date;
  /**
   * Minimum relevance a result must reach when the member supplied search
   * terms. Guards against loose upstream search.
   */
  minRelevance?: number;
}

export function rank(
  opportunities: NormalizedOpportunity[],
  options: RankOptions,
): ScoredOpportunity[] {
  const weights = options.weights ?? DEFAULT_WEIGHTS;
  const trustBySlug = options.trustBySlug ?? {};
  const now = options.now ?? new Date();
  const hasTerms = tokens(options.query.terms).length > 0;
  const minRelevance = options.minRelevance ?? 0.25;

  const scored: ScoredOpportunity[] = [];

  for (const opportunity of opportunities) {
    const components = {
      relevance: relevanceScore(opportunity, options.query),
      recency: recencyScore(opportunity, now),
      verification: verificationScore(opportunity, trustBySlug),
      deadline: deadlineScore(opportunity, now),
      profile: profileScore(opportunity, options.member),
    };

    // Quality gate: only applied when the member actually gave terms.
    if (hasTerms && components.relevance < minRelevance) continue;

    const weighted =
      (components.relevance * weights.relevance +
        components.recency * weights.recency +
        components.verification * weights.verification +
        components.deadline * weights.deadline +
        components.profile * weights.profile) *
      100;

    const score = Math.min(100, weighted + cityBonus(opportunity, options.query));

    scored.push({ opportunity, score: Math.round(score * 10) / 10, components });
  }

  return scored.sort((left, right) => right.score - left.score);
}

/**
 * Hard filters — applied before ranking, because these are the member's
 * explicit requirements rather than preferences to be weighed.
 */
export interface FilterOptions {
  /**
   * Treat an unknown field as a match rather than a failure.
   *
   * Used for web-fallback results. Those are already targeted — the search
   * string carried the location and type — and they structurally lack some
   * fields: a page never states a "posted date" the way a job feed does, and
   * a model will often not pin an ISO country code. Applying the strict
   * filters to them discarded every result the fallback found, which made a
   * working feature look broken.
   *
   * Expired deadlines and an explicit remote requirement stay strict either
   * way: those are claims we must not get wrong.
   */
  treatUnknownAsMatch?: boolean;
}

export function applyFilters(
  opportunities: NormalizedOpportunity[],
  query: SearchQuery,
  now = new Date(),
  options: FilterOptions = {},
): NormalizedOpportunity[] {
  const lenient = options.treatUnknownAsMatch === true;

  return opportunities.filter((opportunity) => {
    if (query.types.length > 0 && !query.types.includes(opportunity.type)) return false;

    // Only `true` passes: a null remote flag means the source did not say, and
    // we will not present an unknown as a remote role.
    if (query.remoteOnly && opportunity.remote !== true) return false;

    // OR across the countries named. Empty means no restriction.
    if (query.countries.length > 0) {
      if (!opportunity.country) {
        if (!lenient) return false;
      } else if (!query.countries.includes(opportunity.country)) {
        return false;
      }
    }

    if (query.region === 'africa') {
      if (!opportunity.country) {
        if (!lenient) return false;
      } else if (!AFRICA_COUNTRIES.has(opportunity.country)) {
        return false;
      }
    }

    if (query.experienceLevel && opportunity.experienceLevel !== query.experienceLevel) {
      if (!lenient || opportunity.experienceLevel !== 'UNKNOWN') return false;
    }

    if (query.postedWithinDays !== null) {
      if (!opportunity.datePosted) {
        if (!lenient) return false; // cannot prove it is recent
      } else {
        const ageDays = (now.getTime() - opportunity.datePosted.getTime()) / 86_400_000;
        if (ageDays > query.postedWithinDays) return false;
      }
    }

    if (query.deadlineWithinDays !== null) {
      const days = daysUntilDeadline(opportunity, now);
      if (days === null || days < 0 || days > query.deadlineWithinDays) return false;
    }

    // Never surface something whose deadline has already passed.
    const remaining = daysUntilDeadline(opportunity, now);
    if (remaining !== null && remaining < 0) return false;

    return true;
  });
}
