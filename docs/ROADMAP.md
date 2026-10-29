# Roadmap

**Release 1.0 "Neo" is complete and verified.** Everything below it is specified, not built. The database schema already carries the columns these phases need, so none of them requires migrating existing data.

---

## Release 1.0 "Neo" ✅ complete

- [x] Legacy repository analysed and documented ([LEGACY-WOLFBOT-ANALYSIS.md](LEGACY-WOLFBOT-ANALYSIS.md))
- [x] Modular command architecture (one file per command, registry, router)
- [x] `.help`, `.menu`, `.start`, `.about`, `.ping`, `.sources`
- [x] `.job`, `.jobs` with stacking location/type/recency/remote/experience filters
- [x] Generalised `Opportunity` model, 14 types, normalisation + classification
- [x] PostgreSQL schema, Drizzle ORM, repositories
- [x] Source connector architecture with isolation, rate limits and attribution
- [x] Search pipeline: parse → fan-out → filter → dedupe → rank
- [x] WhatsApp connectivity with own session, QR and pairing-code flows
- [x] Rate limiting, admin authorisation, structured logging, health endpoints
- [x] Multi-location queries (`.job public health nairobi, kisumu`)
- [x] Six source connectors (Greenhouse employer boards, Remotive, Jobicy, RemoteOK, Arbeitnow; ReliefWeb pending appname)
- [x] AI provider abstraction — Gemini (default, free tier) and Anthropic
- [x] `.ask` assistant with guardrails and a per-member budget
- [x] Web-search backends (Tavily, self-hosted SearXNG, provider grounding)
- [x] Live web fallback when sources find nothing — verified returning real scholarships and fellowships
- [x] Group management and moderation (14 commands)
- [x] 133 unit tests, clean typecheck and build

---

## Phase 2 — Opportunity engine

**Goal:** opportunities accumulate continuously instead of only when someone searches.

- [ ] Redis + BullMQ; move source fetching, normalisation and persistence onto workers
- [ ] Scheduled source synchronisation per connector interval
- [ ] Database-first search (serve from the store, refresh in the background)
- [ ] Scheduled `expirePastDeadlines` sweep (the repository function already exists)
- [ ] Broken-link checking and `riskScore` population
- [ ] More connectors, prioritising first-party public-health employers: WHO, UNICEF, UNFPA, Africa CDC, national ministries, university research offices, scholarship platforms
- [ ] `.deadlines`, `.digest`

**Highest-value item:** ReliefWeb needs only a free appname and would transform result quality. See the README.

---

## Phase 3 — AI ✅ mostly delivered in Neo

- [x] `src/ai/provider.ts` interface, `router.ts`, `gemini/`, `anthropic/`
- [x] Structured extraction from web-search results
- [x] Guardrails, budget guard, retries on transient failures
- [ ] Classification and categorisation refinement on top of the rule-based floor
- [ ] WhatsApp-length summarisation of long descriptions
- [ ] Natural-language intent detection ("I need a public health internship in Kenya") routed through an intent layer, not sent blindly to a model
- [ ] AI-assisted verification — flagging for review, never asserting authenticity
- [ ] `ai_requests` / `ai_responses` tables for cost and quality tracking

Constraints: rule-based classification stays the fallback; AI never marks something verified; a missing or failing provider must not degrade search.

---

## Phase 4 — Community intelligence

- [ ] `.profile` — guided profile capture (columns exist on `members`)
- [ ] `.subscribe` / `.unsubscribe` (the `subscriptions` table exists)
- [ ] `.recommend` — personalised matching (the ranker's `profile` component is already wired)
- [ ] `.save` / `.unsave` / `.saved` (the `saved_opportunities` table exists)
- [ ] Notification delivery honouring `notifyMode` (immediate/daily/weekly/off)
- [ ] `.briefing`, daily and weekly digests, deadline alerts

---

## Phase 5 — Admin platform

- [ ] React dashboard (the search service is already transport-agnostic)
- [ ] Authenticated admin API, separate from the public probes
- [ ] Review queue: `.pending`, `.approve`, `.reject`, `.publish`, `.expire`
- [ ] Source management and health
- [ ] Member and subscription administration
- [ ] Analytics from `command_log`: popular commands, searches, categories, locations
- [ ] `.broadcast` with confirmation and audit trail

---

## Phase 6 — Multi-AI

- [ ] `openai/provider.ts`
- [ ] Provider routing by task and cost
- [ ] Per-task model configuration
- [ ] Fallback chains on provider failure

`AI_PROVIDER` already accepts `openai`, so this is additive.
