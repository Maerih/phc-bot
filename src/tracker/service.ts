/**
 * The site tracker.
 *
 *  - Scanning, every TRACKER_INTERVAL_MINUTES, any day: each site's listing
 *    page is read, links not seen before are kept, and the public-health ones
 *    are queued. A site's first scan only records what is already there;
 *    those are queued too, behind anything newer.
 *  - Announcing, Monday 03:00 to Friday 13:00: one card every 10–15 minutes
 *    to every chat that turned alerts on. Details are read from the listing
 *    page only when a card is about to go out, so the AI reads ~5 pages an
 *    hour, not hundreds.
 *  - Friday 14:00: the week's report and a spreadsheet, then a weekend message.
 */
import { env } from '../config/env.js';
import { logger, redactJid } from '../core/logger.js';
import { USER_AGENT } from '../sources/common/http.js';
import { aiAvailable, basicCard, classifyTitles, extractCard } from './ai.js';
import {
  renderCard,
  renderWeeklyReport,
  weekendMessage,
  weeklyReportCsv,
  type OpportunityCard,
} from './card.js';
import { extractPageFacts, type PageFacts } from './facts.js';
import { extractLinks, htmlToText, listingCandidates } from './html.js';
import { assessValidity, sameOpportunity } from './identity.js';
import { reliefwebConnector } from '../sources/jobs/reliefweb.js';
import { jsearchConfigured, searchKenya, topicsForDay, type JSearchHit } from './jsearch.js';
import { isGenericTitle, isHealthish, keywordVerdict, typeFromTitle } from './relevance.js';
import { isAllowed } from './robots.js';
import {
  DEFAULT_DRIP,
  inDripWindow,
  isReportTime,
  localTime,
  nextDripDelayMs,
  parseDripRange,
  weekLabel,
  weekStart,
  type DripRange,
} from './schedule.js';
import { TRACKED_SITES, type TrackedSite } from './sites.js';
import * as store from './store.js';

const log = logger.child({ component: 'tracker' });

export interface Messenger {
  connected(): boolean;
  sendText(chatJid: string, text: string): Promise<void>;
  sendDocument(chatJid: string, data: Buffer, fileName: string, mimetype: string, caption?: string): Promise<void>;
}

let messenger: Messenger | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let scanning = false;
let ticking = false;
let checking = false;
let nextScanAt = 0;
let nextDripAt = 0;
let lastScan: { at: Date; found: number; failed: string[] } | null = null;

export function setMessenger(value: Messenger): void {
  messenger = value;
}

// ── Fetching ────────────────────────────────────────────────────────────────

const MAX_PAGE_BYTES = 2_000_000;

async function fetchPage(url: string): Promise<{ html: string; finalUrl: string } | null> {
  if (!(await isAllowed(url))) {
    log.debug({ url }, 'robots.txt disallows this page');
    return null;
  }
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) return null;
    if (!/html|xml|text\/plain/i.test(response.headers.get('content-type') ?? 'text/html')) return null;
    const body = await response.arrayBuffer();
    return { html: Buffer.from(body.slice(0, MAX_PAGE_BYTES)).toString('utf8'), finalUrl: response.url || url };
  } catch {
    return null;
  }
}

// ── Scanning ────────────────────────────────────────────────────────────────

export interface ScanResult {
  site: string;
  ok: boolean;
  candidates: number;
  fresh: number;
  relevant: number;
  seeded: boolean;
}

