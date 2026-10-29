/**
 * PostgreSQL schema (Drizzle ORM).
 *
 * Design notes:
 *  - `opportunities` is one table for all 14 opportunity types. Type-specific
 *    nuance lives in columns that may be null, not in parallel tables, so a new
 *    type needs no migration.
 *  - Member identity is the WhatsApp JID and nothing else. We never store a
 *    second copy of a phone number, a contact name pulled from the address
 *    book, or anything the member did not give us.
 *  - Analytics rows reference `members.id`, never a raw number, so the command
 *    log cannot be turned back into a phone list without the members table.
 */
import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
// Type-only import: erased at compile time, so drizzle-kit — which bundles
// this file as CommonJS and cannot resolve a ".js" specifier onto a ".ts"
// source — never has to resolve it. The enum *values* are therefore declared
// below rather than imported, and `AssertSameUnion` makes `tsc` fail if the two
// ever drift apart. The domain module stays the single source of truth for the
// types themselves.
import type {
  Category,
  EducationLevel,
  ExperienceLevel,
  OpportunityStatus,
  OpportunityType,
  VerificationStatus,
} from '../domain/opportunity.js';

// ── Enums ────────────────────────────────────────────────────────────────────

/** `true` only when the two unions are mutually assignable. */
type AssertSameUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const OPPORTUNITY_TYPE_VALUES = [
  'JOB', 'INTERNSHIP', 'SCHOLARSHIP', 'FELLOWSHIP', 'RESEARCH', 'GRANT',
  'CONFERENCE', 'TRAINING', 'HACKATHON', 'VOLUNTEER', 'PROJECT', 'MENTORSHIP',
  'EVENT', 'PROGRAM',
] as const;

const OPPORTUNITY_STATUS_VALUES = [
  'DISCOVERED', 'PENDING_REVIEW', 'VERIFIED', 'PUBLISHED', 'EXPIRED', 'REJECTED',
] as const;

const VERIFICATION_STATUS_VALUES = [
  'UNVERIFIED', 'SOURCE_VERIFIED', 'AI_ASSISTED', 'ADMIN_VERIFIED', 'EXPIRED', 'FLAGGED',
] as const;

const EXPERIENCE_LEVEL_VALUES = ['UNKNOWN', 'ENTRY', 'GRADUATE', 'MID', 'SENIOR', 'EXECUTIVE'] as const;

const EDUCATION_LEVEL_VALUES = [
  'UNKNOWN', 'SECONDARY', 'CERTIFICATE', 'DIPLOMA', 'BACHELORS', 'MASTERS', 'DOCTORATE',
] as const;

const CATEGORY_VALUES = [
  'PUBLIC_HEALTH', 'EPIDEMIOLOGY', 'GLOBAL_HEALTH', 'HEALTH_INFORMATICS',
  'DIGITAL_HEALTH', 'HEALTH_POLICY', 'MONITORING_EVALUATION', 'BIOSTATISTICS',
  'DATA_SCIENCE', 'ENVIRONMENTAL_HEALTH', 'MENTAL_HEALTH', 'NUTRITION',
  'MATERNAL_CHILD_HEALTH', 'INFECTIOUS_DISEASE', 'HEALTH_ECONOMICS', 'RESEARCH',
  'CYBERSECURITY', 'SOFTWARE', 'AI', 'OTHER',
] as const;

// Build-time drift guards. Adding a value to the domain without adding it here
// (or vice versa) is a type error, not a runtime surprise in a migration.
const _assertTypes: AssertSameUnion<OpportunityType, (typeof OPPORTUNITY_TYPE_VALUES)[number]> = true;
const _assertStatuses: AssertSameUnion<OpportunityStatus, (typeof OPPORTUNITY_STATUS_VALUES)[number]> = true;
const _assertVerification: AssertSameUnion<VerificationStatus, (typeof VERIFICATION_STATUS_VALUES)[number]> = true;
const _assertExperience: AssertSameUnion<ExperienceLevel, (typeof EXPERIENCE_LEVEL_VALUES)[number]> = true;
const _assertEducation: AssertSameUnion<EducationLevel, (typeof EDUCATION_LEVEL_VALUES)[number]> = true;
const _assertCategories: AssertSameUnion<Category, (typeof CATEGORY_VALUES)[number]> = true;
void _assertTypes;
void _assertStatuses;
void _assertVerification;
void _assertExperience;
void _assertEducation;
void _assertCategories;

