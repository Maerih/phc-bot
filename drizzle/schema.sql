--
-- Complete PostgreSQL schema for the PHC platform.
--
-- Exported with pg_dump --schema-only from the database the application runs
-- against, so it is exactly the schema the code expects: 8 tables, 9 enums.
--
-- Applied automatically by ./ctl.sh on first start, against an empty database.
-- To apply by hand:   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle/schema.sql
--
-- Two pg_dump 18 additions were removed so it applies on any recent version:
-- the \restrict / \unrestrict psql meta-commands, and
-- SET transaction_timeout (PostgreSQL 17+). Neither matters for a schema with
-- no data in it.
--
--
-- PostgreSQL database dump
--


-- Dumped from database version 18.6 (Debian 18.6-3)
-- Dumped by pg_dump version 18.6 (Debian 18.6-3)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: category; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.category AS ENUM (
    'PUBLIC_HEALTH',
    'EPIDEMIOLOGY',
    'GLOBAL_HEALTH',
    'HEALTH_INFORMATICS',
    'DIGITAL_HEALTH',
    'HEALTH_POLICY',
    'MONITORING_EVALUATION',
    'BIOSTATISTICS',
    'DATA_SCIENCE',
    'ENVIRONMENTAL_HEALTH',
    'MENTAL_HEALTH',
    'NUTRITION',
    'MATERNAL_CHILD_HEALTH',
    'INFECTIOUS_DISEASE',
    'HEALTH_ECONOMICS',
    'RESEARCH',
    'CYBERSECURITY',
    'SOFTWARE',
    'AI',
    'OTHER'
);


--
-- Name: education_level; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.education_level AS ENUM (
    'UNKNOWN',
    'SECONDARY',
    'CERTIFICATE',
    'DIPLOMA',
    'BACHELORS',
    'MASTERS',
    'DOCTORATE'
);


--
-- Name: experience_level; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.experience_level AS ENUM (
    'UNKNOWN',
    'ENTRY',
    'GRADUATE',
    'MID',
    'SENIOR',
    'EXECUTIVE'
);


--
-- Name: moderation_action; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.moderation_action AS ENUM (
    'OFF',
    'WARN',
    'DELETE',
    'REMOVE'
);


--
-- Name: notify_mode; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.notify_mode AS ENUM (
    'IMMEDIATE',
    'DAILY',
    'WEEKLY',
    'OFF'
);


--
-- Name: opportunity_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.opportunity_status AS ENUM (
    'DISCOVERED',
    'PENDING_REVIEW',
    'VERIFIED',
    'PUBLISHED',
    'EXPIRED',
    'REJECTED'
);


--
-- Name: opportunity_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.opportunity_type AS ENUM (
    'JOB',
    'INTERNSHIP',
    'SCHOLARSHIP',
    'FELLOWSHIP',
    'RESEARCH',
    'GRANT',
    'CONFERENCE',
    'TRAINING',
    'HACKATHON',
    'VOLUNTEER',
    'PROJECT',
    'MENTORSHIP',
    'EVENT',
    'PROGRAM'
);


--
-- Name: source_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.source_kind AS ENUM (
    'API',
    'RSS',
    'SCRAPE',
    'MANUAL'
);