export async function scanSite(site: TrackedSite): Promise<ScanResult> {
  const result: ScanResult = { site: site.slug, ok: false, candidates: 0, fresh: 0, relevant: 0, seeded: false };
  const page = await fetchPage(site.url);
  if (!page) return result;
  result.ok = true;

  const candidates = listingCandidates(page.html, page.finalUrl).map((link) => ({ ...link, hash: store.urlHash(link.url) }));
  result.candidates = candidates.length;
  const known = await store.knownHashes(candidates.map((candidate) => candidate.hash));
  const fresh = candidates.filter((candidate) => !known.has(candidate.hash));
  result.fresh = fresh.length;
  if (fresh.length === 0) return result;

  result.seeded = !(await store.siteHasItems(site.slug));

  // On general boards only health-looking titles are worth judging at all.
  const worthJudging = fresh.filter(
    (candidate) => !isGenericTitle(candidate.text) && (site.health || isHealthish(candidate.text)),
  );
  const relevant = new Set<string>();
  for (let start = 0; start < worthJudging.length; start += 50) {
    const batch = worthJudging.slice(start, start + 50);
    const verdict = await classifyTitles(
      batch.map((candidate) => ({ title: candidate.text, url: candidate.url })),
      site,
    );
    batch.forEach((candidate, index) => {
      const yes = verdict ? verdict.has(index) : keywordVerdict(candidate.text, site.health);
      if (yes) relevant.add(candidate.hash);
    });
  }
  result.relevant = relevant.size;

  await store.insertItems(
    fresh.map((candidate) => ({
      hash: candidate.hash,
      site: site.slug,
      url: candidate.url,
      title: candidate.text,
      relevant: relevant.has(candidate.hash),
      seeded: result.seeded,
    })),
  );
  return result;
}

/**
 * ReliefWeb's Kenya jobs, through its API: its pages refuse automated
 * reading, but the API supplies the details a card needs.
 */
