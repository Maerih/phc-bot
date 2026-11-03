/**
 * Schema changes made after the baseline in drizzle/schema.sql.
 *
 * Kept in code rather than as loose .sql files so every deployment carries
 * them, including shared hosting where only dist/ is uploaded. Each runs once,
 * in order, recorded in `schema_migrations`; each is also written to be safe to
 * re-run, so a database that was patched by hand is not a problem.
 */
export interface Migration {
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    name: '0001_moderation',
    sql: `
      ALTER TABLE public.group_settings
        ADD COLUMN IF NOT EXISTS antipromo public.moderation_action DEFAULT 'OFF' NOT NULL,
        ADD COLUMN IF NOT EXISTS antispam public.moderation_action DEFAULT 'OFF' NOT NULL,
        ADD COLUMN IF NOT EXISTS link_scope text DEFAULT 'INVITES' NOT NULL
          CHECK (link_scope IN ('INVITES', 'ALL')),
        ADD COLUMN IF NOT EXISTS allowed_domains text[] DEFAULT '{}'::text[] NOT NULL,
        ADD COLUMN IF NOT EXISTS banned_words text[] DEFAULT '{}'::text[] NOT NULL,
        ADD COLUMN IF NOT EXISTS ai_review boolean DEFAULT false NOT NULL;

      CREATE TABLE IF NOT EXISTS public.member_silences (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        group_jid text NOT NULL,
        member_jid text NOT NULL,
        until timestamp with time zone NOT NULL,
        issued_by text NOT NULL,
        created_at timestamp with time zone DEFAULT now() NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS member_silences_group_member_idx
        ON public.member_silences (group_jid, member_jid);
    `,
  },
  {
    name: '0002_site_tracker',
    sql: `
      CREATE TABLE IF NOT EXISTS public.tracked_items (
        url_hash text PRIMARY KEY,
        site_slug text NOT NULL,
        listing_url text NOT NULL,
        title text NOT NULL,
        relevant boolean NOT NULL DEFAULT false,
        seeded boolean NOT NULL DEFAULT false,
        card jsonb,
        skipped boolean NOT NULL DEFAULT false,
        first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
        announced_at timestamp with time zone
      );
      CREATE INDEX IF NOT EXISTS tracked_items_queue_idx
        ON public.tracked_items (relevant, announced_at, first_seen_at DESC);
      CREATE INDEX IF NOT EXISTS tracked_items_site_idx ON public.tracked_items (site_slug);

      CREATE TABLE IF NOT EXISTS public.alert_subscriptions (
        chat_jid text PRIMARY KEY,
        created_by text NOT NULL,
        created_at timestamp with time zone DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.tracker_state (
        key text PRIMARY KEY,
        value text NOT NULL,
        updated_at timestamp with time zone DEFAULT now() NOT NULL
      );
    `,
  },
];