export const opportunityTypeEnum = pgEnum('opportunity_type', OPPORTUNITY_TYPE_VALUES);
export const opportunityStatusEnum = pgEnum('opportunity_status', OPPORTUNITY_STATUS_VALUES);
export const verificationStatusEnum = pgEnum('verification_status', VERIFICATION_STATUS_VALUES);
export const experienceLevelEnum = pgEnum('experience_level', EXPERIENCE_LEVEL_VALUES);
export const educationLevelEnum = pgEnum('education_level', EDUCATION_LEVEL_VALUES);
export const categoryEnum = pgEnum('category', CATEGORY_VALUES);
export const notifyModeEnum = pgEnum('notify_mode', ['IMMEDIATE', 'DAILY', 'WEEKLY', 'OFF']);
export const sourceKindEnum = pgEnum('source_kind', ['API', 'RSS', 'SCRAPE', 'MANUAL']);

// ── Sources ──────────────────────────────────────────────────────────────────

/**
 * One row per connector. `enabled` here is the runtime switch an administrator
 * flips; SOURCES_ENABLED in the environment is the deploy-time default.
 */
export const sources = pgTable(
  'sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    kind: sourceKindEnum('kind').notNull().default('API'),
    homepageUrl: text('homepage_url'),
    enabled: boolean('enabled').notNull().default(true),

    /**
     * Attribution requirement. Some upstreams (Remotive, for one) grant API
     * access on condition that listings credit them and link back, so the
     * obligation travels with the row rather than living in a comment.
     */
    attributionRequired: boolean('attribution_required').notNull().default(false),
    attributionText: text('attribution_text'),

    /** Politeness contract: minimum gap between fetches, in minutes. */
    minFetchIntervalMinutes: integer('min_fetch_interval_minutes').notNull().default(360),

    /**
     * Operator trust, 0-100. Feeds the ranking function: a WHO careers page
     * outranks an open aggregator for the same role.
     */
    trustScore: integer('trust_score').notNull().default(50),

    lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true }),
    lastSucceededAt: timestamp('last_succeeded_at', { withTimezone: true }),
    lastError: text('last_error'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('sources_slug_idx').on(table.slug)],
);

// ── Opportunities ────────────────────────────────────────────────────────────