export async function scanReliefWeb(): Promise<ScanResult> {
  const result: ScanResult = { site: 'reliefweb', ok: false, candidates: 0, fresh: 0, relevant: 0, seeded: false };
  if (env.RELIEFWEB_APPNAME.trim().length === 0) return result;
  const jobs = await reliefwebConnector.fetch({
    query: {
      terms: '', types: [], location: 'Kenya', countries: ['KE'], locationTerms: ['kenya'], region: null,
      remoteOnly: false, postedWithinDays: null, deadlineWithinDays: null, experienceLevel: null, limit: 25, offset: 0,
    },
    signal: AbortSignal.timeout(45_000),
    log,
  });
  result.ok = true;
  const candidates = jobs
    .filter((job) => job.applicationUrl)
    .map((job) => ({ job, url: job.applicationUrl as string, hash: store.urlHash(job.applicationUrl as string) }));
  result.candidates = candidates.length;
  const known = await store.knownHashes(candidates.map((candidate) => candidate.hash));
  const fresh = candidates.filter((candidate) => !known.has(candidate.hash));
  result.fresh = fresh.length;
  if (fresh.length === 0) return result;
  result.seeded = !(await store.siteHasItems('reliefweb'));

  const site = { name: 'ReliefWeb', health: false };
  const labelled = fresh.map((candidate) => ({
    ...candidate,
    label: `${candidate.job.title} — ${candidate.job.organization ?? ''}`,
  }));
  const verdict = await classifyTitles(labelled.map((item) => ({ title: item.label, url: item.url })), site);
  const relevant = new Set(
    labelled.filter((item, index) => (verdict ? verdict.has(index) : keywordVerdict(item.label, false))).map((item) => item.hash),
  );
  result.relevant = relevant.size;

  await store.insertItems(
    labelled.map((item) => {
      // ReliefWeb writes descriptions in Markdown; WhatsApp would show the symbols.
      const summary =
        htmlToText(item.job.description ?? '', 2000)
          .replace(/[*_#`>]+/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 300) || null;
      const card: OpportunityCard = {
        title: item.job.title,
        organization: item.job.organization ?? null,
        type: item.job.type ?? typeFromTitle(item.job.title, 'JOB'),
        field: null,
        location: item.job.location ?? 'Kenya',
        salary: null,
        deadline: item.job.deadline ? item.job.deadline.toISOString().slice(0, 10) : null,
        terms: null,
        requirements: null,
        summary: summary ? `${summary.replace(/\s\S*$/, '')}…` : null,
        applyUrl: item.url,
        original: false,
        foundOn: 'ReliefWeb',
        posted: item.job.datePosted ? item.job.datePosted.toISOString().slice(0, 10) : null,
      };
      return {
        hash: item.hash,
        site: 'reliefweb',
        url: item.url,
        title: item.label,
        relevant: relevant.has(item.hash),
        seeded: result.seeded,
        card,
      };
    }),
  );
  return result;
}

/**
 * JSearch, once a day: a few public-health searches for Kenya, rotating
 * through the topics so each comes round every other day.
 */
export async function scanJSearch(force = false): Promise<ScanResult> {
  const result: ScanResult = { site: 'jsearch', ok: false, candidates: 0, fresh: 0, relevant: 0, seeded: false };
  if (!jsearchConfigured()) return result;
  const today = localTime(new Date(), env.TIMEZONE).date;
  if (!force && (await store.getState('jsearch:last')) === today) {
    result.ok = true;
    return result;
  }
  await store.setState('jsearch:last', today);
  const dayNumber = Math.floor(Date.parse(`${today}T00:00:00Z`) / 86_400_000);

  const hits = new Map<string, JSearchHit>();
  for (const topic of topicsForDay(dayNumber)) {
    for (const hit of await searchKenya(topic)) hits.set(store.urlHash(hit.url), hit);
  }
  result.ok = true;
  result.candidates = hits.size;
  const known = await store.knownHashes([...hits.keys()]);
  const fresh = [...hits.entries()].filter(([hash]) => !known.has(hash));
  result.fresh = fresh.length;
  if (fresh.length === 0) return result;

  // The searches were already about public health; DeepSeek still weeds out
  // the near misses a keyword search always brings back.
  const verdict = await classifyTitles(fresh.map(([, hit]) => ({ title: hit.label, url: hit.url })), { name: 'JSearch', health: true });
  const relevant = new Set(
    fresh.filter(([, hit], index) => (verdict ? verdict.has(index) : keywordVerdict(hit.label, true))).map(([hash]) => hash),
  );
  result.relevant = relevant.size;
  await store.insertItems(
    fresh.map(([hash, hit]) => ({
      hash,
      site: 'jsearch',
      url: hit.url,
      title: hit.label,
      relevant: relevant.has(hash),
      seeded: false,
      card: hit.card,
    })),
  );
  return result;
}

export async function runScan(sites: readonly TrackedSite[] = TRACKED_SITES): Promise<ScanResult[]> {
  if (scanning) return [];
  scanning = true;
  const started = Date.now();
  const results: ScanResult[] = [];
  try {
    // A few sites at a time: polite to each, and the whole round stays short.
    const queue = [...sites];
    const workers = Array.from({ length: 4 }, async () => {
      for (let site = queue.shift(); site; site = queue.shift()) {
        try {
          results.push(await scanSite(site));
        } catch (cause) {
          log.warn({ site: site.slug, err: cause instanceof Error ? cause.message : String(cause) }, 'scan failed');
          results.push({ site: site.slug, ok: false, candidates: 0, fresh: 0, relevant: 0, seeded: false });
        }
      }
    });
    await Promise.all(workers);
    if (sites === TRACKED_SITES) {
      for (const [name, scan] of [
        ['ReliefWeb', scanReliefWeb],
        ['JSearch', () => scanJSearch()],
      ] as const) {
        try {
          results.push(await scan());
        } catch (cause) {
          log.warn({ source: name, err: cause instanceof Error ? cause.message : String(cause) }, 'scan failed');
        }
      }
    }
    const found = results.reduce((sum, result) => sum + result.relevant, 0);
    lastScan = { at: new Date(), found, failed: results.filter((result) => !result.ok).map((result) => result.site) };
    log.info(
      {
        sites: results.length,
        unreachable: lastScan.failed.length,
        newListings: results.reduce((sum, result) => sum + result.fresh, 0),
        publicHealth: found,
        durationMs: Date.now() - started,
        ai: aiAvailable(),
      },
      'site scan finished',
    );
  } finally {
    scanning = false;
  }
  return results;
}

// ── Cards ───────────────────────────────────────────────────────────────────

function siteFor(slug: string): TrackedSite {
  return (
    TRACKED_SITES.find((site) => site.slug === slug) ?? {
      slug,
      name: slug,
      url: '',
      health: false,
      defaultType: 'JOB',
      kenya: true,
      employer: false,
    }
  );
}

// ── Checking: source, dates, duplicates ─────────────────────────────────────

export type CheckOutcome = 'ready' | 'expired' | 'closed' | 'stale' | 'undated' | 'irrelevant' | 'duplicate';

/** Re-check a listing published or checked longer ago than this before sending it. */
const RECHECK_AFTER_MS = 3 * 86_400_000;

/**
 * Read a listing from its own page and decide whether it may be published:
 * its dates from the page's structured data first and DeepSeek second, its
 * validity from fixed rules, and whether we already hold the same
 * opportunity under another link. A listing that duplicates one we hold but
 * brings a new deadline updates that record instead of becoming a second one.
 */
export async function checkItem(row: store.TrackedRow): Promise<CheckOutcome> {
  const read = await readItem(row);
  return read === 'irrelevant' ? 'irrelevant' : decideItem(row, read);
}

/** The slow part — the page and DeepSeek — which can run in parallel. */
async function readItem(row: store.TrackedRow): Promise<OpportunityCard | 'irrelevant'> {
  const site = siteFor(row.site_slug);
  const base = { listingTitle: row.title, listingUrl: row.listing_url, site };

  let card: OpportunityCard;
  let facts: PageFacts | null;
  if (row.card && (row.site_slug === 'reliefweb' || row.site_slug === 'jsearch')) {
    // API sources already supplied the details; their pages refuse robots.
    card = row.card;
  } else {
    const page = /\.pdf($|\?)/i.test(row.listing_url) ? null : await fetchPage(row.listing_url);
    if (!page) {
      card = row.card ?? basicCard(base);
    } else {
      const text = htmlToText(page.html);
      facts = extractPageFacts(page.html, text);
      const extracted = await extractCard({
        ...base,
        pageText: text,
        links: extractLinks(page.html, page.finalUrl).filter((link) => link.external),
      });
      if (extracted === null) {
        await store.skipItem(row.url_hash, 'irrelevant');
        return 'irrelevant';
      }
      card = extracted === 'unavailable' ? basicCard(base) : extracted;
      // What the page states outright beats what a model read into it.
      card = {
        ...card,
        title: card.title || facts.title || row.title,
        organization: card.organization ?? facts.organization,
        location: facts.location ?? card.location,
        salary: facts.salary ?? card.salary,
        deadline: facts.deadline ?? card.deadline,
        posted: facts.posted ?? card.posted ?? null,
        terms: card.terms ?? facts.employmentType,
        emails: [...new Set([...(facts.emails ?? []), ...(card.emails ?? [])])].slice(0, 5),
        ...(facts.closed || card.closed ? { closed: true } : {}),
      };
    }
  }

  return card;
}

/** The decision — validity, then duplicates — which must run one at a time. */
async function decideItem(row: store.TrackedRow, card: OpportunityCard): Promise<CheckOutcome> {
  const validity = assessValidity({
    deadline: card.deadline,
    posted: card.posted ?? row.posted_on ?? null,
    firstSeen: new Date(row.first_seen_at),
    seeded: row.seeded,
    closed: card.closed === true,
  });
  if (!validity.ok) {
    await store.saveChecked(row.url_hash, { card, posted: card.posted ?? null, deadline: card.deadline, emails: card.emails ?? [] });
    await store.skipItem(row.url_hash, validity.reason);
    return validity.reason;
  }

  const identity = { title: card.title, organization: card.organization, location: card.location, applyUrl: card.applyUrl, listingUrl: row.listing_url, emails: card.emails ?? [] };
  for (const other of await store.comparables()) {
    if (other.url_hash === row.url_hash || !other.card) continue;
    const reason = sameOpportunity(identity, {
      title: other.card.title,
      organization: other.card.organization,
      location: other.card.location,
      applyUrl: other.card.applyUrl,
      listingUrl: other.listing_url,
      emails: other.emails ?? other.card.emails ?? [],
    });
    if (!reason) continue;
    // Same opportunity. If this copy knows something newer, update the one we keep.
    const update: OpportunityCard = { ...other.card };
    let changed = false;
    if (card.deadline && card.deadline !== other.card.deadline) {
      update.deadline = card.deadline;
      changed = true;
    }
    if (card.original && !other.card.original) {
      update.applyUrl = card.applyUrl;
      update.original = true;
      changed = true;
    }
    for (const field of ['salary', 'organization', 'requirements', 'summary', 'location'] as const) {
      if (!update[field] && card[field]) {
        update[field] = card[field];
        changed = true;
      }
    }
    if (changed) await store.updateCard(other.url_hash, update, update.deadline);
    await store.markDuplicate(row.url_hash, other.url_hash, reason);
    log.debug({ kept: other.url_hash, dropped: row.url_hash, reason, updated: changed }, 'duplicate opportunity');
    return 'duplicate';
  }

  await store.saveChecked(row.url_hash, { card, posted: card.posted ?? null, deadline: card.deadline, emails: card.emails ?? [] });
  return 'ready';
}

/**
 * Check up to `limit` waiting listings: pages read `concurrency` at a time,
 * decisions taken strictly one after another (each may depend on the last).
 */
export async function checkPending(limit: number, concurrency = 3): Promise<Record<CheckOutcome, number>> {
  const tally: Record<CheckOutcome, number> = { ready: 0, expired: 0, closed: 0, stale: 0, undated: 0, irrelevant: 0, duplicate: 0 };
  const queue = await store.pendingChecks(limit);
  let decisions = Promise.resolve();
  const workers = Array.from({ length: concurrency }, async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      const current = row;
      try {
        const read = await readItem(current);
        if (read === 'irrelevant') {
          tally.irrelevant += 1;
          continue;
        }
        decisions = decisions.then(async () => {
          try {
            tally[await decideItem(current, read)] += 1;
          } catch (cause) {
            log.warn({ item: current.url_hash, err: cause instanceof Error ? cause.message : String(cause) }, 'check failed');
          }
        });
      } catch (cause) {
        log.warn({ item: current.url_hash, err: cause instanceof Error ? cause.message : String(cause) }, 'check failed');
      }
    }
  });
  await Promise.all(workers);
  await decisions;
  return tally;
}

