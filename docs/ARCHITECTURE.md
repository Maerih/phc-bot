# Architecture

Design decisions and the reasoning behind them. Where a decision came from an observed failure, the failure is recorded — that is usually the most useful part.

---

## Principles

| Principle | How it is enforced |
|---|---|
| **Provider independence** | No business logic imports a vendor SDK. AI sits behind an interface selected by `AI_PROVIDER`. |
| **Source independence** | No code names a specific job board outside `src/sources/<kind>/`. Adding a source touches two files. |
| **Transport independence** | The search service takes a `SearchQuery` and returns scored results. It has no idea WhatsApp exists. |
| **Unknown stays unknown** | A field the source did not state is `null` and renders as "not stated". Never inferred, never omitted-and-implied. |
| **Graceful degradation** | A failing source, missing AI key or thrown handler degrades one thing, and the member is told. |
| **Honest verification** | Nothing is presented as verified because it appeared in a feed. `AI_ASSISTED` is not a claim of authenticity. |
| **Minimal personal data** | A member row is a WhatsApp JID plus what they chose to tell us. |

---

## Request lifecycle

```text
inbound message
  │
  ├─ parseInvocation       prefix check; ordinary conversation ignored entirely
  ├─ touchMember           upsert by JID, refresh lastSeenAt, re-sync admin flag
  ├─ isBlocked?            drop
  ├─ adminOnly?            check ADMIN_NUMBERS → non-admins get "unknown command"
  ├─ rate limit            persisted token bucket, unless exempt
  │
  └─ handler
       ├─ parseQuery       filters extracted, consumed, removed from free text
       ├─ react 🔎         immediate feedback before the slow part
       ├─ fanOut           connectors in parallel, each isolated + timed out
       ├─ applyFilters     hard requirements (type, country, remote, recency, deadline)
       ├─ dedupe           fingerprint pass, then same-org near-duplicate pass
       ├─ rank             weighted score + relevance quality gate
       ├─ setSession       remembered for .next / .prev / .details
       ├─ reply            rendered page + attribution + degradation warning
       └─ logCommand       command name and normalised terms only
```

Persistence is deliberately **not** on this path. Discovered opportunities are upserted in the background and tracked, so shutdown can wait for the writes instead of aborting them.

---

## Why these decisions

### One table for 14 opportunity types

A job, a scholarship and a conference differ by `type`, not by schema. Type-specific nuance lives in nullable columns. Adding `MENTORSHIP` or `PROGRAM` needs no migration, and every downstream consumer — search, ranking, digests, dashboard — reads one shape.

### Classification corpora are scoped per classifier

Originally every classifier read the full job description. The results were nonsense:

- a consultant vacancy saying "you will present at international conferences" was typed `CONFERENCE`
- one saying "training will be provided" was typed `TRAINING`
- a category-management role with "mental health support" in its benefits list was filed under `MENTAL_HEALTH`

Now each classifier sees only the text where its signal actually lives:

| Classifier | Reads | Why |
|---|---|---|
| Type | title + tags | These name what a posting *is*. Body prose merely mentions other kinds in passing. |
| Categories | title + tags (authoritative), body (needs **2+** matches) | Subject matter is genuinely spread through the body, but one passing mention is noise. |
| Experience | title + tags | "Senior stakeholders" in a body is not a seniority signal. |
| Education | title + body | Qualifications really do live in the requirements section. |
| Remote | title + location + body | Remote arrangements are often stated only in prose. |

`MID` detection was also narrowed: "Officer" and "Associate" span every seniority in NGO and government titles, so "Health Officer" was being reported as mid-level on no evidence.

### Relevance is phrase-aware, with AND semantics

The first implementation scored query tokens independently with substring matching. Searching `public health` across 666 fetched records returned 175 "matches" — led by *Graduate Analyst Programme – Public Sector Consulting* ("public" in the title) and *Softwaretester Healthcare SaaS* ("health" inside "healthcare").

Three changes fixed it:

1. **Whole-word matching**, so `health` does not match `Healthcare`.
2. **Phrase-first scoring** for multi-term queries — `public health` is a field, not two independent words:

   | Match | Score |
   |---|---|
   | phrase in title | 1.00 |
   | all terms in title | 0.90 |
   | phrase in tags | 0.75 |
   | phrase in body | 0.60 |
   | all terms in title ∪ tags | 0.55 |
   | scattered partial | coverage × 0.2 (under the gate) |

3. **A quality gate** (`minRelevance`, default 0.25) applied only when the member supplied terms. Several upstreams ignore or loosely honour their own search parameter, so without a gate they flood the list.

Result: the same query now returns **1** genuinely relevant match instead of 175 misleading ones. Fewer, truer results is the correct trade for a community where a bad lead costs someone a real application.

### De-duplication is two-pass, and refuses to guess

**Pass 1 — exact fingerprint** over `canonical(title) + canonical(organization) + type`. URLs, ids and descriptions differ between aggregators carrying the same post, so including them would defeat the only job this hash has.

