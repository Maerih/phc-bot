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
import { extractLinks, htmlToText, listingCandidates } from './html.js';
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

function deadlinePassed(card: OpportunityCard): boolean {
  if (!card.deadline) return false;
  return new Date(`${card.deadline}T23:59:59+03:00`).getTime() < Date.now();
}

/** The card for a queued listing, reading its page the first time. Null: skip it. */
export async function prepareCard(row: store.TrackedRow): Promise<OpportunityCard | null> {
  if (row.card) return deadlinePassed(row.card) ? null : row.card;
  const site = siteFor(row.site_slug);
  const base = { listingTitle: row.title, listingUrl: row.listing_url, site };

  let card: OpportunityCard;
  const page = /\.pdf($|\?)/i.test(row.listing_url) ? null : await fetchPage(row.listing_url);
  if (!page) {
    card = basicCard(base);
  } else {
    const extracted = await extractCard({
      ...base,
      pageText: htmlToText(page.html),
      links: extractLinks(page.html, page.finalUrl).filter((link) => link.external),
    });
    if (extracted === null) {
      await store.markSkipped(row.url_hash, false);
      return null;
    }
    card = extracted === 'unavailable' ? basicCard(base) : extracted;
  }

  await store.saveCard(row.url_hash, card);
  if (deadlinePassed(card)) {
    await store.markSkipped(row.url_hash, true);
    return null;
  }
  return card;
}

// ── Announcing ──────────────────────────────────────────────────────────────

async function broadcast(send: (chatJid: string) => Promise<void>): Promise<number> {
  let delivered = 0;
  for (const chatJid of await store.subscribers()) {
    try {
      await send(chatJid);
      delivered += 1;
    } catch (cause) {
      log.warn({ chat: redactJid(chatJid), err: cause instanceof Error ? cause.message : String(cause) }, 'alert not delivered');
    }
    // A short gap between chats keeps WhatsApp from treating this as a burst.
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return delivered;
}

/** Send the next opportunity to every subscribed chat. True if one went out. */
export async function dripOnce(): Promise<boolean> {
  if (!messenger?.connected()) return false;
  if ((await store.subscribers()).length === 0) return false;
  const queue = await store.nextInQueue(8);
  for (const row of queue) {
    const card = await prepareCard(row);
    if (!card) continue;
    const text = renderCard(card);
    const delivered = await broadcast((chatJid) => messenger!.sendText(chatJid, text));
    await store.markAnnounced(row.url_hash);
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
  const cards = rows.map((row) => row.card ?? basicCard({ listingTitle: row.title, listingUrl: row.listing_url, site: siteFor(row.site_slug) }));
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

/**
 * Everything waiting, to one chat, as a list and a spreadsheet: all at once
 * without a burst of separate messages, which WhatsApp punishes. The drip
 * carries on afterwards with full cards.
 */
export async function pushAll(chatJid: string): Promise<number> {
  if (!messenger?.connected()) throw new Error('WhatsApp is not connected');
  const rows = await store.nextInQueue(1000);
  const cards = rows
    .map((row) => row.card ?? basicCard({ listingTitle: row.title, listingUrl: row.listing_url, site: siteFor(row.site_slug) }))
    .filter((card) => !deadlinePassed(card));
  const label = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: env.TIMEZONE });
  const messages = renderWeeklyReport(cards, label, new Date(), '📋 *All public-health opportunities waiting*');
  for (const message of messages) {
    await messenger.sendText(chatJid, message);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if (cards.length > 0) {
    const csv = Buffer.from(weeklyReportCsv(cards), 'utf8');
    await messenger.sendDocument(chatJid, csv, `public-health-opportunities-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv', 'All waiting opportunities as a table');
  }
  return cards.length;
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
