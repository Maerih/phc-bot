/**
 * Group settings and moderation warnings.
 */
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { TtlCache } from '../../core/cache.js';
import { db } from '../client.js';
import {
  groupSettings,
  memberSilences,
  warnings,
  type GroupSettingsRow,
  type MemberSilenceRow,
  type WarningRow,
} from '../schema.js';

export type ModerationAction = 'OFF' | 'WARN' | 'DELETE' | 'REMOVE';

// Moderation reads settings for every group message, so they are cached
// briefly. Every write below goes through this module and invalidates, so an
// admin's change applies to the very next message.
const settingsCache = new TtlCache<GroupSettingsRow | null>(60_000, 2000);
const silenceCache = new TtlCache<MemberSilenceRow[]>(60_000, 2000);

/**
 * A group's settings without creating a row: null for groups no admin has
 * configured, which is most of them and needs no moderation at all.
 */
export async function findGroupSettings(groupJid: string): Promise<GroupSettingsRow | null> {
  const cached = settingsCache.get(groupJid);
  if (cached !== undefined) return cached;
  const [row] = await db
    .select()
    .from(groupSettings)
    .where(eq(groupSettings.groupJid, groupJid))
    .limit(1);
  settingsCache.set(groupJid, row ?? null);
  return row ?? null;
}

/**
 * Fetch a group's settings, creating the row on first use.
 *
 * Lazy creation keeps the table proportional to groups actually being
 * moderated rather than every group the bot was ever added to.
 */
export async function getGroupSettings(groupJid: string): Promise<GroupSettingsRow> {
  const [existing] = await db
    .select()
    .from(groupSettings)
    .where(eq(groupSettings.groupJid, groupJid))
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(groupSettings)
    .values({ groupJid })
    .onConflictDoUpdate({
      target: groupSettings.groupJid,
      // A concurrent insert must not throw; touching updatedAt returns the row.
      set: { updatedAt: new Date() },
    })
    .returning();

  if (!created) throw new Error('failed to create group settings');
  return created;
}

export async function updateGroupSettings(
  groupJid: string,
  patch: Partial<Omit<GroupSettingsRow, 'id' | 'groupJid' | 'createdAt' | 'updatedAt'>>,
): Promise<GroupSettingsRow> {
  await getGroupSettings(groupJid);
  const [updated] = await db
    .update(groupSettings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(groupSettings.groupJid, groupJid))
    .returning();
  if (!updated) throw new Error('failed to update group settings');
  settingsCache.set(groupJid, updated);
  return updated;
}

// ── Silences ─────────────────────────────────────────────────────────────────

/** Silence a member under every id they are known by, until `until`. */
export async function silenceMember(
  groupJid: string,
  memberJids: string[],
  until: Date,
  issuedBy: string,
): Promise<void> {
  for (const memberJid of new Set(memberJids)) {
    await db
      .insert(memberSilences)
      .values({ groupJid, memberJid, until, issuedBy })
      .onConflictDoUpdate({
        target: [memberSilences.groupJid, memberSilences.memberJid],
        set: { until, issuedBy, createdAt: new Date() },
      });
  }
  silenceCache.delete(groupJid);
}

/** Lift a silence. Returns how many identities were cleared. */
export async function unsilenceMember(groupJid: string, memberJids: string[]): Promise<number> {
  if (memberJids.length === 0) return 0;
  const cleared = await db
    .delete(memberSilences)
    .where(and(eq(memberSilences.groupJid, groupJid), inArray(memberSilences.memberJid, memberJids)))
    .returning({ id: memberSilences.id });
  silenceCache.delete(groupJid);
  return cleared.length;
}

/** Silences still in force in a group. */
export async function activeSilences(groupJid: string): Promise<MemberSilenceRow[]> {
  const cached = silenceCache.get(groupJid);
  const now = new Date();
  if (cached !== undefined) return cached.filter((row) => row.until > now);
  const rows = await db
    .select()
    .from(memberSilences)
    .where(and(eq(memberSilences.groupJid, groupJid), gt(memberSilences.until, now)));
  silenceCache.set(groupJid, rows);
  return rows;
}

export interface IssueWarningInput {
  groupJid: string;
  targetJid: string;
  issuedBy: string;
  reason?: string | null;
}

/** Record a warning and return how many are now active for that participant. */
export async function issueWarning(input: IssueWarningInput): Promise<number> {
  await db.insert(warnings).values({
    groupJid: input.groupJid,
    targetJid: input.targetJid,
    issuedBy: input.issuedBy,
    reason: input.reason ?? null,
  });
  return countActiveWarnings(input.groupJid, input.targetJid);
}

export async function countActiveWarnings(groupJid: string, targetJid: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(warnings)
    .where(
      and(
        eq(warnings.groupJid, groupJid),
        eq(warnings.targetJid, targetJid),
        eq(warnings.active, true),
      ),
    );
  return row?.count ?? 0;
}

export async function listWarnings(
  groupJid: string,
  targetJid: string,
  limit = 10,
): Promise<WarningRow[]> {
  return db
    .select()
    .from(warnings)
    .where(
      and(
        eq(warnings.groupJid, groupJid),
        eq(warnings.targetJid, targetJid),
        eq(warnings.active, true),
      ),
    )
    .orderBy(desc(warnings.createdAt))
    .limit(limit);
}

/**
 * Clear a participant's warnings.
 *
 * Deactivates rather than deletes: the history stays auditable, which matters
 * if someone later asks why a member was removed.
 */
export async function clearWarnings(groupJid: string, targetJid: string): Promise<number> {
  const cleared = await db
    .update(warnings)
    .set({ active: false })
    .where(
      and(
        eq(warnings.groupJid, groupJid),
        eq(warnings.targetJid, targetJid),
        eq(warnings.active, true),
      ),
    )
    .returning({ id: warnings.id });
  return cleared.length;
}
