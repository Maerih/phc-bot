/**
 * Member persistence.
 *
 * Privacy posture: a member row is created on first contact because the
 * platform cannot rate-limit, personalise or notify without one — but it holds
 * only the WhatsApp JID plus whatever the member later chooses to tell us.
 * We never copy in a push-name, profile photo or contact-book entry.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { env } from '../../config/env.js';
import { commandLog, members, type MemberRow } from '../schema.js';

/** Digits-only user part of a JID: "254712345678@s.whatsapp.net" -> "254712345678". */
export function phoneFromJid(jid: string): string {
  const user = jid.split('@')[0] ?? '';
  // Strip the device suffix WhatsApp appends to multi-device JIDs ("…:12").
  return (user.split(':')[0] ?? '').replace(/\D/g, '');
}

/** Admin status is derived from configuration, never from anything a member sends. */
export function isConfiguredAdmin(jid: string): boolean {
  const phone = phoneFromJid(jid);
  return phone.length > 0 && env.ADMIN_NUMBERS.includes(phone);
}

/**
 * Fetch or create the member for a JID, refreshing `lastSeenAt`.
 * `isAdmin` is re-synced from config on every contact so removing a number
 * from ADMIN_NUMBERS takes effect immediately.
 */
export async function touchMember(jid: string): Promise<MemberRow> {
  const admin = isConfiguredAdmin(jid);
  const now = new Date();

  const [row] = await db
    .insert(members)
    .values({ waJid: jid, isAdmin: admin, lastSeenAt: now })
    .onConflictDoUpdate({
      target: members.waJid,
      set: { lastSeenAt: now, isAdmin: admin, updatedAt: now },
    })
    .returning();

  if (!row) throw new Error(`failed to upsert member for jid`);
  return row;
}

/**
 * Token-bucket rate limit, persisted so a restart cannot be used to reset it.
 * Returns true when the command may proceed.
 */
export async function consumeRateToken(
  memberId: string,
  options: { capacity?: number; refillPerMinute?: number } = {},
): Promise<boolean> {
  const capacity = options.capacity ?? 20;
  const refillPerMinute = options.refillPerMinute ?? 4;
  const now = new Date();

  const [row] = await db.select().from(members).where(eq(members.id, memberId)).limit(1);
  if (!row) return false;

  const elapsedMinutes = (now.getTime() - row.rateUpdatedAt.getTime()) / 60_000;
  const refilled = Math.min(capacity, row.rateTokens + Math.floor(elapsedMinutes * refillPerMinute));

  if (refilled < 1) {
    await db.update(members).set({ rateTokens: refilled, rateUpdatedAt: now }).where(eq(members.id, memberId));
    return false;
  }

  await db
    .update(members)
    .set({ rateTokens: refilled - 1, rateUpdatedAt: now })
    .where(eq(members.id, memberId));
  return true;
}

export interface CommandLogEntry {
  memberId: string | null;
  command: string;
  queryTerms?: string[];
  resultCount?: number | null;
  durationMs?: number | null;
  ok?: boolean;
  errorKind?: string | null;
}

/** Record command usage for analytics. Never stores raw message text. */
export async function logCommand(entry: CommandLogEntry): Promise<void> {
  await db.insert(commandLog).values({
    memberId: entry.memberId,
    command: entry.command,
    // Capped: this is for aggregate "what is popular", not a search history.
    queryTerms: (entry.queryTerms ?? []).slice(0, 10),
    resultCount: entry.resultCount ?? null,
    durationMs: entry.durationMs ?? null,
    ok: entry.ok ?? true,
    errorKind: entry.errorKind ?? null,
  });
}

export async function countMembers(): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(members);
  return row?.count ?? 0;
}

/** Members seen within the window — the "active members" dashboard metric. */
export async function countActiveMembers(sinceDays = 7): Promise<number> {
  const since = new Date(Date.now() - sinceDays * 86_400_000);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(members)
    .where(and(gte(members.lastSeenAt, since), eq(members.isBlocked, false)));
  return row?.count ?? 0;
}