/** Before sending something checked a while ago: is it still there and still open? */
async function stillValid(row: store.TrackedRow): Promise<boolean> {
  const card = row.card;
  if (!card) return false;
  const validity = assessValidity({ deadline: card.deadline, posted: card.posted ?? row.posted_on ?? null, firstSeen: new Date(row.first_seen_at), seeded: row.seeded, closed: card.closed === true });
  if (!validity.ok) {
    await store.skipItem(row.url_hash, validity.reason);
    return false;
  }
  const checkedAt = row.checked_at ? new Date(row.checked_at).getTime() : 0;
  if (Date.now() - checkedAt > RECHECK_AFTER_MS && row.site_slug !== 'reliefweb' && row.site_slug !== 'jsearch') {
    const page = /\.pdf($|\?)/i.test(row.listing_url) ? true : await fetchPage(row.listing_url);
    if (page === null) {
      await store.skipItem(row.url_hash, 'unreachable');
      return false;
    }
    if (page !== true && extractPageFacts(page.html, htmlToText(page.html)).closed) {
      await store.skipItem(row.url_hash, 'closed');
      return false;
    }
  }
  return true;
}

// ── Announcing ──────────────────────────────────────────────────────────────

/** Send to every chat that has not had this listing yet, and log it. */
async function publish(
  rows: store.TrackedRow[],
  chats: string[],
  channel: string,
  send: (chatJid: string, rows: store.TrackedRow[]) => Promise<void>,
): Promise<number> {
  let delivered = 0;
  for (const chatJid of chats) {
    const already = await store.publishedTo(chatJid, rows.map((row) => row.url_hash));
    const fresh = rows.filter((row) => !already.has(row.url_hash));
    if (fresh.length === 0) continue;
    try {
      await send(chatJid, fresh);
      await store.recordPublications(fresh.map((row) => ({ hash: row.url_hash, chatJid, channel })));
      delivered += 1;
    } catch (cause) {
      log.warn({ chat: redactJid(chatJid), err: cause instanceof Error ? cause.message : String(cause) }, 'not delivered');
    }
    // A short gap between chats keeps WhatsApp from treating this as a burst.
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  for (const row of rows) await store.markAnnounced(row.url_hash);
  return delivered;
}

async function broadcast(send: (chatJid: string) => Promise<void>): Promise<number> {
  let delivered = 0;
  for (const chatJid of await store.subscribers()) {
    try {
      await send(chatJid);
      delivered += 1;
    } catch (cause) {
      log.warn({ chat: redactJid(chatJid), err: cause instanceof Error ? cause.message : String(cause) }, 'alert not delivered');
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return delivered;
}

/** Send the next opportunity to every subscribed chat. True if one went out. */
export async function dripOnce(): Promise<boolean> {
  if (!messenger?.connected()) return false;
  const chats = await store.subscribers();
  if (chats.length === 0) return false;
  // Nothing checked yet? Check a few now rather than wait for the background.
  if ((await store.readyToPublish(1)).length === 0) await checkPending(3, 1);
  for (const row of await store.readyToPublish(10)) {
    if (!(await stillValid(row))) continue;
    const text = renderCard(row.card!);
    const delivered = await publish([row], chats, 'drip', (chatJid) => messenger!.sendText(chatJid, text));
    log.info({ site: row.site_slug, chats: delivered }, 'opportunity announced');
    return true;
  }
  return false;
}

/** The Friday report and weekend message to every subscribed chat. */
export async function sendWeeklyReport(now = new Date()): Promise<void> {
  if (!messenger?.connected()) return;
  const local = localTime(now, env.TIMEZONE);
  const since = new Date(now.getTime() - ((local.weekday - 1) * 1440 + local.hour * 60 + local.minute) * 60_000);
  const rows = await store.itemsForWeek(since);
  const cards = rows
    .map((row) => row.card ?? basicCard({ listingTitle: row.title, listingUrl: row.listing_url, site: siteFor(row.site_slug) }))
    .filter((card) => card.closed !== true);
  const start = weekStart(local);
  const messages = renderWeeklyReport(cards, weekLabel(start), now);
  const csv = Buffer.from(weeklyReportCsv(cards), 'utf8');

  await broadcast(async (chatJid) => {
    for (const message of messages) await messenger!.sendText(chatJid, message);
    if (cards.length > 0) {
      await messenger!.sendDocument(chatJid, csv, `public-health-opportunities-${start}.csv`, 'text/csv', 'This week’s opportunities as a table');
    }
    await messenger!.sendText(chatJid, weekendMessage());
  });
  log.info({ opportunities: cards.length }, 'weekly report sent');
}

export interface PushAllResult {
  checked: Record<CheckOutcome, number>;
  published: number;
  chats: number;
}

let pushing = false;

/**
 * Everything valid that has not been published yet — including what was
 * collected earlier in the week — checked against its source, de-duplicated,
 * grouped by category and sent to the given chats as a list and a
 * spreadsheet. Each chat receives each opportunity once, ever; the log makes
 * a second .pushall send only what is new since the first.
 */
export async function pushAll(chats: string[], onProgress?: (message: string) => Promise<void>): Promise<PushAllResult> {
  if (!messenger?.connected()) throw new Error('WhatsApp is not connected');
  if (pushing) throw new Error('A .pushall is already running');
  pushing = true;
  try {
    const waiting = (await store.pendingChecks(1000)).length;
    if (waiting > 0 && onProgress) {
      await onProgress(`🔎 Checking ${waiting} opportunities against their original pages (deadlines, duplicates)… this can take a few minutes.`);
    }
    const checked = await checkPending(1000, 3);

    const ready: store.TrackedRow[] = [];
    for (const row of await store.readyToPublish(1000)) {
      if (await stillValid(row)) ready.push(row);
    }
    const label = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: env.TIMEZONE });
    const delivered = await publish(ready, chats, 'pushall', async (chatJid, rows) => {
      const cards = rows.map((row) => row.card!);
      for (const message of renderWeeklyReport(cards, label, new Date(), '📋 *All available public-health opportunities*')) {
        await messenger!.sendText(chatJid, message);
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      const csv = Buffer.from(weeklyReportCsv(cards), 'utf8');
      await messenger!.sendDocument(chatJid, csv, `public-health-opportunities-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv', 'All available opportunities as a table');
    });
    log.info({ checked, published: ready.length, chats: delivered }, 'push all finished');
    return { checked, published: ready.length, chats: delivered };
  } finally {
    pushing = false;
  }
}

// ── Schedule ────────────────────────────────────────────────────────────────

/** The gap between cards: set by an administrator with `.alerts interval`, or the default. */
export async function dripRange(): Promise<DripRange> {
  return parseDripRange((await store.getState('drip')) ?? '') ?? DEFAULT_DRIP;
}

/** Change the gap, and let the next card follow the new pace. */
export async function setDripRange(range: DripRange): Promise<void> {
  await store.setState('drip', `${range.minMinutes}-${range.maxMinutes}`);
  nextDripAt = Math.min(nextDripAt, Date.now() + nextDripDelayMs(range));
}


async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    if (!scanning && now >= nextScanAt) {
      nextScanAt = now + env.TRACKER_INTERVAL_MINUTES * 60_000;
      void runScan().catch((cause) => log.warn({ err: String(cause) }, 'scan round failed'));
    }

    // A few listings checked against their pages every minute, any day, so
    // the drip and .pushall have verified opportunities ready.
    if (!checking) {
      checking = true;
      void checkPending(4, 2)
        .catch((cause) => log.warn({ err: String(cause) }, 'background checks failed'))
        .finally(() => {
          checking = false;
        });
    }

    if ((await store.getState('paused')) === '1') return;
    const local = localTime(new Date(now), env.TIMEZONE);

    if (inDripWindow(local) && now >= nextDripAt) {
      nextDripAt = now + nextDripDelayMs(await dripRange());
      await dripOnce();
    }

    if (isReportTime(local)) {
      const key = `report:${weekStart(local)}`;
      if ((await store.getState(key)) !== 'sent' && messenger?.connected()) {
        await store.setState(key, 'sent');
        await sendWeeklyReport(new Date(now));
      }
    }
  } catch (cause) {
    log.warn({ err: cause instanceof Error ? cause.message : String(cause) }, 'tracker tick failed');
  } finally {
    ticking = false;
  }
}

export function startTracker(): void {
  if (env.TRACKER_ENABLED !== 'on' || timer) return;
  // The first scan shortly after startup; the first card after one interval,
  // so restarts never cause a burst.
  nextScanAt = Date.now() + 30_000;
  nextDripAt = Date.now() + nextDripDelayMs(DEFAULT_DRIP);
  timer = setInterval(() => void tick(), 60_000);
  timer.unref();
  log.info(
    { sites: TRACKED_SITES.length, intervalMinutes: env.TRACKER_INTERVAL_MINUTES, ai: aiAvailable() },
    'site tracker started',
  );
}

export function stopTracker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function trackerStatus(): Promise<{
  enabled: boolean;
  paused: boolean;
  sites: number;
  ai: boolean;
  lastScan: typeof lastScan;
  queue: number;
  subscribers: number;
  nextDripAt: Date | null;
  jsearch: boolean;
  drip: DripRange;
}> {
  return {
    enabled: env.TRACKER_ENABLED === 'on',
    paused: (await store.getState('paused')) === '1',
    sites: TRACKED_SITES.length,
    ai: aiAvailable(),
    lastScan,
    queue: await store.queueLength(),
    subscribers: (await store.subscribers()).length,
    nextDripAt: nextDripAt > 0 ? new Date(nextDripAt) : null,
    jsearch: jsearchConfigured(),
    drip: await dripRange(),
  };
}
