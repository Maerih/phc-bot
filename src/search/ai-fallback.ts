/**
 * AI web-search fallback.
 *
 * Runs only when the configured sources return nothing. The connectors cover a
 * narrow slice of the world — a search for public-health roles in Nairobi
 * legitimately returns zero today — so rather than telling a member "nothing
 * exists", the platform asks a model with live web search to go and look.
 *
 * Results flow through the same normalisation, filtering, de-duplication and
 * ranking as every other source, so they render identically. What differs is
 * provenance: they are marked `AI_ASSISTED` and carry a visible warning,
 * because a model reading a careers page is not the same as a connector
 * reading a structured feed.
 */
import { logger } from '../core/logger.js';
import { normalizeMany, safeUrl, type NormalizedOpportunity } from '../domain/normalize.js';
import type { OpportunityType, RawOpportunity } from '../domain/opportunity.js';
import { OPPORTUNITY_TYPES } from '../domain/opportunity.js';
import { getAiProvider } from '../ai/router.js';
import { AiError } from '../ai/provider.js';
import { getWebSearchProvider, usesProviderGrounding } from './web/router.js';
import { renderSearchContext, WebSearchError } from './web/provider.js';
import type { SearchQuery } from '../sources/types.js';

const log = logger.child({ component: 'search:ai-fallback' });

/** Identity these results carry through the pipeline. */
export const AI_SOURCE = { slug: 'ai-web', name: 'AI web search' } as const;

/** Cap what one fallback can return, so a verbose model cannot flood a reply. */
const MAX_RESULTS = 8;

/** Hard ceiling on the whole fallback, including the provider's own searches. */
const FALLBACK_TIMEOUT_MS = 60_000;

const SYSTEM_PROMPT = `You find real, currently-open opportunities for a public-health community, using web search.

Rules:
- Search the web. Only report opportunities you actually found on a real page.
- NEVER invent an opportunity, organisation, deadline or URL. If you find nothing, return an empty array.
- Every entry must have a working application or listing URL you saw in the search results.
- Only report opportunities that are still open. Skip anything whose deadline has passed.
- Prefer official employer or programme pages over aggregators.
- Do not include a deadline unless the page stated one. Omit the field instead of guessing.

Reply with ONLY a JSON array, no prose and no code fence. Each element:
{
  "title": string,
  "organization": string | null,
  "location": string | null,
  "country": string | null,        // ISO-3166 alpha-2, only if one country is clear
  "remote": boolean | null,        // null if the page does not say
  "type": "JOB"|"INTERNSHIP"|"SCHOLARSHIP"|"FELLOWSHIP"|"RESEARCH"|"GRANT"|"CONFERENCE"|"TRAINING"|"VOLUNTEER"|"EVENT"|"PROGRAM",
  "deadline": string | null,       // ISO date, only if stated
  "url": string,                   // required
  "summary": string | null         // one or two sentences
}

Return at most ${MAX_RESULTS} entries. An empty array is a correct answer when nothing current matches.`;

/**
 * Prompt used when the platform supplies the search results itself.
 *
 * The difference from the grounded prompt matters: here the model must not
 * search or recall, only extract from the numbered results it was given. That
 * is a much narrower job, and a much easier one to keep honest — every URL it
 * reports can be checked against the list it was handed.
 */
const EXTRACT_SYSTEM_PROMPT = `You extract real opportunities from web search results for a public-health community.

You will be given numbered search results. Use ONLY those results.

Rules:
- NEVER invent an opportunity, organisation, deadline or URL.
- Every entry's "url" MUST be copied exactly from one of the numbered results.
- Skip results that are not a specific opportunity (homepages, listicles, blog posts, news articles about opportunities in general).
- Skip anything whose deadline has clearly passed.
- Do not include a deadline unless the result states one. Omit it rather than guess.
- If none of the results is a real, current opportunity, return an empty array.

${'Reply with ONLY a JSON array, no prose and no code fence. Each element:'}
{
  "title": string,
  "organization": string | null,
  "location": string | null,
  "country": string | null,
  "remote": boolean | null,
  "type": "JOB"|"INTERNSHIP"|"SCHOLARSHIP"|"FELLOWSHIP"|"RESEARCH"|"GRANT"|"CONFERENCE"|"TRAINING"|"VOLUNTEER"|"EVENT"|"PROGRAM",
  "deadline": string | null,
  "url": string,
  "summary": string | null
}

Return at most ${MAX_RESULTS} entries.`;

/** Plain-language search string for a web backend. */
export function buildSearchString(query: SearchQuery): string {
  const parts: string[] = [];
  const typeWords = query.types.length > 0
    ? query.types.map((type) => type.toLowerCase()).join(' OR ')
    : 'jobs OR scholarships OR fellowships';
  parts.push(query.terms.trim() || 'public health');
  parts.push(typeWords);
  if (query.locationTerms.length > 0) parts.push(query.locationTerms.join(' '));
  else if (query.region === 'africa') parts.push('Africa');
  if (query.remoteOnly) parts.push('remote');
  parts.push('apply deadline');
  return parts.join(' ');
}

