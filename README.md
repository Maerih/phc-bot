# Public Health Colosseum — Platform

**An AI-ready WhatsApp community assistant for discovering and distributing public-health opportunities.**

Release **1.0 “Neo”** · Powered by **SCIAT SOLUTIONS**.

The Public Health Colosseum is a global community where students, early professionals, researchers and practitioners learn, connect and unlock opportunities in public health. This platform is the infrastructure behind it: it finds opportunities, normalises them into one trustworthy shape, removes duplicates, hides anything expired, ranks what is left, and delivers it over WhatsApp.

It searches **jobs, internships, scholarships, fellowships, research posts, grants, events, conferences and training**.

> **Release 1.0 — "Neo".** Complete and verified. Later work is specified in [docs/ROADMAP.md](docs/ROADMAP.md) but not built. This README documents only what actually works today; where something is unverified, it says so.

**Install on a server — one command:**

```bash
curl -fsSL https://raw.githubusercontent.com/Maerih/phc-bot/main/install.sh | bash
```

It downloads the bot into `~/phc-bot` and runs `./ctl.sh start`, which checks the machine, gets Docker (a private copy if none is installed, no sudo), asks a few setup questions, builds, starts the database and the bot, and shows the WhatsApp QR code in the terminal. **Update later with `./ctl.sh update`**; it pulls the latest version from GitHub and keeps the session, settings and data. `./ctl.sh doctor` runs every check without changing anything.

**Deploying:**
- [docs/DEPLOY-VPS.md](docs/DEPLOY-VPS.md) — **recommended.** The install above, step by step.
- [docs/DEPLOY-CPANEL.md](docs/DEPLOY-CPANEL.md) — shared hosting, with its limitations stated plainly.

**Full manual:** [docs/phc-platform-manual.pdf](docs/phc-platform-manual.pdf) — 43 pages covering installation, configuration and every integration.

---

## Contents

