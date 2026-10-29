/**
 * Opportunity persistence.
 *
 * Search serves live source results for freshness, but everything discovered
 * is also written here. That store is what later phases build on: digests,
 * deadline alerts, the review queue, matching and analytics all need history,
 * and none of them can re-query an upstream for what it said last week.
 */
import { and, desc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { logger } from '../../core/logger.js';
import type { NormalizedOpportunity } from '../../domain/normalize.js';
import type { OpportunityStatus } from '../../domain/opportunity.js';
import { opportunities, type NewOpportunityRow, type OpportunityRow } from '../schema.js';

const log = logger.child({ component: 'repo:opportunities' });

/** Postgres rejects parameter counts above ~65k; chunk large batches. */
const INSERT_CHUNK_SIZE = 200;

function toRow(opportunity: NormalizedOpportunity): NewOpportunityRow {
  return {
    title: opportunity.title,
    organization: opportunity.organization,
    description: opportunity.description,
    type: opportunity.type,
    categories: opportunity.categories,
    location: opportunity.location,
    country: opportunity.country,
    remote: opportunity.remote,
    eligibility: opportunity.eligibility,
    educationLevel: opportunity.educationLevel,
    experienceLevel: opportunity.experienceLevel,
    deadline: opportunity.deadline,
    applicationUrl: opportunity.applicationUrl,
    sourceSlug: opportunity.sourceSlug,
    sourceName: opportunity.sourceName,
    sourceUrl: opportunity.sourceUrl,
    datePosted: opportunity.datePosted,
    status: opportunity.status,
    verificationStatus: opportunity.verificationStatus,
    tags: opportunity.tags,
    skills: opportunity.skills,
    compensation: opportunity.compensation,
    fingerprint: opportunity.fingerprint,
    externalKey: opportunity.externalKey,
  };
}

export interface UpsertSummary {
  attempted: number;
  written: number;
}

/**
 * Insert or refresh opportunities, keyed on `externalKey`.
 *
 * Re-syncing a source must not create duplicates, so this is an upsert. It
 * deliberately does NOT touch `status`, `verificationStatus`, `verifiedAt` or
 * `reviewNote`: those record human review decisions, and an automated sync
 * overwriting them would silently un-approve or re-approve content behind an
 * administrator's back.
 */
export async function upsertOpportunities(
  records: NormalizedOpportunity[],
): Promise<UpsertSummary> {
  if (records.length === 0) return { attempted: 0, written: 0 };

  // Within one batch the same externalKey can appear twice (two pages of the
  // same feed); Postgres cannot update the same row twice in one statement.
  const byKey = new Map<string, NormalizedOpportunity>();
  for (const record of records) byKey.set(record.externalKey, record);
  const deduped = Array.from(byKey.values());

  let written = 0;

  for (let offset = 0; offset < deduped.length; offset += INSERT_CHUNK_SIZE) {
    const chunk = deduped.slice(offset, offset + INSERT_CHUNK_SIZE).map(toRow);
    try {
      const inserted = await db
        .insert(opportunities)
        .values(chunk)
        .onConflictDoUpdate({
          target: opportunities.externalKey,
          set: {
            title: sql`excluded.title`,
            organization: sql`excluded.organization`,
            description: sql`excluded.description`,
            location: sql`excluded.location`,
            country: sql`excluded.country`,
            remote: sql`excluded.remote`,
            deadline: sql`excluded.deadline`,
            applicationUrl: sql`excluded.application_url`,
            sourceUrl: sql`excluded.source_url`,
            datePosted: sql`excluded.date_posted`,
            tags: sql`excluded.tags`,
            skills: sql`excluded.skills`,
            compensation: sql`excluded.compensation`,
            categories: sql`excluded.categories`,
            updatedAt: new Date(),
          },
        })
        .returning({ id: opportunities.id });
      written += inserted.length;
    } catch (cause) {
      // Persistence is a background concern for a search request: log and
      // continue so the member still gets their results.
      log.error({ err: cause instanceof Error ? cause.message : String(cause) }, 'upsert chunk failed');
    }
  }

  log.debug({ attempted: deduped.length, written }, 'opportunities upserted');
  return { attempted: deduped.length, written };
}

/** Mark opportunities whose stated deadline has passed. */
export async function expirePastDeadlines(now = new Date()): Promise<number> {
  const updated = await db
    .update(opportunities)
    .set({ status: 'EXPIRED', verificationStatus: 'EXPIRED', updatedAt: now })
    .where(
      and(
        isNotNull(opportunities.deadline),
        lte(opportunities.deadline, now),
        inArray(opportunities.status, ['DISCOVERED', 'PENDING_REVIEW', 'VERIFIED', 'PUBLISHED']),
      ),
    )
    .returning({ id: opportunities.id });
  if (updated.length > 0) log.info({ count: updated.length }, 'expired past-deadline opportunities');
  return updated.length;
}

/** Most recently discovered rows, for the admin review queue. */
export async function listByStatus(status: OpportunityStatus, limit = 20): Promise<OpportunityRow[]> {
  return db
    .select()
    .from(opportunities)
    .where(eq(opportunities.status, status))
    .orderBy(desc(opportunities.createdAt))
    .limit(limit);
}

export async function countAll(): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(opportunities);
  return row?.count ?? 0;
}

export async function findById(id: string): Promise<OpportunityRow | undefined> {
  const [row] = await db.select().from(opportunities).where(eq(opportunities.id, id)).limit(1);
  return row;
}
