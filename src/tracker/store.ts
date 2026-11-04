/**
 * The tracker's database: every listing it has seen (so nothing is announced
 * twice), the chats that asked for alerts, and a little schedule state.
 */
import { createHash } from 'node:crypto';
import { connection as sql } from '../db/client.js';
import type { OpportunityCard } from './card.js';

export interface TrackedRow {
  url_hash: string;
  site_slug: string;
  listing_url: string;
  title: string;
  relevant: boolean;
  seeded: boolean;
  card: OpportunityCard | null;
  first_seen_at: Date;
  announced_at: Date | null;
  posted_on?: string | null;
  deadline?: string | null;
  emails?: string[];
  checked_at?: Date | null;
}

const COLUMNS = 'url_hash, site_slug, listing_url, title, relevant, seeded, card, first_seen_at, announced_at, posted_on::text, deadline::text, emails, checked_at';

/** Same listing, same key: scheme, "www.", trailing slash and tracking tags ignored. */
export function urlHash(url: string): string {
  const parsed = new URL(url);
  for (const key of [...parsed.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|ref$|source$)/i.test(key)) parsed.searchParams.delete(key);
  }
  const normal = `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname.replace(/\/$/, '')}${parsed.search}`.toLowerCase();
  return createHash('sha256').update(normal).digest('hex').slice(0, 40);
}

export async function knownHashes(hashes: string[]): Promise<Set<string>> {
  if (hashes.length === 0) return new Set();
  const rows = await sql<{ url_hash: string }[]>`select url_hash from tracked_items where url_hash in ${sql(hashes)}`;
  return new Set(rows.map((row) => row.url_hash));
}

export async function siteHasItems(slug: string): Promise<boolean> {
  const rows = await sql`select 1 from tracked_items where site_slug = ${slug} limit 1`;
  return rows.length > 0;
}

export async function insertItems(
  items: Array<{
    hash: string;
    site: string;
    url: string;
    title: string;
    relevant: boolean;
    seeded: boolean;
    /** Known up front for API sources, which already supply the details. */
    card?: OpportunityCard;
  }>,
): Promise<void> {
  for (const item of items) {
    await sql`
      insert into tracked_items (url_hash, site_slug, listing_url, title, relevant, seeded, card)
      values (${item.hash}, ${item.site}, ${item.url}, ${item.title}, ${item.relevant}, ${item.seeded},
              ${item.card ? JSON.stringify(item.card) : null}::jsonb)
      on conflict (url_hash) do nothing`;
  }
}

/** Waiting to be announced: freshly found first, then what was there already. */
export async function nextInQueue(limit: number): Promise<TrackedRow[]> {
  return sql<TrackedRow[]>`
    select url_hash, site_slug, listing_url, title, relevant, seeded, card, first_seen_at, announced_at
    from tracked_items
    where relevant and announced_at is null and not skipped
    order by seeded asc, first_seen_at desc
    limit ${limit}`;
}

