/**
 * Is this the same opportunity as one we already have — and is it still open?
 *
 * Deterministic on purpose: duplicates and expiry decide what members see,
 * so they must not depend on a model's mood. The AI reads pages; this code
 * decides.
 */

// ── Identity ────────────────────────────────────────────────────────────────

const TITLE_NOISE = new Set([
  'job', 'jobs', 'vacancy', 'vacancies', 'position', 'positions', 'post', 'posts', 'opening', 'openings',
  'the', 'a', 'an', 'of', 'for', 'and', 'in', 'at', 'to', 'on', 'with', 'x', 'nos', 'no',
  'contract', 'permanent', 'pensionable', 'full', 'time', 'fulltime', 'part', 'parttime', 'temporary',
  'apply', 'now', 'urgent', 'hiring', 'recruitment', 'advert', 'advertisement', 'kenya',
]);

const ORG_NOISE = /\b(limited|ltd|plc|inc|llc|co|company|the|of|and|kenya|international|org|organisation|organization)\b/g;

/** "Data Manager – Kisumu at Kenya Medical Research Institute (KEMRI)" → "data manager kisumu". */
export function titleKey(title: string, organization?: string | null): string {
  let text = title.toLowerCase();
  // Drop a trailing "at <organisation>", which boards add and employers do not.
  text = text.replace(/\s+(at|with|-|–|—|\|)\s+[^-–—|]{3,}$/u, (tail) =>
    organization && orgKey(tail.replace(/^\s*(at|with|-|–|—|\|)\s+/, '')) === orgKey(organization) ? '' : tail,
  );
  text = text.replace(/\s+at\s+.+$/, '');
  text = text.replace(/\((?:[^)]*\b(?:kemri|vn\d+|ref|job group|kmr|grade)\b[^)]*)\)/g, ' ');
  return text
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word.length > 0 && !TITLE_NOISE.has(word))
    .join(' ');
}

export function orgKey(organization: string | null | undefined): string {
  if (!organization) return '';
  return organization.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(ORG_NOISE, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Acronym from a name ("Kenya Medical Research Institute" → "kmri") and any acronym in brackets ("(KEMRI)"). */
function acronyms(organization: string): string[] {
  const words = organization.toLowerCase().replace(/\([^)]*\)/g, ' ').split(/[^a-z]+/).filter((word) => word.length > 2 && !['and', 'the', 'for'].includes(word));
  const inBrackets = [...organization.matchAll(/\(([A-Za-z]{2,10})\)/g)].map((match) => match[1]!.toLowerCase());
  return [words.map((word) => word[0]).join(''), ...inBrackets].filter((value) => value.length >= 2);
}

/** Same employer, allowing for "KEMRI" against "Kenya Medical Research Institute (KEMRI)". Unknown counts as compatible. */
export function sameOrganization(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = orgKey(a);
  const kb = orgKey(b);
  if (!ka || !kb) return true;
  if (ka === kb || ka.includes(kb) || kb.includes(ka)) return true;
  const short = (name: string): string => name.toLowerCase().replace(/[^a-z]/g, '');
  const aliasesA = new Set([...acronyms(a!), short(a!)]);
  const aliasesB = new Set([...acronyms(b!), short(b!)]);
  return [...aliasesA].some((alias) => aliasesB.has(alias));
}

/** A link reduced to what identifies the page: no scheme, "www.", tracking or trailing slash. */
export function linkKey(url: string | null | undefined): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$|source$)/i.test(key)) parsed.searchParams.delete(key);
    const path = parsed.pathname.replace(/\/+$/, '');
    // A site's home or careers landing page identifies an employer, not a job.
    if (path === '' || /^\/(careers?|jobs|vacancies|apply)$/i.test(path)) return '';
    return `${parsed.hostname.replace(/^www\./, '')}${path}${parsed.search}`.toLowerCase();
  } catch {
    return '';
  }
}

function tokens(key: string): Set<string> {
  return new Set(key.split(' ').filter(Boolean));
}