--
-- Name: verification_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.verification_status AS ENUM (
    'UNVERIFIED',
    'SOURCE_VERIFIED',
    'AI_ASSISTED',
    'ADMIN_VERIFIED',
    'EXPIRED',
    'FLAGGED'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: command_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.command_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    member_id uuid,
    command text NOT NULL,
    query_terms text[] DEFAULT '{}'::text[] NOT NULL,
    result_count integer,
    duration_ms integer,
    ok boolean DEFAULT true NOT NULL,
    error_kind text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: group_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_jid text NOT NULL,
    antilink public.moderation_action DEFAULT 'OFF'::public.moderation_action NOT NULL,
    antibadword public.moderation_action DEFAULT 'OFF'::public.moderation_action NOT NULL,
    welcome_enabled boolean DEFAULT false NOT NULL,
    welcome_message text,
    goodbye_enabled boolean DEFAULT false NOT NULL,
    goodbye_message text,
    warn_limit integer DEFAULT 3 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    wa_jid text NOT NULL,
    display_name text,
    country text,
    field text,
    education_level public.education_level DEFAULT 'UNKNOWN'::public.education_level NOT NULL,
    experience_level public.experience_level DEFAULT 'UNKNOWN'::public.experience_level NOT NULL,
    interests public.category[] DEFAULT '{}'::public.category[] NOT NULL,
    skills text[] DEFAULT '{}'::text[] NOT NULL,
    preferred_locations text[] DEFAULT '{}'::text[] NOT NULL,
    remote_preference boolean,
    opportunity_types public.opportunity_type[] DEFAULT '{}'::public.opportunity_type[] NOT NULL,
    notify_mode public.notify_mode DEFAULT 'DAILY'::public.notify_mode NOT NULL,
    is_admin boolean DEFAULT false NOT NULL,
    is_blocked boolean DEFAULT false NOT NULL,
    rate_tokens integer DEFAULT 20 NOT NULL,
    rate_updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: opportunities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.opportunities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    organization text,
    description text,
    type public.opportunity_type NOT NULL,
    categories public.category[] DEFAULT '{}'::public.category[] NOT NULL,
    location text,
    country text,
    remote boolean,
    eligibility text,
    education_level public.education_level DEFAULT 'UNKNOWN'::public.education_level NOT NULL,
    experience_level public.experience_level DEFAULT 'UNKNOWN'::public.experience_level NOT NULL,
    deadline timestamp with time zone,
    application_url text,
    source_id uuid,
    source_slug text NOT NULL,
    source_name text NOT NULL,
    source_url text,
    date_posted timestamp with time zone,
    status public.opportunity_status DEFAULT 'DISCOVERED'::public.opportunity_status NOT NULL,
    verification_status public.verification_status DEFAULT 'UNVERIFIED'::public.verification_status NOT NULL,
    verified_at timestamp with time zone,
    verified_by text,
    review_note text,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    skills text[] DEFAULT '{}'::text[] NOT NULL,
    compensation text,
    fingerprint text NOT NULL,
    external_key text NOT NULL,
    duplicate_of_id uuid,
    risk_score integer DEFAULT 0 NOT NULL,
    risk_reasons text[] DEFAULT '{}'::text[] NOT NULL,
    raw_payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: saved_opportunities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.saved_opportunities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    member_id uuid NOT NULL,
    opportunity_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    kind public.source_kind DEFAULT 'API'::public.source_kind NOT NULL,
    homepage_url text,
    enabled boolean DEFAULT true NOT NULL,
    attribution_required boolean DEFAULT false NOT NULL,
    attribution_text text,
    min_fetch_interval_minutes integer DEFAULT 360 NOT NULL,
    trust_score integer DEFAULT 50 NOT NULL,
    last_fetched_at timestamp with time zone,
    last_succeeded_at timestamp with time zone,
    last_error text,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    member_id uuid NOT NULL,
    topic text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: warnings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.warnings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_jid text NOT NULL,
    target_jid text NOT NULL,
    issued_by text NOT NULL,
    reason text,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: command_log command_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.command_log
    ADD CONSTRAINT command_log_pkey PRIMARY KEY (id);


--
-- Name: group_settings group_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_settings
    ADD CONSTRAINT group_settings_pkey PRIMARY KEY (id);


--
-- Name: members members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.members
    ADD CONSTRAINT members_pkey PRIMARY KEY (id);


--
-- Name: opportunities opportunities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.opportunities
    ADD CONSTRAINT opportunities_pkey PRIMARY KEY (id);


--
-- Name: saved_opportunities saved_opportunities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_opportunities
    ADD CONSTRAINT saved_opportunities_pkey PRIMARY KEY (id);


--
-- Name: sources sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sources
    ADD CONSTRAINT sources_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


--
-- Name: warnings warnings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warnings
    ADD CONSTRAINT warnings_pkey PRIMARY KEY (id);


--
-- Name: command_log_command_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX command_log_command_idx ON public.command_log USING btree (command);


--
-- Name: command_log_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX command_log_created_at_idx ON public.command_log USING btree (created_at);


--
-- Name: group_settings_jid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX group_settings_jid_idx ON public.group_settings USING btree (group_jid);


--
-- Name: members_wa_jid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX members_wa_jid_idx ON public.members USING btree (wa_jid);


--
-- Name: opportunities_country_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX opportunities_country_idx ON public.opportunities USING btree (country);


--
-- Name: opportunities_date_posted_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX opportunities_date_posted_idx ON public.opportunities USING btree (date_posted);


--
-- Name: opportunities_deadline_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX opportunities_deadline_idx ON public.opportunities USING btree (deadline);


--
-- Name: opportunities_external_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX opportunities_external_key_idx ON public.opportunities USING btree (external_key);


--
-- Name: opportunities_fingerprint_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX opportunities_fingerprint_idx ON public.opportunities USING btree (fingerprint);


--
-- Name: opportunities_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX opportunities_status_idx ON public.opportunities USING btree (status);


--
-- Name: opportunities_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX opportunities_type_idx ON public.opportunities USING btree (type);


--
-- Name: saved_member_opportunity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX saved_member_opportunity_idx ON public.saved_opportunities USING btree (member_id, opportunity_id);


--
-- Name: sources_slug_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sources_slug_idx ON public.sources USING btree (slug);


--
-- Name: subscriptions_member_topic_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX subscriptions_member_topic_idx ON public.subscriptions USING btree (member_id, topic);


--
-- Name: subscriptions_topic_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subscriptions_topic_idx ON public.subscriptions USING btree (topic);


--
-- Name: warnings_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX warnings_created_at_idx ON public.warnings USING btree (created_at);


--
-- Name: warnings_group_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX warnings_group_target_idx ON public.warnings USING btree (group_jid, target_jid);


--
-- Name: command_log command_log_member_id_members_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.command_log
    ADD CONSTRAINT command_log_member_id_members_id_fk FOREIGN KEY (member_id) REFERENCES public.members(id) ON DELETE SET NULL;


--
-- Name: opportunities opportunities_source_id_sources_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.opportunities
    ADD CONSTRAINT opportunities_source_id_sources_id_fk FOREIGN KEY (source_id) REFERENCES public.sources(id) ON DELETE SET NULL;


--
-- Name: saved_opportunities saved_opportunities_member_id_members_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_opportunities
    ADD CONSTRAINT saved_opportunities_member_id_members_id_fk FOREIGN KEY (member_id) REFERENCES public.members(id) ON DELETE CASCADE;


--
-- Name: saved_opportunities saved_opportunities_opportunity_id_opportunities_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_opportunities
    ADD CONSTRAINT saved_opportunities_opportunity_id_opportunities_id_fk FOREIGN KEY (opportunity_id) REFERENCES public.opportunities(id) ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_member_id_members_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_member_id_members_id_fk FOREIGN KEY (member_id) REFERENCES public.members(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