export const opportunities = pgTable(
  'opportunities',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    title: text('title').notNull(),
    organization: text('organization'),
    description: text('description'),

    type: opportunityTypeEnum('type').notNull(),
    categories: categoryEnum('categories').array().notNull().default([]),

    location: text('location'),
    /** ISO-3166 alpha-2. */
    country: text('country'),
    /** Tri-state on purpose: null means the source did not say. */
    remote: boolean('remote'),

    eligibility: text('eligibility'),
    educationLevel: educationLevelEnum('education_level').notNull().default('UNKNOWN'),
    experienceLevel: experienceLevelEnum('experience_level').notNull().default('UNKNOWN'),

    deadline: timestamp('deadline', { withTimezone: true }),
    applicationUrl: text('application_url'),

    sourceId: uuid('source_id').references(() => sources.id, { onDelete: 'set null' }),
    sourceSlug: text('source_slug').notNull(),
    sourceName: text('source_name').notNull(),
    sourceUrl: text('source_url'),
    datePosted: timestamp('date_posted', { withTimezone: true }),

    status: opportunityStatusEnum('status').notNull().default('DISCOVERED'),
    verificationStatus: verificationStatusEnum('verification_status').notNull().default('UNVERIFIED'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    verifiedBy: text('verified_by'),
    /** Why a record was rejected or flagged — shown in the review queue. */
    reviewNote: text('review_note'),

    tags: text('tags').array().notNull().default([]),
    skills: text('skills').array().notNull().default([]),
    compensation: text('compensation'),

    /** Cross-source content hash; duplicates share it. */
    fingerprint: text('fingerprint').notNull(),
    /** Per-source idempotency key for upserts. */
    externalKey: text('external_key').notNull(),
    /** Set when this row was folded into another as a duplicate. */
    duplicateOfId: uuid('duplicate_of_id'),

    /** Moderation signal, 0-100. High means "needs a human", never auto-ban. */
    riskScore: integer('risk_score').notNull().default(0),
    riskReasons: text('risk_reasons').array().notNull().default([]),

    /** Whatever the connector saw, kept for debugging and re-normalisation. */
    rawPayload: jsonb('raw_payload'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('opportunities_external_key_idx').on(table.externalKey),
    index('opportunities_fingerprint_idx').on(table.fingerprint),
    index('opportunities_status_idx').on(table.status),
    index('opportunities_type_idx').on(table.type),
    index('opportunities_country_idx').on(table.country),
    index('opportunities_deadline_idx').on(table.deadline),
    index('opportunities_date_posted_idx').on(table.datePosted),
  ],
);

// ── Members ──────────────────────────────────────────────────────────────────

export const members = pgTable(
  'members',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** WhatsApp JID — the only identifier we keep. */
    waJid: text('wa_jid').notNull(),

    /** Self-declared profile. Every field optional; nothing is required to use the bot. */
    displayName: text('display_name'),
    country: text('country'),
    field: text('field'),
    educationLevel: educationLevelEnum('education_level').notNull().default('UNKNOWN'),
    experienceLevel: experienceLevelEnum('experience_level').notNull().default('UNKNOWN'),
    interests: categoryEnum('interests').array().notNull().default([]),
    skills: text('skills').array().notNull().default([]),
    preferredLocations: text('preferred_locations').array().notNull().default([]),
    remotePreference: boolean('remote_preference'),
    opportunityTypes: opportunityTypeEnum('opportunity_types').array().notNull().default([]),

    notifyMode: notifyModeEnum('notify_mode').notNull().default('DAILY'),
    isAdmin: boolean('is_admin').notNull().default(false),
    isBlocked: boolean('is_blocked').notNull().default(false),

    /** Token-bucket state for per-member rate limiting. */
    rateTokens: integer('rate_tokens').notNull().default(20),
    rateUpdatedAt: timestamp('rate_updated_at', { withTimezone: true }).notNull().defaultNow(),

    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('members_wa_jid_idx').on(table.waJid)],
);

// ── Subscriptions ────────────────────────────────────────────────────────────

/** A member's interest in a topic: a category, a type, or a free-text keyword. */
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    /** Canonical topic slug, e.g. "scholarships", "public-health", "cybersecurity". */
    topic: text('topic').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('subscriptions_member_topic_idx').on(table.memberId, table.topic),
    index('subscriptions_topic_idx').on(table.topic),
  ],
);

// ── Saved opportunities ──────────────────────────────────────────────────────

export const savedOpportunities = pgTable(
  'saved_opportunities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('saved_member_opportunity_idx').on(table.memberId, table.opportunityId)],
);

// ── Group administration ─────────────────────────────────────────────────────

/** What antilink does when a link is posted by a non-admin. */
export const moderationActionEnum = pgEnum('moderation_action', ['OFF', 'WARN', 'DELETE', 'REMOVE']);

/**
 * Per-group configuration.
 *
 * One row per WhatsApp group, created lazily the first time an administrator
 * changes a setting. Groups the bot merely sits in cost nothing.
 */
export const groupSettings = pgTable(
  'group_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupJid: text('group_jid').notNull(),

    /** Action taken when a non-admin posts a link. */
    antilink: moderationActionEnum('antilink').notNull().default('OFF'),
    /** Action taken when a non-admin posts a known bad word. */
    antibadword: moderationActionEnum('antibadword').notNull().default('OFF'),

    welcomeEnabled: boolean('welcome_enabled').notNull().default(false),
    welcomeMessage: text('welcome_message'),
    goodbyeEnabled: boolean('goodbye_enabled').notNull().default(false),
    goodbyeMessage: text('goodbye_message'),

    /** Warnings before the configured antilink action escalates to removal. */
    warnLimit: integer('warn_limit').notNull().default(3),

    // Added by migration 0001_moderation (src/db/migrations.ts).
    /** Action taken on adverts and promotions. */
    antipromo: moderationActionEnum('antipromo').notNull().default('OFF'),
    /** Action taken on flooding, repeated and cross-posted messages. */
    antispam: moderationActionEnum('antispam').notNull().default('OFF'),
    /** INVITES: WhatsApp/Telegram invite and contact links only. ALL: any link. */
    linkScope: text('link_scope', { enum: ['INVITES', 'ALL'] }).notNull().default('INVITES'),
    /** Domains antilink never touches, e.g. a trusted job board. */
    allowedDomains: text('allowed_domains').array().notNull().default(sql`'{}'::text[]`),
    /** Words and phrases antibadword acts on. */
    bannedWords: text('banned_words').array().notNull().default(sql`'{}'::text[]`),
    /** Ask the AI about borderline adverts that the rules alone cannot decide. */
    aiReview: boolean('ai_review').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('group_settings_jid_idx').on(table.groupJid)],
);

