/**
 * De-duplication.
 *
 * The same vacancy routinely appears on several boards. Members see one entry
 * per real opportunity, and the copy they see is the best one available.
 *
 * Two passes:
 *  1. exact — identical content fingerprint (title + organisation + type)
 *  2. near  — same organisation and a high title-token overlap, which catches
 *             "Health Data Analyst" vs "Health Data Analyst (Remote)"
 */
import { canonical } from '../core/text.js';
import type { NormalizedOpportunity } from '../domain/normalize.js';

/** Jaccard overlap above which two same-organisation titles are the same role. */
const NEAR_DUPLICATE_THRESHOLD = 0.8;

/** Shared tokens required before a subset title counts as the same role. */
const MIN_SHARED_TOKENS = 2;

export interface DedupeOptions {
  /** Source trust by slug, used to decide which copy wins. */
  trustBySlug?: Record<string, number>;
}

/**
 * Completeness score: how much a record actually tells a member.
 * Used as the tie-breaker when two sources carry the same role — the copy with
 * a real deadline and an application link is more useful than a bare title.
 */
export function completeness(opportunity: NormalizedOpportunity): number {
  let score = 0;
  if (opportunity.deadline) score += 3;
  if (opportunity.applicationUrl) score += 2;
  if (opportunity.organization) score += 2;
  if (opportunity.description && opportunity.description.length > 200) score += 2;
  if (opportunity.country) score += 1;
  if (opportunity.compensation) score += 1;
  if (opportunity.remote !== null) score += 1;
  if (opportunity.tags.length > 0) score += 1;
  return score;
}

function titleTokens(title: string): Set<string> {
  return new Set(canonical(title).split(' ').filter((token) => token.length > 2));
}

/**
 * Whether two titles from the same organisation name the same role.
 *
 * Jaccard alone is not enough: "Health Data Analyst" vs "Health Data Analyst
 * (Remote)" scores 0.75, under any threshold loose enough to be safe. The
 * subset rule catches exactly that case — one title being the other plus a
 * qualifier such as "(Remote)", "(m/f/d)" or a duty station — while still
 * requiring real overlap, so short titles cannot merge on one shared word.
 */
function sameRole(left: Set<string>, right: Set<string>): boolean {
  if (left.size === 0 || right.size === 0) return false;

  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  if (intersection === 0) return false;

  const smaller = Math.min(left.size, right.size);
  const isSubset = intersection === smaller;
  if (isSubset && intersection >= MIN_SHARED_TOKENS) return true;

  const union = left.size + right.size - intersection;
  return union > 0 && intersection / union >= NEAR_DUPLICATE_THRESHOLD;
}

/** Prefer the more trusted source; break ties on completeness. */
function better(
  candidate: NormalizedOpportunity,
  incumbent: NormalizedOpportunity,
  trustBySlug: Record<string, number>,
): boolean {
  const candidateTrust = trustBySlug[candidate.sourceSlug] ?? 50;
  const incumbentTrust = trustBySlug[incumbent.sourceSlug] ?? 50;
  if (candidateTrust !== incumbentTrust) return candidateTrust > incumbentTrust;
  return completeness(candidate) > completeness(incumbent);
}

export interface DedupeResult {
  unique: NormalizedOpportunity[];
  /** How many records were folded away. */
  removed: number;
}

export function dedupe(
  opportunities: NormalizedOpportunity[],
  options: DedupeOptions = {},
): DedupeResult {
  const trustBySlug = options.trustBySlug ?? {};

  // Pass 1: exact fingerprint.
  const byFingerprint = new Map<string, NormalizedOpportunity>();
  for (const opportunity of opportunities) {
    const existing = byFingerprint.get(opportunity.fingerprint);
    if (!existing || better(opportunity, existing, trustBySlug)) {
      byFingerprint.set(opportunity.fingerprint, opportunity);
    }
  }

  // Pass 2: near-duplicates within the same organisation.
  const kept: NormalizedOpportunity[] = [];
  const tokenCache = new Map<string, Set<string>>();

  for (const opportunity of byFingerprint.values()) {
    const orgKey = canonical(opportunity.organization ?? '');
    const myTokens = titleTokens(opportunity.title);
    tokenCache.set(opportunity.id, myTokens);

    // Organisation unknown? Too risky to merge — two different employers can
    // advertise the same job title, and wrongly hiding one costs a member a
    // real opportunity.
    if (orgKey.length === 0) {
      kept.push(opportunity);
      continue;
    }

    const duplicateIndex = kept.findIndex((candidate) => {
      if (canonical(candidate.organization ?? '') !== orgKey) return false;
      if (candidate.type !== opportunity.type) return false;
      const candidateTokens = tokenCache.get(candidate.id) ?? titleTokens(candidate.title);
      return sameRole(myTokens, candidateTokens);
    });

    if (duplicateIndex === -1) {
      kept.push(opportunity);
      continue;
    }

    const incumbent = kept[duplicateIndex];
    if (incumbent && better(opportunity, incumbent, trustBySlug)) {
      kept[duplicateIndex] = opportunity;
    }
  }

  return { unique: kept, removed: opportunities.length - kept.length };
}