- [What works today](#what-works-today)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Installation](#installation)
- [Environment setup](#environment-setup)
- [Database setup](#database-setup)
- [Running locally](#running-locally)
- [WhatsApp setup](#whatsapp-setup)
- [AI provider setup](#ai-provider-setup)
- [Commands](#commands)
- [Opportunity sources](#opportunity-sources)
- [Development](#development)
- [Security and privacy](#security-and-privacy)
- [Troubleshooting](#troubleshooting)

---

## What works today

**Two ways in**
- **WhatsApp** — 34 commands for members already in the community
- **Web** — a search page at `/` for anyone, no app or account needed, backed by the same engine

**Opportunity search**
- Keyword search (`.job epidemiology`), with phrase-aware relevance scoring
- Filters for location, country, region, opportunity type, recency, remote and experience level — and they stack: `.jobs nairobi internship today`
- Nine type-shortcut commands (`.scholarships`, `.internships`, `.fellowships`, …)
- Pagination (`.next`, `.prev`) and full detail view (`.details 2`)

**Opportunity intelligence**
- A single generalised `Opportunity` model covering 14 opportunity types
- Normalisation of every source into that one shape, with HTML stripped and URLs validated
- Rule-based classification: type, subject category (multi-label), education level, experience level, country, remote
- Two-pass de-duplication (exact content fingerprint, then same-organisation near-duplicate), keeping the most trusted and most complete copy
- Weighted ranking: relevance 40%, recency 20%, verification 20%, deadline 10%, member profile 10%
- A verification state machine; nothing is ever presented as verified because it merely appeared in a feed

**Platform**
- Modular command registry — one file per command, collisions caught at startup
- Per-member persisted rate limiting (token bucket)
- Admin authorisation checked against `ADMIN_NUMBERS`, never inferred from a command name
- PostgreSQL schema with 8 tables and 9 enums
- Graceful degradation: one failing source never fails a search, and the member is told the list may be incomplete
- Structured logging with JID redaction
- Anonymous health/status HTTP endpoints
- 133 unit tests

---

## Architecture

```text
   WhatsApp (Baileys, own number)        Web browser (no account needed)
              │                                        │
   ┌──────────▼──────────┐              ┌──────────────▼──────────────┐
   │   Command router    │              │  public/index.html          │
   │  prefix · auth ·    │              │  GET /api/search            │
   │  rate limit ·       │              │  per-IP rate limited        │
   │  session            │              └──────────────┬──────────────┘
   └──────────┬──────────┘                             │
              │                                        │
   ┌──────────▼──────────┐                             │
   │  Command registry   │  one file per command       │
   └──────────┬──────────┘                             │
              │                                        │
              └────────────────┬───────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │   Search service    │  transport-agnostic
                    └──────────┬──────────┘
                               │
   ┌───────────────┬───────────┼───────────┬───────────────┐
   ▼               ▼           ▼           ▼               ▼
 Query          Source      Filter      Dedupe           Rank
 parser         fan-out                 (2-pass)      (weighted)
                   │
      ┌────────────┼────────────┐
      ▼            ▼            ▼
  Remotive     Arbeitnow    ReliefWeb      ← independently enabled,
  (connector)  (connector)  (connector)      isolated, timed out,
      │            │            │             rate-limited, cached
      └────────────┴────────────┘
                   │
         ┌─────────▼─────────┐
         │   Normalisation   │  one canonical Opportunity shape
         │   + classification│  unknown stays unknown
         └─────────┬─────────┘
                   │
         ┌─────────▼─────────┐
         │    PostgreSQL     │  opportunities · members · sources
         │    (Drizzle ORM)  │  subscriptions · saved · command_log
         └───────────────────┘
```

The search service knows nothing about WhatsApp or HTTP. Both surfaces call the same function, so a change to ranking or de-duplication reaches both at once — and the Phase 5 admin dashboard will plug in the same way.

### Web interface

Start the platform and open **`http://localhost:3100`**. No account, no login, no WhatsApp required — which is the point: a student can find an opportunity without joining anything first.

| Route | Purpose |
|---|---|
| `GET /` | Search page (single static file, no build step) |
| `GET /api/search` | Search — `q`, `location`, `type`, `remote`, `page`, `pageSize` |
| `GET /api/sources` | Which sources are active |
| `GET /api/filters` | Opportunity types, for the filter chips |
| `GET /admin/pair` | **Browser pairing page**, for shared hosting with no terminal. Off unless `PAIRING_PAGE=on` *and* `ADMIN_PANEL_TOKEN` is set; returns `404` otherwise. On a server, pair in the terminal instead (`./ctl.sh pair`) |
| `GET /health` | Liveness probe |
| `GET /api/status` | Operational status (no personal data) |

The UI is mobile-first, works in light and dark, renders all text via `textContent` (never `innerHTML`, since titles come from third-party feeds), and opens application links with `rel="noopener noreferrer"`. Responses carry `nosniff`, `DENY` framing, `no-referrer` and a restrictive CSP.

Search is rate limited to **30 requests per 5 minutes per IP** — not arbitrary caution: every search fans out to upstreams whose terms cap how often we may poll them, and an open endpoint without a limiter would burn a shared quota and risk the platform's access for everyone.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design decisions and why each was made.

---

## Requirements

| Requirement | Version | Why |
|---|---|---|
| Node.js | ≥ 20 (tested on 22.22) | Runtime |
| npm | ≥ 9 | Package management |
| PostgreSQL | ≥ 14 (tested on 18.6) | Primary datastore |
| A spare WhatsApp number | — | The bot links its own device |

Not required for Phase 1: Redis (Phase 2 queues), an Anthropic or OpenAI API key (Phase 3 — the platform runs fully without one).

---

## Installation

To *run* the bot on a server, use the one-command install above. This section is for working on the code:

```bash
git clone https://github.com/Maerih/phc-bot.git
cd phc-bot
npm install
```

`npm install` pulls ~240 packages, mostly Baileys' dependency tree. It can take several minutes.

If npm reports that install scripts were skipped, that is fine — the platform runs correctly without them.

---

## Environment setup

```bash
cp .env.example .env
```

Then edit `.env`. Every variable below is read by the code; nothing is listed that the implementation ignores.

### Required

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string, e.g. `postgres://127.0.0.1:55432/phc` |

### Runtime

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `development` | `development` enables pretty logs |
| `PORT` | `3100` | HTTP port for `/health` and `/api/status` |
| `LOG_LEVEL` | `info` | `trace`…`fatal` |
| `TIMEZONE` | `Africa/Nairobi` | Display timezone |

### WhatsApp

| Variable | Default | Description |
|---|---|---|
| `WHATSAPP_PROVIDER` | `baileys` | Only `baileys` is implemented |
| `WHATSAPP_AUTH_DIR` | `./auth` | Where session credentials are stored. **Gitignored — treat as a secret** |
| `WHATSAPP_PAIR_NUMBER` | *(empty)* | Digits only, no `+`. Set it to pair by code; leave blank for a QR code |
| `PAIRING_PAGE` | `off` | `on` shows the QR on the browser pairing page too (shared hosting only; also needs `ADMIN_PANEL_TOKEN`). Off: the QR appears in the terminal only |
| `COMMAND_PREFIX` | `.` | Command prefix |

### Administration

| Variable | Default | Description |
|---|---|---|
| `ADMIN_NUMBERS` | *(empty)* | Comma-separated, digits only, no `+`. Validated at startup |

### Opportunity sources

| Variable | Default | Description |
|---|---|---|
| `SOURCES_ENABLED` | `greenhouse,remotive,arbeitnow` | Comma-separated connector slugs |
| `GREENHOUSE_BOARDS` | *(4 verified orgs)* | Employer board tokens, one per organisation |
| `RELIEFWEB_APPNAME` | *(empty)* | Free registered appname; leave blank to keep ReliefWeb disabled |

#### Adding an employer career board

Find whether an organisation publishes a public Greenhouse board:

```bash
curl -s "https://boards-api.greenhouse.io/v1/boards/<token>/jobs" | head -c 200
```

A `200` with a `jobs` array means it works — add `<token>` to `GREENHOUSE_BOARDS` and restart. The token is usually the organisation's name in lowercase. Four are verified and enabled by default: `oneacrefund`, `resolvetosavelives`, `dimagi`, `givedirectly`. A board that disappears or is renamed is logged and skipped; the other organisations are unaffected.

This is the cheapest way to improve result quality — every health employer you add is authoritative, keyless and ranks above the aggregators.

### AI (Phase 3 — optional)

| Variable | Default | Description |
|---|---|---|
| `AI_PROVIDER` | `gemini` | `gemini`, `anthropic`, `openai` or `none` |
| `GEMINI_API_KEY` | *(empty)* | **Free** key from [Google AI Studio](https://aistudio.google.com/apikey) |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Model id |
| `ANTHROPIC_API_KEY` | *(empty)* | Paid. From the Anthropic Console |
| `ANTHROPIC_MODEL` | `claude-opus-5` | Model id |
| `OPENAI_API_KEY` | *(empty)* | For the Phase 6 OpenAI provider |
| `OPENAI_MODEL` | `gpt-4o-mini` | Model id |

Setting `AI_PROVIDER` without a matching key logs a warning and leaves AI features off. Search and every command keep working.

---

## Database setup

### Option A — local development server, no root required

```bash
./scripts/dev-services.sh start
```

This creates a PostgreSQL cluster under `.devservices/` owned by your user, on port **55432**, plus Redis on **56379** if installed. It never touches a system-wide installation and needs no `sudo`.

Then create the tables:

```bash
npm run db:push
```

Other commands: `./scripts/dev-services.sh stop`, `status`, `destroy`.

### Option B — your own PostgreSQL

Point `DATABASE_URL` at it and run:

```bash
npm run db:push
```

### Migration workflow

`db:push` applies the schema directly and suits development. For production, generate and apply versioned migrations:

```bash
npm run db:generate   # write SQL migrations to ./drizzle
npm run db:migrate    # apply them
```

`npm run db:studio` opens Drizzle Studio to browse the data.

---

## Running locally

```bash
npm run dev      # tsx watch, pretty logs, reloads on change
```

Production:

```bash
npm run build    # tsc -> dist/
npm start        # node dist/index.js
```

Quality gate:

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run (133 tests)
npm run check       # both
```

### Searching without WhatsApp

The fastest way to exercise sources, normalisation, de-duplication and ranking:

```bash
npm run search -- public health
npm run search -- nairobi internship
npm run search -- --json epidemiology        # machine-readable, scores included
npm run search -- --ai "public health nairobi"   # try the AI web fallback
npm run search -- --no-persist remote        # skip database writes
```

It prints the per-source breakdown and the exact WhatsApp message a member would receive. In `--json` mode stdout carries only JSON, so it pipes cleanly.

---

## WhatsApp setup

This platform **owns its own WhatsApp number and its own session**. Auth state is written to `WHATSAPP_AUTH_DIR` on your machine and never leaves it. No third-party pairing website is involved and no session string is pasted into an environment variable.

> Use a number that is not already linked to another bot. Two bots on one number will fight over the session and disconnect each other.

### Pair with a QR code (default)

1. Leave `WHATSAPP_PAIR_NUMBER` blank.
2. Run `npm run dev`.
3. A QR code is printed in the terminal.
4. On the phone: **WhatsApp → Settings → Linked devices → Link a device**, then scan.

### Pair with an 8-character code

1. Set `WHATSAPP_PAIR_NUMBER=2547XXXXXXXX` (digits only, no `+`).
2. Run `npm run dev`.
3. The code is logged after a few seconds.
4. On the phone: **Linked devices → Link with phone number instead**, then enter it.

Confirm it worked:

```bash
curl -s http://127.0.0.1:3100/health
# {"status":"ok","whatsapp":"connected","uptimeSeconds":12}
```

Session credentials persist across restarts.

### Who can use the bot

**Any number, including the bot's own.** Every command is open to every sender; only commands marked `adminOnly` check `ADMIN_NUMBERS`, and group commands check that chat's admin list.

That includes the number the bot is paired to. If you pair it to your own phone, you can drive it from that phone — type `.ping` in any chat and it answers. (Earlier builds dropped `fromMe` messages, so the bot connected fine and then silently ignored its owner. A loop guard tracks sent message IDs so a reply echo is never re-handled as input.)

Members on newer LID-based WhatsApp accounts are identified by the phone-number JID WhatsApp supplies alongside the LID, so admin checks work for them too.

### Automatic recovery from logout

If WhatsApp invalidates the session — unlinked from the phone, or logged out remotely — the platform **clears the dead credentials and starts pairing again by itself**. A fresh QR code (or pairing code) appears in the logs; scan it and it reconnects.

This is safe because a logged-out session is already dead: WhatsApp has invalidated those credentials and nothing can revive them. Keeping them would only make every reconnect fail identically.

Re-pairing is capped at **3 attempts per hour**. Past that it stops and says so, rather than spinning forever generating pairing requests against WhatsApp. A successful connection resets the counter.

To unlink deliberately: stop the process, delete `WHATSAPP_AUTH_DIR`, and pair again.

---

## AI provider setup

Two features need an AI provider: the `.ask` assistant, and the web fallback that runs when the opportunity sources find nothing. Everything else works without one.

### Gemini — the default, and free

Google AI Studio issues a **free API key** with a usable free tier, and Gemini has **Google Search grounding** built in. That combination is why it is the default: live web search at no running cost, which is what makes the opportunity fallback viable without a budget.

1. Get a key: <https://aistudio.google.com/apikey>
2. Put it in `.env`:
   ```ini
   AI_PROVIDER=gemini
   GEMINI_API_KEY=your-key-here
   ```
3. Verify it actually works:
   ```bash
   npm run ai:check
   ```

`ai:check` makes two real calls — a plain completion, then a live web search — and reports exactly what failed if either does. The two things most likely to be wrong, a bad key and an unavailable model name, only surface on a real call, so finding out from a one-second diagnostic beats finding out from a member whose question silently failed.

If your account cannot use the default model, set `GEMINI_MODEL` to one it can.

### Anthropic — paid, higher quality

```ini
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-opus-5
```

> **A consumer Claude Pro or Max subscription does NOT include API access** and does not give you an API key. The API is a separate product billed per token, from <https://console.anthropic.com/>.

Indicative rates per million tokens: Opus 5 $5 in / $25 out, Sonnet 5 $2 / $10, Haiku 4.5 $1 / $5.

### OpenAI — not implemented

`AI_PROVIDER=openai` is accepted by config but the provider is Phase 6. It logs a clear warning and leaves AI disabled rather than failing obscurely.

### Switching providers

Changing provider is two lines in `.env`. No business logic imports a vendor SDK — only `src/ai/gemini/provider.ts` and `src/ai/anthropic/provider.ts` do — so no command or service changes when the provider does.

## Commands

All commands begin with `.` (configurable via `COMMAND_PREFIX`). 34 commands, 63 names including aliases.

### Opportunities

| Command | Aliases | Description |
|---|---|---|
| `.job <keywords>` | | Search by keyword |
| `.jobs <filters>` | | Search by location, type or recency |
| `.scholarships [filters]` | `.scholarship` | Scholarships and tuition funding |
| `.internships [filters]` | `.internship` | Internships and attachments |
| `.fellowships [filters]` | `.fellowship` | Fellowships |
| `.research [filters]` | `.projects` | Research, PhD and postdoc posts |
| `.grants [filters]` | `.grant`, `.funding` | Grants and calls for proposals |
| `.events [filters]` | `.event` | Events, webinars, summits |
| `.conferences [filters]` | `.conference` | Conferences and calls for abstracts |
| `.training [filters]` | `.trainings`, `.courses` | Short courses and workshops |

### Navigating results

| Command | Aliases | Description |
|---|---|---|
| `.next` | `.more` | Next page |
| `.prev` | `.previous`, `.back` | Previous page |
| `.details <n>` | `.detail`, `.info` | Full description of result *n* |

### Group management

Admin-only, and authorisation is checked against the *group's* admin list on every call — never inferred from the command name. Participant actions additionally require the bot itself to be an admin, and it refuses to act on itself.

| Command | Aliases | Description |
|---|---|---|
| `.groupinfo` | `.ginfo` | Group details and moderation settings (any member) |
| `.add <number>` | | Add someone to the group |
| `.kick @user` | `.remove` | Remove someone (refuses to remove an admin) |
| `.promote @user` | | Make someone a group admin |
| `.demote @user` | | Remove someone as group admin |
| `.open` / `.close` | `.unmute` / `.mute` | Who may send messages |
| `.lock` / `.unlock` | | Who may edit group info |
| `.welcome <on\|off\|set <msg>\|test\|reset>` | | Greet people who join. `{name}` tags them, `{group}` is the group name; `test` previews it |
| `.warn @user [reason]` | | Issue a warning |
| `.warnings @user` | `.warns` | Show active warnings with reasons and who issued them |
| `.resetwarns @user` | `.clearwarns`, `.unwarn` | Clear warnings |

Targets come from real WhatsApp mentions, not from parsing `@`-looking text, so a target cannot be forged by typing one. Warnings are an append-only log rather than a counter, so a removal can always be justified.

### Moderation

The bot reads every message in a group and enforces that group's rules. **Group admins, platform administrators and the bot itself are never moderated.** Deleting and removing need the bot to be a group admin; without that it can only warn, and says so.

| Command | Aliases | Description |
|---|---|---|
| `.mod` | `.moderation` | Overview of this group's rules |
| `.mod on` / `.mod strict` / `.mod off` | | Recommended protection (delete + warn) / the same and remove at the limit / everything off |
| `.mod test <message>` | | What a message would trigger, without deleting anything |
| `.mod copy` | | Copy these rules to the other groups of the WhatsApp community |
| `.antilink <on\|remove\|warn\|off> [invites\|all]` | | `invites` (default): other WhatsApp groups and channels, wa.me, Telegram, Discord — job links still work. `all`: every link |
| `.antilink allow <domain>` | | Never touch links to a domain, e.g. `who.int` |
| `.antipromo <on\|remove\|warn\|off>` | `.antiad` | Adverts, sales pitches, money schemes, follower boosting, "join my channel" |
| `.antipromo ai <on\|off>` | | Let the AI decide borderline posts the rules cannot |
| `.antispam <on\|remove\|warn\|off>` | `.antiflood` | Flooding (more than 6 messages in 10 s), the same message 3 times, or in 3+ groups within 10 minutes |
| `.badword add <word>` / `del` / `list` / `clear` | `.badwords` | Banned words and phrases, whole-word, catches `l.o.a.n`-style spellings |
| `.badword <on\|remove\|warn\|off>` | | What to do about them |
| `.silence @user [30m\|2h\|1d]` | `.shush` | Delete everything a member posts for a while (default 1 hour, up to 30 days) |
| `.unsilence @user` / `.silenced` | | Lift a silence / list who is silenced |
| `.warnlimit <1-10>` | | Warnings before `remove` rules remove someone |

Each rule's action: `warn` warns the sender; `delete` (what `on` means) deletes the message and warns; `remove` deletes, warns, and removes the sender at the warning limit. **Nobody is removed automatically unless an admin chose `remove`** (or `.mod strict`). A burst of rule-breaking counts as one warning per minute, so one flood does not instantly use up someone's warnings, and the bot never floods the group with its own notices.

The advert rules are tuned for an opportunities community: posts mentioning scholarships, vacancies, deadlines or stipends get the benefit of the doubt, so a stipend amount or an application link alone never triggers them. Use `.mod test` to check a borderline post before turning a rule on.

### Welcome messages

`.welcome on` greets everyone who joins: added by an admin, through an invite link, by approved request, or from the community. Without a custom message it uses a standard one that introduces the community and points to `.menu`.

People joining together are welcomed in **one** message tagging them all (up to 20, then "and N others"), and a group gets at most one welcome a minute, so a shared invite link never turns the bot into a flood. Joins that happened while the bot was offline for more than ten minutes are not welcomed late. The bot needs to be allowed to post: in a group closed to admins only (`.close`), make it an admin.

### Assistant

| Command | Aliases | Description |
|---|---|---|
| `.ask <question>` | `.ai`, `.assistant` | Ask a public-health question |

One command, not nine. `.gpt`, `.claude`, `.gemini` and friends would differ only in which company bills you, and would hard-code vendor choice into the command surface — exactly what the provider abstraction exists to avoid. Which model answers is an operator decision in `.env`; a member shouldn't need to know.

Guardrails, all covered by tests:
- **No individual medical advice.** A public-health community attracts clinical questions. It answers general public-health knowledge and declines to advise on anyone's personal care.
- **No invented opportunities.** It will not fabricate a scholarship, deadline or link, and redirects to the search commands, which track provenance.
- **Member text is data, not instructions**, and is wrapped as a quoted question.
- **Separate budget guard** — 15 questions per member per hour, independent of the general rate limit, so one person cannot spend the community's token budget.
- **Degrades silently.** With no key configured, `.ask` explains that the assistant is off and points at search. Nothing else is affected.

### System

| Command | Aliases | Description |
|---|---|---|
| `.help [command]` | `.h`, `.commands` | Command list, or help for one command |
| `.menu` | | Main menu |
| `.start` | | Get started |
| `.about` | | About the Colosseum |
| `.sources` | `.source` | Which sources are searched |
| `.ping` | `.alive`, `.uptime` | Liveness, uptime, memory |

### Locations

Several locations can be given at once, separated by commas or spaces:

```
.job public health nairobi, kisumu
.job public health nairobi, kampala
.scholarships kenya, uganda, tanzania
```

Countries are matched as **OR**. Named cities additionally give a ranking boost rather than acting as a hard filter — someone asking for Nairobi still sees a listing that only says "Kenya", just below the ones that actually say Nairobi.

### When sources find nothing: AI web fallback

If every configured source returns zero results **and** an AI provider is configured, the platform asks the model to search the live web and reports what it finds.

This exists because the connectors cover a narrow slice of the world. A search for public-health roles in Nairobi genuinely returns nothing today — the sources carry DRC, Germany and the US, but no Kenya. "Our four connectors do not have this" is a much weaker claim than "this does not exist", and the fallback closes that gap.

How it behaves:

- **Only on zero results.** Never runs when sources already answered, so it costs nothing on a normal search.
- **Uses the provider's own server-side web search** — no browser, scraper or extra API to run. Capped at 6 searches per call.
- **Results go through the same pipeline** — normalised, filtered, de-duplicated, ranked — so they render identically.
- **Marked `AI_ASSISTED`**, and the reply says plainly that these came from a web search and are not verified.
- **Every entry must have a real URL.** Entries without one are discarded: a lead a member cannot click through to verify looks actionable and is not.
- **No invented posting dates.** The model has no reliable one, and guessing would corrupt both the recency filter and the ranking.
- **Charged against the member's AI quota** (15/hour), the same budget guard `.ask` uses.
- **Silently skipped** when no provider is configured — you get the ordinary "no matches" reply.

> **Caveat:** like `.ask`, the fallback is unit-tested up to the network boundary — JSON extraction, validation, URL rejection, prompt construction — but the live call has not been exercised, because this project has no API key. Verify your first real fallback yourself with `npm run search -- --ai "..."`.

### Filters

Filters are recognised anywhere in the arguments and stack freely.

| Kind | Accepted | Example |
|---|---|---|
| Location | Country or city names | `.jobs nairobi`, `.jobs kenya` |
| Region | `africa`, `worldwide`, `global` | `.jobs africa` |
| Remote | `remote`, `work from home` | `.jobs remote` |
| Type | `internship`, `scholarship`, `fellowship`, `research`, `grant`, `conference`, `training`, `volunteer`, `hackathon`, `event`, `job` | `.jobs internship` |
| Recency | `today`, `latest`, `new`, `recent`, `this week`, `month` | `.jobs today` |
| Deadline | `deadline`, `closing soon` | `.jobs closing soon` |
| Experience | `entry-level`, `junior`, `graduate`, `trainee` | `.jobs entry-level` |

Combined: `.jobs nairobi internship today`

Recognised filter words are removed from the free-text search, so `.jobs nairobi` does not also require the word "nairobi" in the title.

---

## Opportunity sources

Each connector is independently enabled, isolated behind its own 12-second timeout, rate-limited to its upstream's stated policy, and cached. One failing source degrades that source alone — and the member is told the results may be incomplete.

| Source | Slug | Status | Trust | Min interval | Notes |
|---|---|---|---|---|---|
| Employer career boards (Greenhouse) | `greenhouse` | Enabled | 85 | 3 h | **First-party postings, straight from the employer** — no aggregator in the middle, real application deadlines where set, and the employer's own department labels as classification signal. Keyless. Organisations are configured in `GREENHOUSE_BOARDS`, so adding one needs no code. |
| [Remotive](https://remotive.com) | `remotive` | Enabled | 60 | 6 h | Remote roles. **Attribution and link-back are required by their terms**, and they ask for at most ~4 requests/day — both are enforced in code. Listings are delayed 24 h upstream. |
| [Arbeitnow](https://www.arbeitnow.com) | `arbeitnow` | Enabled | 40 | 3 h | Keyless breadth source. Heavily German/European, no server-side search, so filtering and ranking happen locally. |
| [ReliefWeb](https://reliefweb.int/jobs) | `reliefweb` | **Disabled** | 90 | 2 h | UN, NGO and humanitarian vacancies with real closing dates — WHO, UNICEF, UNFPA, MSF, IRC. **The highest-value source for this community.** Needs a free approved appname. |

### Enabling ReliefWeb — strongly recommended

Remotive and Arbeitnow are keyless and work immediately, but they carry almost no public-health or African content: a search for `nairobi` across both returns zero results. ReliefWeb is where the opportunities this community actually wants are posted.

1. Request a free appname: <https://apidoc.reliefweb.int/parameters#appname>
2. Set `RELIEFWEB_APPNAME=your-appname`
3. Add it to `SOURCES_ENABLED`:
   ```ini
   SOURCES_ENABLED=reliefweb,remotive,arbeitnow
   ```

> **Caveat, stated plainly:** the ReliefWeb connector follows their published v2 API documentation but has **not** been exercised against the live endpoint, because this project has no approved appname yet. ReliefWeb decommissioned v1 and v2 returns `403` to unregistered callers. Treat its field mapping as unverified until your first successful sync, and check `.sources` and the logs afterwards.

Until then `.sources` reports it as unavailable with the reason, rather than silently returning nothing.

---

## Development

### Adding a command

1. Create a file under `src/commands/<category>/`:

```ts
// src/commands/members/profile.ts
import type { Command } from '../types.js';

export const profileCommand: Command = {
  name: 'profile',
  aliases: ['me'],
  category: 'members',
  summary: 'View or edit your opportunity profile',
  usage: '.profile',
  examples: ['.profile'],
  // adminOnly: true,              // authorised against ADMIN_NUMBERS
  // exemptFromRateLimit: true,    // only for trivial commands
  async handler(context) {
    await context.reply(`Your country: ${context.member.country ?? 'not set'}`);
  },
};
```

2. Import and list it in `src/commands/registry.ts`.

That is all. `.help` is generated from the registry, so documentation cannot drift. Name and alias collisions throw at startup rather than silently shadowing.

The context gives you `reply`, `react`, `args`, `argv`, `member`, `isAdmin`, `log` and `getSession`/`setSession`. A handler never touches the WhatsApp socket, so it is unit-testable with no connection.

For a search-backed command, delegate to the shared pipeline:

```ts
import { runSearch } from '../opportunities/run-search.js';

async handler(context) {
  await runSearch(context, { forcedTypes: ['SCHOLARSHIP'], commandLabel: '.scholarships' });
}
```

### Adding an opportunity source

1. Create a file under `src/sources/<kind>/` exporting a `SourceConnector`:

```ts
import type { ConnectorMeta, FetchContext, SourceConnector } from '../types.js';
import { buildUrl, getJson } from '../common/http.js';

const meta: ConnectorMeta = {
  slug: 'who-careers',
  name: 'WHO Careers',
  kind: 'API',
  homepageUrl: 'https://careers.who.int',
  supplies: ['JOB', 'INTERNSHIP', 'FELLOWSHIP'],
  minFetchIntervalMinutes: 120,   // honour the upstream's stated limit
  trustScore: 95,                 // first-party postings rank higher
  attributionRequired: false,
  unavailableReason: null,        // or a string when a key is missing
};

export const whoConnector: SourceConnector = {
  meta,
  async fetch({ query, signal, log }: FetchContext) {
    const payload = await getJson<Response>(buildUrl(ENDPOINT, { q: query.terms }), { signal });
    return payload.items.map((item) => ({ title: item.title /* … */ }));
  },
};
```

2. Register it in `ALL_CONNECTORS` in `src/sources/registry.ts`.
3. Add the slug to `SOURCES_ENABLED`.

A connector returns `RawOpportunity[]` and maps only what its upstream actually said. It never classifies, de-duplicates or formats — normalisation does that for every source identically. Use `getJson` rather than `fetch` so you inherit timeouts, retry policy, the response-size ceiling and the identifying user-agent.

Set `unavailableReason` when a key or registration is missing: the connector stays registered and self-describing instead of silently absent.

### Project layout

```text
src/
├── index.ts              entry point, startup order, graceful shutdown
├── cli/search.ts         terminal search harness
├── config/env.ts         zod-validated environment, the only reader of process.env
├── core/                 logger (JID redaction), TTL cache, text utilities
├── domain/               Opportunity model, classification, normalisation
├── db/                   Drizzle schema, client, repositories
├── sources/              connector contract, registry/fan-out, connectors
├── search/               query parser, filters, dedupe, ranking, service
├── commands/             contract, registry, router, one file per command
├── whatsapp/             Baileys client, message rendering
└── http/                 health and status endpoints
```

---

## Security and privacy

- **Secrets only in the environment.** No key is committed; `.env` and `auth/` are gitignored.
- **Minimal personal data.** A member row holds their WhatsApp JID plus whatever they choose to tell us. No push-names, profile photos or contact-book entries are copied.
- **No personal data in logs.** JIDs are redacted to `254***060@s.whatsapp.net`. Raw message text is never logged — only the resolved command name.
- **Anonymous HTTP surface.** `/api/status` exposes no phone number or member identifier.
- **Admin authorisation** is checked against `ADMIN_NUMBERS` on the verified sender JID, before a handler runs. Admin commands return the unknown-command reply to non-admins, so their existence is not confirmed.
- **Persisted rate limiting** per member, so restarting cannot reset a flood.
- **URL validation.** Only absolute `http`/`https` URLs reach a member; `javascript:`, `data:` and `file:` are rejected.
- **HTML sanitised.** Source descriptions are stripped of tags, with `<script>` and `<style>` bodies removed first.
- **No remote code and no remote control.** The platform never downloads code at runtime and never takes instructions from a remote feed. Everything it runs is in this repository and reviewable.
- **Failure isolation.** A failing source, a thrown handler or an unhandled rejection cannot take the bot down.

---

## Troubleshooting

### `Cannot reach the database at the configured DATABASE_URL`

Start the dev server and create the tables:

```bash
./scripts/dev-services.sh start
npm run db:push
```

Check it is listening: `./scripts/dev-services.sh status`.

If you use `localhost` and it fails, try `127.0.0.1` — `localhost` can resolve to IPv6 `::1`, which the dev cluster does not bind.

### `Invalid environment configuration`

The message names each bad variable. Common causes: `DATABASE_URL` missing or not a URL; `ADMIN_NUMBERS` or `WHATSAPP_PAIR_NUMBER` containing a `+`, spaces or dashes (digits only).

### The bot connects but ignores every command

Run with `LOG_LEVEL=debug` and send `.ping`:

- **No `inbound message` line** — messages are not arriving. Check the connection, and that you are messaging the paired number.
- **`inbound message` but no `command handled`** — the text did not parse as a command. Check `COMMAND_PREFIX` matches what you typed.
- **`member lookup failed`** — the database is unreachable; see above.

Commands work from any number including the bot's own, so testing from the paired phone is fine.

### WhatsApp will not connect

- **QR code never appears** — `WHATSAPP_PAIR_NUMBER` is set; blank it for QR mode.
- **QR expires before you scan** — they rotate every ~20 seconds; a new one is printed automatically.
- **`WhatsApp session logged out`** — handled automatically: the stale credentials are deleted and a new QR/pairing code is printed. Scan it. If it logs out 3 times in an hour the platform stops re-pairing and says so — check the account is not being unlinked from the phone, then restart.
- **Connects then drops repeatedly** — another bot is almost certainly using the same number. Give this platform its own.
- **Pairing code rejected** — digits only, international format, no `+`, and it must be the number whose WhatsApp you are pairing.

### No results for anything

Check `.sources` or `/api/status`. If `SOURCES_ENABLED` is empty, startup logs `no opportunity sources are enabled`.

### Few results for public-health or African searches

The aggregators (Remotive, Arbeitnow) carry very little such content — they are breadth, not relevance. Result quality comes from the other two source kinds:

1. **Add employer career boards** to `GREENHOUSE_BOARDS` — immediate, keyless, and authoritative.
2. **Enable ReliefWeb** — one free appname unlocks UN, NGO and humanitarian vacancies with real deadlines. See [above](#enabling-reliefweb--strongly-recommended).

A search returning nothing is usually a source-coverage gap, not a bug. Check `.sources` or `/api/sources` to see what was actually searched.

### A source keeps failing

`.sources` and the logs name it. Failures are logged at `warn` because an unreachable upstream is operational noise, not a platform fault. Searches continue with the remaining sources and the reply says the list may be incomplete. Remotive blocks excessive requests — do not lower `minFetchIntervalMinutes` below their stated policy.

### Port already in use

`EADDRINUSE` on startup: change `PORT`, or find the holder with `ss -ltnp | grep 3100`.

### `npm run db:push` fails with constraint errors on PostgreSQL 18

PostgreSQL 18 gives NOT NULL constraints real names (`members_id_not_null`). drizzle-kit 0.30 does not recognise them, so its diff tries to `DROP` them and fails with `42P16` on any constraint backing a primary key — while possibly having already created new tables.

Apply schema changes with explicit SQL instead:

```bash
psql "$DATABASE_URL" -f drizzle/0001_group_moderation.sql
```

Migrations in `drizzle/` are written to be idempotent (`IF NOT EXISTS`), so re-running one is safe. On PostgreSQL 17 or earlier, `db:push` works normally.

### `npm run db:push` fails to resolve a module

`drizzle-kit` bundles the schema as CommonJS and cannot resolve a `.js` specifier onto a `.ts` file. `src/db/schema.ts` therefore declares its enum values directly and imports only *types* from the domain, guarded by a compile-time equality assertion. If you add a value to the domain, add it to the schema too — `npm run typecheck` will tell you if you forget.

### Tests fail on a machine with no database

They should not: the 133 unit tests cover pure logic and need neither a database nor a network. `vitest.config.ts` supplies the environment variables that config validation requires.

---

## Licence and attribution

Opportunity data belongs to its original publishers. Several sources require visible credit and a link back to the original posting; the renderer enforces that, and it must not be removed. Always apply through the official page.

Built for the **Public Health Colosseum**. Release **1.0 “Neo”** · Powered by **SCIAT SOLUTIONS**.