When the organisation is unknown, the **source slug is mixed into the fingerprint**. Without that, two unrelated employers who both failed to state a name collapse into one record purely because they share a job title, and a member never sees the second opportunity. Within one source, the same title with no organisation really is the same posting re-fetched — so dedupe still works exactly where it is safe.

**Pass 2 — near-duplicates** within the same organisation and type. Jaccard alone was not enough: *Health Data Analyst* vs *Health Data Analyst (Remote)* scores 0.75, below any threshold loose enough to be safe. A subset rule handles that case — one title being the other plus a qualifier such as `(Remote)`, `(m/f/d)` or a duty station — while still requiring 2+ shared tokens so short titles cannot merge on one word.

Where the organisation is unknown, pass 2 does not merge at all. Two employers can advertise the same job title, and wrongly hiding one costs a member a real opportunity.

**Winner selection:** higher source trust first, then completeness (a record with a real deadline and an application link beats a bare title).

### Ranking weights are data, not control flow

```ts
relevance 0.40 · recency 0.20 · verification 0.20 · deadline 0.10 · profile 0.10
```

One object, tunable without touching scoring logic, and later learnable from engagement analytics. Deadline urgency peaks at 3–21 days out: far enough away to actually apply, close enough to matter.

### Connectors are isolated, rate-limited and self-describing

Each connector declares its own `minFetchIntervalMinutes`, `trustScore` and attribution obligation in `ConnectorMeta`. The registry enforces them:

- **Isolation** — `Promise.all` over per-connector wrappers that convert failures into results. One source failing never fails the request, and the reply says the list may be incomplete.
- **Timeouts** — a 12-second `AbortController` per call.
- **Rate limiting via cache TTL** — the result cache's TTL *is* the connector's minimum interval, so a polite source is polled politely without any caller remembering to.
- **Attribution as data** — Remotive grants API access on condition that listings credit them and link back. That obligation lives on the connector and the row, not in a comment, and the renderer appends it.
- **`unavailableReason`** — a connector needing a key it does not have stays registered and explains itself, instead of being silently absent.

### Verification is a state machine, not a boolean

```text
DISCOVERED ──> PENDING_REVIEW ──> VERIFIED ──> PUBLISHED ──> EXPIRED
                     └──────────────> REJECTED
```

Everything enters as `DISCOVERED`/`UNVERIFIED`. Promotion is a separate reviewed step, never a side effect of ingestion. The upsert path deliberately does **not** write `status`, `verificationStatus`, `verifiedAt` or `reviewNote`: those record human decisions, and an automated sync overwriting them would silently un-approve or re-approve content behind an administrator's back.

`riskScore` and `riskReasons` exist for moderation, but the design is `AI recommendation → risk score → admin review`. No automated banning.

### Logs go to stderr

Found the hard way: pino defaulted to stdout and corrupted `npm run search -- --json` output. Logs on stderr, data on stdout.

### Startup order is deliberate

Config → database → HTTP → WhatsApp. Connecting to WhatsApp before the database is reachable would leave members talking to a bot that cannot answer. Shutdown reverses it and flushes pending writes first.

---

### Web search is separate from the model

The fallback first used the model's own built-in search. Both Anthropic's
server-side tool and Google's Search grounding turned out to be **paid**
features: on a free Gemini key, grounded search returns `429 RESOURCE_EXHAUSTED`
on every call while plain generation works perfectly.

Separating them fixed it. Any backend supplies the pages; any model reads them. It also makes the model's job narrower and more auditable — it no longer searches or recalls, it extracts from numbered results it was handed, and every URL it returns can be checked against that list.

### Fallback results are filtered leniently

Applying the strict source filters to fallback results discarded **everything** the fallback found — two genuine Kenyan scholarships, thrown away for lacking an ISO country code and a posting date, neither of which a web page has.

`treatUnknownAsMatch` relaxes *unknowns only*. A stated country that doesn't match is still rejected, an expired deadline is still rejected, and an explicit remote requirement is still enforced. Five regression tests pin that line, because the obvious wrong fix — relaxing the filters generally — would have let contradictory results through.

### A source that times out is worse than a smaller one

Arbeitnow pulled two pages of several megabytes against a 12-second budget and failed on *every* search, contributing nothing while still costing members the wait. One page returns reliably in ~6s. Ambition in a connector is only worth it if it finishes.

## What is deliberately not built yet

| Deferred | Phase | Why |
|---|---|---|
| Redis + BullMQ queues | 2 | Phase 1 is single-process. The cache already has the interface a Redis implementation would satisfy; command handlers react immediately and reply when ready, so the no-blocking principle holds without the dependency. |
| Scheduled sync, digests, deadline alerts | 2/4 | Need the queue layer. |
| AI extraction, summarisation, NL intent | 3 | The boundary and config exist; the providers do not. Rule-based classification is the permanent fallback, not a placeholder. |
| Profiles, subscriptions, notifications | 4 | Schema and columns exist (`subscriptions`, `members.interests`, `notifyMode`); commands do not. |
| React admin dashboard | 5 | The search service is already transport-agnostic, so it needs no backend rework. |
| OpenAI provider, routing, fallback | 6 | `AI_PROVIDER` already accepts `openai`. |

The schema anticipates these phases so they do not require migrations of existing data.
