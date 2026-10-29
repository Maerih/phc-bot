-- Group administration and moderation.
--
-- Applied manually rather than through `drizzle-kit push`: PostgreSQL 18 gives
-- NOT NULL constraints real names, which drizzle-kit 0.30 does not recognise,
-- so its diff tries to DROP them and fails with 42P16 on any constraint
-- backing a primary key. See docs/ARCHITECTURE.md.
--
--   psql "$DATABASE_URL" -f drizzle/0001_group_moderation.sql

DO $$ BEGIN
  CREATE TYPE "moderation_action" AS ENUM ('OFF', 'WARN', 'DELETE', 'REMOVE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "group_settings" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "group_jid"       text NOT NULL,
  "antilink"        "moderation_action" DEFAULT 'OFF' NOT NULL,
  "antibadword"     "moderation_action" DEFAULT 'OFF' NOT NULL,
  "welcome_enabled" boolean DEFAULT false NOT NULL,
  "welcome_message" text,
  "goodbye_enabled" boolean DEFAULT false NOT NULL,
  "goodbye_message" text,
  "warn_limit"      integer DEFAULT 3 NOT NULL,
  "created_at"      timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"      timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "group_settings_jid_idx"
  ON "group_settings" ("group_jid");

CREATE TABLE IF NOT EXISTS "warnings" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "group_jid"  text NOT NULL,
  "target_jid" text NOT NULL,
  "issued_by"  text NOT NULL,
  "reason"     text,
  "active"     boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "warnings_group_target_idx"
  ON "warnings" ("group_jid", "target_jid");

CREATE INDEX IF NOT EXISTS "warnings_created_at_idx"
  ON "warnings" ("created_at");
