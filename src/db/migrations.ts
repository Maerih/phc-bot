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
  {
    name: '0003_tracker_quality',
    sql: `
      ALTER TABLE public.tracked_items
        ADD COLUMN IF NOT EXISTS posted_on date,
        ADD COLUMN IF NOT EXISTS deadline date,
        ADD COLUMN IF NOT EXISTS emails text[] DEFAULT '{}'::text[] NOT NULL,
        ADD COLUMN IF NOT EXISTS duplicate_of text,
        ADD COLUMN IF NOT EXISTS skip_reason text,
        ADD COLUMN IF NOT EXISTS checked_at timestamp with time zone,
        ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone;

      -- Which chat received which opportunity, so nothing reaches a chat twice.
      CREATE TABLE IF NOT EXISTS public.publications (
        url_hash text NOT NULL,
        chat_jid text NOT NULL,
        channel text NOT NULL,
        published_at timestamp with time zone DEFAULT now() NOT NULL,
        PRIMARY KEY (url_hash, chat_jid)
      );
      CREATE INDEX IF NOT EXISTS publications_chat_idx ON public.publications (chat_jid, published_at DESC);

      -- Everything already sent counts as sent to the chats subscribed now.
      INSERT INTO public.publications (url_hash, chat_jid, channel, published_at)
        SELECT t.url_hash, s.chat_jid, 'before-log', t.announced_at
        FROM public.tracked_items t CROSS JOIN public.alert_subscriptions s
        WHERE t.announced_at IS NOT NULL
        ON CONFLICT DO NOTHING;

      -- Everything still waiting is checked again under the new rules.
      UPDATE public.tracked_items SET checked_at = NULL
        WHERE announced_at IS NULL AND relevant AND NOT skipped;
    `,
  },
  {
    name: '0004_career_assistant',
    sql: `
      -- A member's professional profile, kept so CVs and applications do
      -- not need the same details every time. Stored only after consent.
      CREATE TABLE IF NOT EXISTS public.member_profiles (
        member_id uuid PRIMARY KEY REFERENCES public.members(id) ON DELETE CASCADE,
        profile jsonb DEFAULT '{}'::jsonb NOT NULL,
        consent_at timestamp with time zone,
        created_at timestamp with time zone DEFAULT now() NOT NULL,
        updated_at timestamp with time zone DEFAULT now() NOT NULL,
        last_active_at timestamp with time zone DEFAULT now() NOT NULL
      );

      -- CVs, cover letters and documents members send. Kept in the database
      -- so they are covered by backups and never served from a public path.
      CREATE TABLE IF NOT EXISTS public.member_documents (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        member_id uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
        kind text NOT NULL,
        title text NOT NULL,
        file_name text NOT NULL,
        mime text NOT NULL,
        bytes bytea NOT NULL,
        meta jsonb DEFAULT '{}'::jsonb NOT NULL,
        created_at timestamp with time zone DEFAULT now() NOT NULL
      );
      CREATE INDEX IF NOT EXISTS member_documents_member_idx ON public.member_documents (member_id, created_at DESC);

      -- Applications prepared for a member, one per opportunity.
      CREATE TABLE IF NOT EXISTS public.applications (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        member_id uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
        number integer NOT NULL,
        opportunity_key text NOT NULL,
        opportunity jsonb NOT NULL,
        channel text DEFAULT 'unknown' NOT NULL,
        channel_detail jsonb DEFAULT '{}'::jsonb NOT NULL,
        suitability jsonb DEFAULT '{}'::jsonb NOT NULL,
        email_subject text,
        email_body text,
        cover_letter text,
        cv_document_id uuid REFERENCES public.member_documents(id) ON DELETE SET NULL,
        letter_document_id uuid REFERENCES public.member_documents(id) ON DELETE SET NULL,
        status text DEFAULT 'preparing' NOT NULL,
        status_note text,
        reference text,
        submitted_at timestamp with time zone,
        created_at timestamp with time zone DEFAULT now() NOT NULL,
        updated_at timestamp with time zone DEFAULT now() NOT NULL,
        UNIQUE (member_id, opportunity_key),
        UNIQUE (member_id, number)
      );

      -- The assistant's short memory of a private conversation.
      CREATE TABLE IF NOT EXISTS public.assistant_threads (
        member_id uuid PRIMARY KEY REFERENCES public.members(id) ON DELETE CASCADE,
        messages jsonb DEFAULT '[]'::jsonb NOT NULL,
        pending jsonb,
        updated_at timestamp with time zone DEFAULT now() NOT NULL
      );

      -- Switches the owner sets from WhatsApp (status viewing and the like).
      CREATE TABLE IF NOT EXISTS public.bot_settings (
        key text PRIMARY KEY,
        value text NOT NULL,
        updated_at timestamp with time zone DEFAULT now() NOT NULL
      );
    `,
  },
];