/**
 * Moderation warnings.
 *
 * Kept as an append-only log rather than a counter so an administrator
 * reviewing a removal can see what actually happened, who issued each warning
 * and when. A bare count cannot be audited.
 */
export const warnings = pgTable(
  'warnings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupJid: text('group_jid').notNull(),
    /** The warned participant. */
    targetJid: text('target_jid').notNull(),
    /** Who issued it: an admin JID, or 'system' for automated moderation. */
    issuedBy: text('issued_by').notNull(),
    reason: text('reason'),
    /** Cleared warnings stay in the log but stop counting towards the limit. */
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('warnings_group_target_idx').on(table.groupJid, table.targetJid),
    index('warnings_created_at_idx').on(table.createdAt),
  ],
);

/**
 * Members silenced in a group: the bot deletes whatever they post until
 * `until`. WhatsApp has no per-member mute, so this is the closest thing.
 *
 * One row per identity, because a member may post under a phone JID or a LID.
 */
export const memberSilences = pgTable(
  'member_silences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupJid: text('group_jid').notNull(),
    memberJid: text('member_jid').notNull(),
    until: timestamp('until', { withTimezone: true }).notNull(),
    issuedBy: text('issued_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('member_silences_group_member_idx').on(table.groupJid, table.memberJid)],
);

// ── Analytics ────────────────────────────────────────────────────────────────

/**
 * Command usage, for "what does the community actually ask for".
 * Stores the command and a coarse result count — never the raw message text,
 * which could contain anything a member typed.
 */
export const commandLog = pgTable(
  'command_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memberId: uuid('member_id').references(() => members.id, { onDelete: 'set null' }),
    command: text('command').notNull(),
    /** Normalised search terms only, capped — used for "most searched" stats. */
    queryTerms: text('query_terms').array().notNull().default([]),
    resultCount: integer('result_count'),
    durationMs: integer('duration_ms'),
    ok: boolean('ok').notNull().default(true),
    errorKind: text('error_kind'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('command_log_command_idx').on(table.command),
    index('command_log_created_at_idx').on(table.createdAt),
  ],
);

// ── Relations ────────────────────────────────────────────────────────────────

export const sourcesRelations = relations(sources, ({ many }) => ({
  opportunities: many(opportunities),
}));

export const opportunitiesRelations = relations(opportunities, ({ one, many }) => ({
  source: one(sources, { fields: [opportunities.sourceId], references: [sources.id] }),
  savedBy: many(savedOpportunities),
}));

export const membersRelations = relations(members, ({ many }) => ({
  subscriptions: many(subscriptions),
  saved: many(savedOpportunities),
}));

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  member: one(members, { fields: [subscriptions.memberId], references: [members.id] }),
}));

export const savedOpportunitiesRelations = relations(savedOpportunities, ({ one }) => ({
  member: one(members, { fields: [savedOpportunities.memberId], references: [members.id] }),
  opportunity: one(opportunities, {
    fields: [savedOpportunities.opportunityId],
    references: [opportunities.id],
  }),
}));

export type SourceRow = typeof sources.$inferSelect;
export type OpportunityRow = typeof opportunities.$inferSelect;
export type NewOpportunityRow = typeof opportunities.$inferInsert;
export type MemberRow = typeof members.$inferSelect;

export type GroupSettingsRow = typeof groupSettings.$inferSelect;
export type WarningRow = typeof warnings.$inferSelect;
export type MemberSilenceRow = typeof memberSilences.$inferSelect;