export async function queueLength(): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from tracked_items
    where relevant and announced_at is null and not skipped and duplicate_of is null`;
  return row?.n ?? 0;
}

export async function saveCard(hash: string, card: OpportunityCard): Promise<void> {
  await sql`update tracked_items set card = ${JSON.stringify(card)}::jsonb where url_hash = ${hash}`;
}

export async function markAnnounced(hash: string): Promise<void> {
  await sql`update tracked_items set announced_at = now() where url_hash = ${hash}`;
}

/** Not to be announced: expired, or turned out not to be public health. */
export async function markSkipped(hash: string, stillRelevant: boolean): Promise<void> {
  await sql`update tracked_items set skipped = true, relevant = ${stillRelevant} where url_hash = ${hash}`;
}

/** What the Friday report covers: found or announced since the week began. */
export async function itemsForWeek(since: Date): Promise<TrackedRow[]> {
  // As text: this connection is set up without the driver's Date conversion.
  const from = since.toISOString();
  return sql<TrackedRow[]>`
    select url_hash, site_slug, listing_url, title, relevant, seeded, card, first_seen_at, announced_at
    from tracked_items
    where relevant and not skipped and duplicate_of is null
      and (announced_at >= ${from}::timestamptz or (first_seen_at >= ${from}::timestamptz and not seeded))
    order by coalesce(announced_at, first_seen_at) asc`;
}

/** Recent public-health finds, for search. */
export async function recentRelevant(days: number, limit: number): Promise<TrackedRow[]> {
  return sql<TrackedRow[]>`
    select url_hash, site_slug, listing_url, title, relevant, seeded, card, first_seen_at, announced_at, posted_on::text
    from tracked_items
    where relevant and not skipped and duplicate_of is null
      and first_seen_at > now() - make_interval(days => ${days})
      and (deadline is null or deadline >= (now() at time zone 'Africa/Nairobi')::date)
      and (deadline is not null or posted_on is null or posted_on >= (now() at time zone 'Africa/Nairobi')::date - 30)
    order by first_seen_at desc
    limit ${limit}`;
}

export async function countsBySite(): Promise<Map<string, { total: number; relevant: number }>> {
  const rows = await sql<{ site_slug: string; total: number; relevant: number }[]>`
    select site_slug, count(*)::int as total, count(*) filter (where relevant)::int as relevant
    from tracked_items group by site_slug`;
  return new Map(rows.map((row) => [row.site_slug, { total: row.total, relevant: row.relevant }]));
}

// ── Checking and publishing ──

/** Listings found but not yet checked against their page: newest first. */
export async function pendingChecks(limit: number): Promise<TrackedRow[]> {
  return sql.unsafe<TrackedRow[]>(
    `select ${COLUMNS} from tracked_items
     where relevant and not skipped and duplicate_of is null and announced_at is null and checked_at is null
     order by seeded asc, first_seen_at desc limit $1`,
    [limit],
  );
}

/** Checked, valid and not yet published: what the drip and .pushall send. */
export async function readyToPublish(limit: number): Promise<TrackedRow[]> {
  return sql.unsafe<TrackedRow[]>(
    `select ${COLUMNS} from tracked_items
     where relevant and not skipped and duplicate_of is null and announced_at is null
       and checked_at is not null and card is not null
     order by seeded asc, coalesce(posted_on, first_seen_at::date) desc, first_seen_at desc limit $1`,
    [limit],
  );
}

/** Everything a new listing could duplicate: waiting or published in the last 90 days. */
export async function comparables(): Promise<TrackedRow[]> {
  return sql.unsafe<TrackedRow[]>(
    `select ${COLUMNS} from tracked_items
     where relevant and not skipped and duplicate_of is null and card is not null
       and (announced_at is null or announced_at > now() - interval '90 days')`,
  );
}

export async function saveChecked(
  hash: string,
  values: { card: OpportunityCard; posted: string | null; deadline: string | null; emails: string[] },
): Promise<void> {
  await sql`
    update tracked_items set card = ${JSON.stringify(values.card)}::jsonb, posted_on = ${values.posted}::date,
      deadline = ${values.deadline}::date, emails = ${values.emails}, checked_at = now(), skip_reason = null
    where url_hash = ${hash}`;
}

export async function skipItem(hash: string, reason: string): Promise<void> {
  await sql`update tracked_items set skipped = true, skip_reason = ${reason}, checked_at = now() where url_hash = ${hash}`;
}

export async function markDuplicate(hash: string, of: string, reason: string): Promise<void> {
  await sql`
    update tracked_items set duplicate_of = ${of}, skip_reason = ${`duplicate: ${reason}`}, checked_at = now()
    where url_hash = ${hash}`;
}

/** A listing we already hold changed (new deadline, better link): update it in place. */
export async function updateCard(hash: string, card: OpportunityCard, deadline: string | null): Promise<void> {
  await sql`
    update tracked_items set card = ${JSON.stringify(card)}::jsonb, deadline = ${deadline}::date, updated_at = now()
    where url_hash = ${hash}`;
}

/** Of these listings, the ones this chat has already received. */
export async function publishedTo(chatJid: string, hashes: string[]): Promise<Set<string>> {
  if (hashes.length === 0) return new Set();
  const rows = await sql<{ url_hash: string }[]>`
    select url_hash from publications where chat_jid = ${chatJid} and url_hash in ${sql(hashes)}`;
  return new Set(rows.map((row) => row.url_hash));
}

export async function recordPublications(rows: Array<{ hash: string; chatJid: string; channel: string }>): Promise<void> {
  for (const row of rows) {
    await sql`
      insert into publications (url_hash, chat_jid, channel) values (${row.hash}, ${row.chatJid}, ${row.channel})
      on conflict do nothing`;
  }
}

export async function qualityCounts(): Promise<{ duplicates: number; expired: number; stale: number; waitingCheck: number; ready: number }> {
  const [row] = await sql<{ duplicates: number; expired: number; stale: number; waiting_check: number; ready: number }[]>`
    select count(*) filter (where duplicate_of is not null)::int as duplicates,
           count(*) filter (where skip_reason in ('expired', 'closed'))::int as expired,
           count(*) filter (where skip_reason in ('stale', 'undated', 'unreachable'))::int as stale,
           count(*) filter (where relevant and not skipped and duplicate_of is null and announced_at is null and checked_at is null)::int as waiting_check,
           count(*) filter (where relevant and not skipped and duplicate_of is null and announced_at is null and checked_at is not null)::int as ready
    from tracked_items`;
  return {
    duplicates: row?.duplicates ?? 0,
    expired: row?.expired ?? 0,
    stale: row?.stale ?? 0,
    waitingCheck: row?.waiting_check ?? 0,
    ready: row?.ready ?? 0,
  };
}

// ── Subscriptions ──

export async function subscribe(chatJid: string, by: string): Promise<boolean> {
  const rows = await sql`
    insert into alert_subscriptions (chat_jid, created_by) values (${chatJid}, ${by})
    on conflict (chat_jid) do nothing returning chat_jid`;
  return rows.length > 0;
}

export async function unsubscribe(chatJid: string): Promise<boolean> {
  const rows = await sql`delete from alert_subscriptions where chat_jid = ${chatJid} returning chat_jid`;
  return rows.length > 0;
}

export async function subscribers(): Promise<string[]> {
  const rows = await sql<{ chat_jid: string }[]>`select chat_jid from alert_subscriptions order by created_at`;
  return rows.map((row) => row.chat_jid);
}

export async function isSubscribed(chatJid: string): Promise<boolean> {
  const rows = await sql`select 1 from alert_subscriptions where chat_jid = ${chatJid}`;
  return rows.length > 0;
}

// ── State ──

export async function getState(key: string): Promise<string | null> {
  const [row] = await sql<{ value: string }[]>`select value from tracker_state where key = ${key}`;
  return row?.value ?? null;
}

export async function setState(key: string, value: string): Promise<void> {
  await sql`
    insert into tracker_state (key, value) values (${key}, ${value})
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
}
