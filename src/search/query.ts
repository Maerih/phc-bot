/**
 * Query parsing.
 *
 * Turns the text a member typed after a command into a structured
 * `SearchQuery`. Recognised filter words are consumed so they do not also
 * pollute the free-text relevance match — `.jobs Nairobi internship` should
 * search for nothing in particular in Nairobi for internships, not search for
 * the literal words "nairobi internship".
 *
 * Anything unrecognised stays in `terms`, so `.job epidemiology` works without
 * needing a keyword table entry.
 */
import { canonical } from '../core/text.js';
import { resolveCountry } from '../domain/classify.js';
import type { OpportunityType } from '../domain/opportunity.js';
import type { SearchQuery } from '../sources/types.js';

export const DEFAULT_PAGE_SIZE = 5;

/** Filter words that select an opportunity type. */
const TYPE_KEYWORDS: Array<[OpportunityType, string[]]> = [
  ['INTERNSHIP', ['internship', 'internships', 'intern', 'attachment']],
  ['SCHOLARSHIP', ['scholarship', 'scholarships', 'bursary', 'bursaries']],
  ['FELLOWSHIP', ['fellowship', 'fellowships', 'fellow']],
  ['RESEARCH', ['research', 'phd', 'postdoc', 'doctoral']],
  ['GRANT', ['grant', 'grants', 'funding']],
  ['CONFERENCE', ['conference', 'conferences', 'symposium', 'congress']],
  ['TRAINING', ['training', 'trainings', 'course', 'courses', 'workshop', 'bootcamp']],
  ['VOLUNTEER', ['volunteer', 'volunteering']],
  ['HACKATHON', ['hackathon', 'datathon']],
  ['EVENT', ['event', 'events', 'webinar', 'summit']],
  ['JOB', ['job', 'jobs', 'vacancy', 'vacancies', 'position', 'positions']],
];

/** Time-window words -> days of recency. */
const RECENCY_KEYWORDS: Record<string, number> = {
  today: 1,
  latest: 3,
  new: 3,
  recent: 7,
  week: 7,
  fortnight: 14,
  month: 30,
};

/** Region words that are not a single country. */
const REGION_KEYWORDS = new Set(['africa', 'worldwide', 'global', 'international', 'anywhere']);

const EXPERIENCE_KEYWORDS: Record<string, 'ENTRY' | 'GRADUATE'> = {
  entry: 'ENTRY',
  'entry-level': 'ENTRY',
  entrylevel: 'ENTRY',
  junior: 'ENTRY',
  graduate: 'GRADUATE',
  graduates: 'GRADUATE',
  trainee: 'GRADUATE',
};

/** Multi-word phrases normalised before tokenisation, longest first. */
const PHRASES: Array<[RegExp, string]> = [
  [/\bthis week\b/g, 'week'],
  [/\bentry[ -]level\b/g, 'entry-level'],
  [/\bclosing soon\b/g, 'closingsoon'],
  [/\bwork from home\b/g, 'remote'],
];

export interface ParseOptions {
  /** Types forced by the command itself, e.g. `.scholarships`. */
  forcedTypes?: OpportunityType[];
  limit?: number;
  offset?: number;
}

/**
 * Parse free text into a search query.
 *
 * `forcedTypes` wins over anything detected in the text: when a member runs
 * `.scholarships kenya`, "kenya" is a location and the type is already decided
 * by the command they chose.
 */
export function parseQuery(input: string, options: ParseOptions = {}): SearchQuery {
  let working = ` ${canonical(input)} `;
  for (const [pattern, replacement] of PHRASES) {
    working = working.replace(pattern, replacement);
  }

  const words = working.split(/\s+/).filter((word) => word.length > 0);

  const detectedTypes: OpportunityType[] = [];
  const locationWords: string[] = [];
  const residual: string[] = [];

  let region: string | null = null;
  let remoteOnly = false;
  let postedWithinDays: number | null = null;
  let deadlineWithinDays: number | null = null;
  let experienceLevel: 'ENTRY' | 'GRADUATE' | null = null;

  for (const word of words) {
    if (word === 'remote') {
      remoteOnly = true;
      continue;
    }

    if (word === 'closingsoon' || word === 'deadlines' || word === 'deadline') {
      deadlineWithinDays = 14;
      continue;
    }

    const recency = RECENCY_KEYWORDS[word];
    if (recency !== undefined) {
      // Keep the tightest window the member asked for.
      postedWithinDays = postedWithinDays === null ? recency : Math.min(postedWithinDays, recency);
      continue;
    }

    if (REGION_KEYWORDS.has(word)) {
      region = word === 'africa' ? 'africa' : 'worldwide';
      continue;
    }

    const experience = EXPERIENCE_KEYWORDS[word];
    if (experience) {
      experienceLevel = experience;
      continue;
    }

    const typeMatch = TYPE_KEYWORDS.find(([, keywords]) => keywords.includes(word));
    if (typeMatch) {
      detectedTypes.push(typeMatch[0]);
      continue;
    }

    // A word that names a country or city is a location, not a search term.
    if (resolveCountry(word) !== null) {
      locationWords.push(word);
      continue;
    }

    residual.push(word);
  }

  const forced = options.forcedTypes ?? [];
  const types = forced.length > 0 ? forced : Array.from(new Set(detectedTypes));

  const location = locationWords.length > 0 ? locationWords.join(', ') : null;

  // Resolve each location word on its own. Resolving the joined string would
  // return nothing as soon as two countries were named, which silently turned
  // "nairobi, kampala" into an unfiltered search.
  const countries = Array.from(
    new Set(
      locationWords
        .map((word) => resolveCountry(word))
        .filter((code): code is string => code !== null),
    ),
  );

  return {
    terms: residual.join(' ').trim(),
    types,
    location,
    countries,
    locationTerms: locationWords,
    region,
    remoteOnly,
    postedWithinDays,
    deadlineWithinDays,
    experienceLevel,
    limit: options.limit ?? DEFAULT_PAGE_SIZE,
    offset: options.offset ?? 0,
  };
}

/** Short description of the active filters, for the results header. */
export function describeQuery(query: SearchQuery): string {
  const parts: string[] = [];
  if (query.terms) parts.push(`"${query.terms}"`);
  if (query.types.length > 0) parts.push(query.types.map((type) => type.toLowerCase()).join('/'));
  if (query.location) parts.push(query.location);
  if (query.region === 'africa') parts.push('Africa');
  if (query.remoteOnly) parts.push('remote');
  if (query.experienceLevel) parts.push(query.experienceLevel.toLowerCase());
  if (query.postedWithinDays !== null) {
    parts.push(query.postedWithinDays === 1 ? 'posted today' : `last ${query.postedWithinDays} days`);
  }
  if (query.deadlineWithinDays !== null) parts.push(`closing in ${query.deadlineWithinDays} days`);
  return parts.length > 0 ? parts.join(' · ') : 'everything';
}