export function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const token of ta) if (tb.has(token)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

export interface Identity {
  title: string;
  organization: string | null;
  location?: string | null;
  applyUrl?: string | null;
  listingUrl?: string | null;
  emails?: string[];
}

/** The employer: as given, or from a board-style title ("Nurse at Scion Hospital"). */
export function organizationOf(identity: Identity): string | null {
  if (identity.organization) return identity.organization;
  const tail = /\s+at\s+(.{3,}?)\s*$/i.exec(identity.title)?.[1];
  return tail ? tail.replace(/\s*[-–|].*$/, '').trim() || null : null;
}

/** Why two listings are the same opportunity, or null when they are not. */
export function sameOpportunity(a: Identity, b: Identity): string | null {
  const orgA = organizationOf(a);
  const orgB = organizationOf(b);
  const titleA = titleKey(a.title, orgA);
  const titleB = titleKey(b.title, orgB);
  const titleSimilarity = similarity(titleA, titleB);
  const orgs = sameOrganization(orgA, orgB);

  const links = [linkKey(a.applyUrl), linkKey(a.listingUrl)].filter(Boolean);
  const otherLinks = new Set([linkKey(b.applyUrl), linkKey(b.listingUrl)].filter(Boolean));
  // The same application page with a similar title. (Different jobs can share
  // one portal page, so the title must agree too.)
  if (links.some((link) => otherLinks.has(link)) && titleSimilarity >= 0.5) return 'same application link';

  const emails = new Set(a.emails ?? []);
  if ((b.emails ?? []).some((email) => emails.has(email)) && titleSimilarity >= 0.6 && orgs) return 'same application email';

  if (titleSimilarity >= 0.8 && orgs) {
    // Same title and employer in two different places are two jobs.
    const placeA = (a.location ?? '').toLowerCase();
    const placeB = (b.location ?? '').toLowerCase();
    const towns = /\b(nairobi|kisumu|mombasa|nakuru|eldoret|busia|thika|kilifi|kericho|kakamega|garissa|machakos|nyeri|meru|kitui|siaya|homa bay|migori|turkana|marsabit|wajir|mandera|lamu|kwale|embu)\b/g;
    const townsA = new Set(placeA.match(towns) ?? []);
    const townsB = new Set(placeB.match(towns) ?? []);
    if (townsA.size > 0 && townsB.size > 0 && ![...townsA].some((town) => townsB.has(town))) return null;
    return 'same title and organisation';
  }
  return null;
}

// ── Validity ────────────────────────────────────────────────────────────────

/** Without a deadline, a posting older than this is treated as stale. */
export const MAX_AGE_WITHOUT_DEADLINE_DAYS = 30;

export interface Dates {
  deadline: string | null;
  posted: string | null;
  firstSeen: Date;
  /** Found on a site's first scan, so it may have been there for a long time. */
  seeded: boolean;
  closed?: boolean;
}

export type Validity = { ok: true } | { ok: false; reason: 'expired' | 'closed' | 'stale' | 'undated' };

/** Today in Nairobi, as YYYY-MM-DD. */
export function todayIso(now = new Date()): string {
  return new Date(now.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

/**
 * Is this opportunity worth publishing today?
 *  - a deadline that has passed, or a page saying it is closed: no
 *  - a deadline today or later: yes
 *  - no deadline but a posting date: yes within 30 days
 *  - neither: only if we first saw it recently on a site we were already
 *    watching (so it is new there); a site's first scan proves nothing
 */
export function assessValidity(dates: Dates, now = new Date()): Validity {
  const today = todayIso(now);
  if (dates.closed) return { ok: false, reason: 'closed' };
  if (dates.deadline) return dates.deadline >= today ? { ok: true } : { ok: false, reason: 'expired' };
  if (dates.posted) {
    if (dates.posted > today) return { ok: true };
    return daysBetween(dates.posted, today) <= MAX_AGE_WITHOUT_DEADLINE_DAYS ? { ok: true } : { ok: false, reason: 'stale' };
  }
  if (dates.seeded) return { ok: false, reason: 'undated' };
  return now.getTime() - dates.firstSeen.getTime() <= 14 * 86_400_000 ? { ok: true } : { ok: false, reason: 'stale' };
}
