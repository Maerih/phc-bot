/**
 * Normalisation: turn whatever a connector reported into a canonical
 * `Opportunity`.
 *
 * This is the single funnel every source passes through, so storage, search,
 * ranking and rendering only ever see one shape. Connectors stay dumb — they
 * map their upstream's fields and nothing more.
 */
import { createHash, randomUUID } from 'node:crypto';
import { canonical, collapseWhitespace, stripHtml, truncate } from '../core/text.js';
import {
  classifyCategories,
  classifyEducationLevel,
  classifyExperienceLevel,
  classifyType,
  detectRemote,
  resolveCountry,
} from './classify.js';
import type { Opportunity, RawOpportunity } from './opportunity.js';

/** Descriptions are stored trimmed: full text lives at the source URL. */
const MAX_DESCRIPTION_CHARS = 4000;

export interface SourceIdentity {
  slug: string;
  name: string;
}

/**
 * Cross-source content fingerprint.
 *
 * Built from title + organisation + type. URLs, ids and descriptions differ
 * between aggregators carrying the same underlying post, so including them
 * would defeat de-duplication — which is the one job this hash has.
 *
 * When the organisation is unknown the source slug is mixed in, scoping the
 * hash to that one source. Without it, two unrelated employers who both failed
 * to state a name collapse into one record purely because they share a job
 * title, and a member never sees the second opportunity. Within a single
 * source, the same title with no organisation really is the same posting
 * re-fetched, so dedupe still works where it is safe.
 */
export function fingerprintOf(
  title: string,
  organization: string | null | undefined,
  type: string,
  sourceSlug?: string,
): string {
  const org = canonical(organization ?? '');
  const scope = org.length === 0 ? (sourceSlug ?? '') : '';
  const basis = [canonical(title), org, type, scope].join('|');
  return createHash('sha256').update(basis).digest('hex').slice(0, 32);
}

/**
 * Per-source idempotency key, so re-syncing a source updates rows instead of
 * inserting duplicates. Falls back to the content fingerprint when the
 * upstream exposes no stable id of its own.
 */
export function externalKeyOf(sourceSlug: string, externalId: string | null | undefined, fallback: string): string {
  return `${sourceSlug}:${externalId && externalId.length > 0 ? externalId : fallback}`;
}

/** Reject anything that is not a usable absolute http(s) URL. */
export function safeUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = new URL(trimmed);
    // Only web URLs: blocks javascript:, data:, file: and similar payloads
    // reaching a member's phone as a tappable link.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Accept a date only if it parses and is not absurd. */
export function safeDate(input: Date | string | number | null | undefined): Date | null {
  if (input === null || input === undefined || input === '') return null;
  const date = input instanceof Date ? input : new Date(input);
  const time = date.getTime();
  if (!Number.isFinite(time)) return null;
  const year = date.getUTCFullYear();
  // Guard against epoch-zero placeholders and far-future junk.
  if (year < 2000 || year > 2100) return null;
  return date;
}

function cleanTags(values: string[] | undefined): string[] {
  if (!values) return [];
  const cleaned = values
    .map((value) => collapseWhitespace(String(value)))
    .filter((value) => value.length > 0 && value.length <= 60);
  return Array.from(new Set(cleaned)).slice(0, 25);
}

export interface NormalizedOpportunity extends Opportunity {
  /** Per-source upsert key; not part of the public domain shape. */
  externalKey: string;
}

/**
 * Normalise one raw record.
 *
 * Returns null when the record is unusable — currently that means no title,
 * since a titleless opportunity cannot be presented or deduplicated. Dropping
 * it here keeps junk out of the database entirely.
 */
export function normalizeOpportunity(
  raw: RawOpportunity,
  source: SourceIdentity,
  now = new Date(),
): NormalizedOpportunity | null {
  const title = collapseWhitespace(raw.title ?? '');
  if (title.length === 0) return null;

  const organization = raw.organization ? collapseWhitespace(raw.organization) || null : null;
  const descriptionText = stripHtml(raw.description);
  const description = descriptionText.length > 0 ? truncate(descriptionText, MAX_DESCRIPTION_CHARS) : null;
  const location = raw.location ? collapseWhitespace(raw.location) || null : null;

  /**
   * Each classifier gets only the text where its signal actually lives.
   * Pointing all of them at the full description produced nonsense: a job ad
   * saying "you will present at international conferences" was typed as a
   * CONFERENCE, and one mentioning "training will be provided" as TRAINING.
   */
  // Type: title and tags only. These name what a posting *is*; body prose
  // merely mentions other kinds of opportunity in passing.
  const typeCorpus = [title, ...(raw.tags ?? [])];
  // Categories: title and tags are authoritative, the body only corroborates.
  const categoryStrong = [title, ...(raw.tags ?? []), ...(raw.skills ?? [])];
  // Seniority is stated in the title; "senior stakeholders" in the body is not
  // a seniority signal.
  const experienceCorpus = [title, ...(raw.tags ?? [])];
  // Qualifications genuinely live in the requirements section.
  const educationCorpus = [title, descriptionText];
  // Location/remote wording appears in the title, the location field and the body.
  const locationCorpus = [title, location, descriptionText];

  const type = raw.type ?? classifyType(...typeCorpus);
  const fingerprint = fingerprintOf(title, organization, type, source.slug);

  // An explicitly reported value always wins over an inferred one.
  const country = raw.country
    ? raw.country.trim().toUpperCase().slice(0, 2)
    : resolveCountry(title, location);
  const remote = raw.remote ?? detectRemote(...locationCorpus);

  const deadline = safeDate(raw.deadline);
  const datePosted = safeDate(raw.datePosted);

  return {
    id: randomUUID(),
    title,
    organization,
    description,
    type,
    categories: classifyCategories(categoryStrong, descriptionText),
    location,
    country: country && /^[A-Z]{2}$/.test(country) ? country : null,
    remote,
    eligibility: raw.eligibility ? collapseWhitespace(raw.eligibility) || null : null,
    educationLevel: classifyEducationLevel(...educationCorpus),
    experienceLevel: classifyExperienceLevel(...experienceCorpus),
    deadline,
    applicationUrl: safeUrl(raw.applicationUrl) ?? safeUrl(raw.sourceUrl),
    sourceUrl: safeUrl(raw.sourceUrl),
    sourceName: source.name,
    sourceSlug: source.slug,
    datePosted,
    // Everything enters the pipeline as DISCOVERED. Promotion to PUBLISHED is
    // a separate, reviewed step — never a side effect of ingestion.
    status: 'DISCOVERED',
    verificationStatus: 'UNVERIFIED',
    verifiedAt: null,
    tags: cleanTags(raw.tags),
    skills: cleanTags(raw.skills),
    compensation: raw.compensation ? collapseWhitespace(raw.compensation) || null : null,
    fingerprint,
    externalKey: externalKeyOf(source.slug, raw.externalId, fingerprint),
    createdAt: now,
    updatedAt: now,
  };
}

/** Normalise a batch, dropping unusable records. */
export function normalizeMany(
  records: RawOpportunity[],
  source: SourceIdentity,
  now = new Date(),
): NormalizedOpportunity[] {
  const output: NormalizedOpportunity[] = [];
  for (const record of records) {
    const normalized = normalizeOpportunity(record, source, now);
    if (normalized) output.push(normalized);
  }
  return output;
}