/** Describe the query to the model in plain language. */
export function buildFallbackPrompt(query: SearchQuery, now = new Date()): string {
  const parts: string[] = [];

  parts.push(query.terms.trim().length > 0 ? `Topic: ${query.terms.trim()}` : 'Topic: public health');

  if (query.types.length > 0) {
    parts.push(`Opportunity types: ${query.types.join(', ')}`);
  }
  if (query.locationTerms.length > 0) {
    parts.push(`Locations: ${query.locationTerms.join(', ')}`);
  } else if (query.region === 'africa') {
    parts.push('Locations: Africa');
  }
  if (query.remoteOnly) parts.push('Must be remote.');
  if (query.experienceLevel) parts.push(`Experience level: ${query.experienceLevel}`);
  if (query.postedWithinDays !== null) {
    parts.push(`Posted within the last ${query.postedWithinDays} day(s).`);
  }

  parts.push(`Today is ${now.toISOString().slice(0, 10)}. Only include opportunities open on or after this date.`);

  return parts.join('\n');
}

interface AiOpportunity {
  title?: unknown;
  organization?: unknown;
  location?: unknown;
  country?: unknown;
  remote?: unknown;
  type?: unknown;
  deadline?: unknown;
  url?: unknown;
  summary?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Pull the JSON array out of a model reply.
 *
 * Tolerant on purpose: models wrap JSON in prose or a code fence often enough
 * that a strict parse would discard otherwise good results. Nothing unsafe
 * follows from being lenient here, because every field is validated afterwards.
 */
export function extractJsonArray(text: string): unknown[] {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];

  try {
    const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Validate one model-reported entry into a raw opportunity.
 *
 * Returns null for anything unusable. The URL requirement is the important
 * one: an entry a member cannot click through to verify is worse than no
 * entry at all, because it looks like a lead and is not.
 */
export function toRawOpportunity(entry: unknown): RawOpportunity | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const candidate = entry as AiOpportunity;

  const title = asString(candidate.title);
  if (!title) return null;

  const url = safeUrl(asString(candidate.url));
  if (!url) return null;

  const rawType = asString(candidate.type)?.toUpperCase();
  const type =
    rawType && (OPPORTUNITY_TYPES as readonly string[]).includes(rawType)
      ? (rawType as OpportunityType)
      : undefined;

  const country = asString(candidate.country);

  return {
    title,
    organization: asString(candidate.organization),
    description: asString(candidate.summary),
    location: asString(candidate.location),
    country: country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : null,
    remote: typeof candidate.remote === 'boolean' ? candidate.remote : null,
    ...(type ? { type } : {}),
    deadline: asString(candidate.deadline) ? new Date(asString(candidate.deadline) as string) : null,
    applicationUrl: url,
    sourceUrl: url,
    // The model has no reliable posting date, and guessing one would corrupt
    // both the recency filter and the ranking.
    datePosted: null,
    tags: [],
    skills: [],
    compensation: null,
    externalId: url,
  };
}

export interface AiFallbackResult {
  opportunities: NormalizedOpportunity[];
  /** Why it did not run, when it did not. */
  skippedReason?: string;
}

/**
 * Ask the AI provider to find opportunities on the live web.
 *
 * Never throws: a failed fallback must leave the member with the ordinary
 * "no results" reply, not an error.
 */
export async function aiWebFallback(query: SearchQuery, now = new Date()): Promise<AiFallbackResult> {
  const provider = getAiProvider();

  if (!provider) {
    return { opportunities: [], skippedReason: 'no AI provider configured' };
  }
  const webSearch = getWebSearchProvider();
  const grounding = usesProviderGrounding();

  if (!webSearch && !grounding) {
    return {
      opportunities: [],
      skippedReason: 'WEB_SEARCH_PROVIDER is not configured',
    };
  }
  if (grounding && (!provider.supportsWebSearch || !provider.completeWithWebSearch)) {
    return { opportunities: [], skippedReason: `${provider.name} does not support grounded search` };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FALLBACK_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    let result;

    if (webSearch) {
      // We search, the model only extracts. Works with any model, including a
      // free tier, because no grounded-search billing is involved.
      const results = await webSearch.search({
        query: buildSearchString(query),
        limit: 12,
        withinDays: query.postedWithinDays ?? 30,
        signal: controller.signal,
      });

      if (results.length === 0) {
        log.info({ backend: webSearch.name }, 'web search returned nothing');
        return { opportunities: [] };
      }

      result = await provider.complete({
        system: EXTRACT_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `${buildFallbackPrompt(query, now)}\n\nSearch results:\n\n${renderSearchContext(results)}`,
          },
        ],
        maxTokens: 4000,
        signal: controller.signal,
      });
    } else {
      // Provider-grounded search: the model searches for itself.
      result = await provider.completeWithWebSearch!({
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildFallbackPrompt(query, now) }],
        signal: controller.signal,
      });
    }

    const entries = extractJsonArray(result.text).slice(0, MAX_RESULTS);
    const raw = entries
      .map((entry) => toRawOpportunity(entry))
      .filter((item): item is RawOpportunity => item !== null);

    // Same funnel as every connector, then flagged as model-sourced.
    const normalized = normalizeMany(raw, AI_SOURCE, now).map((opportunity) => ({
      ...opportunity,
      verificationStatus: 'AI_ASSISTED' as const,
    }));

    log.info(
      {
        returned: entries.length,
        usable: normalized.length,
        durationMs: Date.now() - startedAt,
        outputTokens: result.usage?.outputTokens,
      },
      'ai web fallback completed',
    );

    return { opportunities: normalized };
  } catch (cause) {
    const reason =
      cause instanceof AiError ? cause.kind
      : cause instanceof WebSearchError ? `search: ${cause.message}`
      : String(cause);
    log.warn({ reason, durationMs: Date.now() - startedAt }, 'ai web fallback failed');
    return { opportunities: [], skippedReason: 'the web search could not be completed' };
  } finally {
    clearTimeout(timeout);
  }
}
