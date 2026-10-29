# Legacy analysis — WOLFBOT / silentwolf

Record of the analysis that led to building this platform as a new service rather than extending the existing bot.

- **Analysed:** 4 October 2026
- **Repository:** `/home/kali/Projects/theHPA/Whatsapp/bot/silentwolf` — git remote `github.com/WOLVAREX/silentwolf`
- **Live instance:** a host on the local network (port 3000), Ubuntu 26.04, deployed from `/home/<user>/Tools/silentwolf`
- **Version:** WOLFBOT 1.1.7, Node v24.21.0, 826 commands, prefix `.`

---

## A. Stack

```text
Language/runtime   Node.js, ESM, package engines "22.x", running v24.21.0
WhatsApp library   wolfsocket 1.0.1 — third-party Baileys fork by WOLF TECH/WOLVAREX
                   wolfbtns 1.3.2 — interactive buttons helper
Backend            Express 5 — status page, /health, /api/status, /logs, SSE stream, pairing API
Database           better-sqlite3 (primary; SQLite VACUUM visible in live logs)
                   optional PostgreSQL via DATABASE_URL (pg)
                   mongodb + mongoose also declared
Frontend           none — one server-rendered status page with inline JS
Search             none; ruhend-scraper, axios, jsdom present for scraping
AI                 @google/generative-ai, openai SDKs declared; no Anthropic SDK
Auth               SESSION_ID env var ("WOLF-BOT:…"), minted on a third-party site
                   (7-w.vercel.app); pairing-code flow at /api/pair
Scheduler          node-schedule, plus an internal AUTOJOIN scheduler firing every 2s
Commands           826 across 32 categories, 855 command files
```

---

## B. How it works

The repository contains **twelve readable files**. Everything the bot actually does is elsewhere.

```text
index.js  (216 lines, readable — a "settings guardian" shim)
   ├── patches child_process.spawn → forces npm install --ignore-scripts
   ├── patches node_modules/@whiskeysockets/baileys/package.json on each boot
   ├── hooks process.chdir to back up / restore settings files
   ├── reads wolf.js, rewrites createRequire([…]) → createRequire(import.meta.url)
   ├── writes the result to .bot_run.js
   └── await import('.bot_run.js')          ← the entire bot starts here

wolf.js  (41 KB on ONE line)
   └── eval-based loader: control-flow flattening, numeric-literal obfuscation
       (0o400151%65569 style), an encrypted string table, and a self-integrity
       check that aborts with "Error: the code has been tampered!"
       At runtime it extracts a source tree and process.chdir()s into it.
```

Measured: no plaintext URLs and only 117 unique alphabetic tokens ≥8 characters across the whole 41 KB. The readable source has never existed in git history on any of the 6 branches (58 commits, all titled "Silent Wolf").

### What the loader extracts

On the live host the bot process runs with `cwd = /tmp/.5026fb0552183ba4/norah-main` — a hidden temp directory, matching the `//Norah - Hii !!` marker at the top of `index.js`. It contains:

```text
commands/   8.5 MB, 32 categories, 855 .js files   ← readable
lib/        1.6 MB, 68 modules                     ← mostly readable
bin/        3.1 MB
data/       5.0 MB (SQLite + runtime state)
index.js    372 KB, obfuscated on one line         ← NOT readable
settings.js, AGENTS.md, Dockerfile, package.json
node_modules -> /home/<user>/Tools/silentwolf/node_modules (symlink)
```

So the command handlers are readable, but the core — event handling, the AUTOJOIN scheduler, the database layer, branding strings — is in the obfuscated 372 KB `index.js`, and `lib/remoteUrls.js` is separately obfuscated with `javascript-obfuscator`.

---

## C. Problems identified

### C1. The architecture rejects local modification — the decisive finding

The extracted tree lives in `/tmp` and is re-created on every start. The wrapper's own comment says so (`index.js:166`):

> *"Preserve settings from an existing installation on first run, before a later extraction can replace the directory with a clean source archive."*

And the preservation shim explicitly refuses to preserve code (`index.js:40-47`):

```js
_SKIP_DIRS = ['node_modules', 'commands', 'bin', 'scripts', 'lib']
_SKIP_EXT  = ['.js', '.cjs', '.mjs', '.md', '.html', '.sql', …]
```

It backs up settings and data only. `commands/`, `lib/` and every `.js` file are excluded by design.

**Consequence:** a cleanly written `commands/jobs/` module added to the extracted tree is deleted on the next restart. There is no supported extension point. "Extend the existing system cleanly" is not achievable against this distribution — not for want of effort, but because it is built to reject local modification.

### C2. Remote control of the WhatsApp account

`lib/remoteUrls.js` is obfuscated specifically to hide three endpoints. Decoded statically (base64 variant with a custom alphabet, no code executed):

| Purpose | Primary | Fallback |
|---|---|---|
| **Groups to join** | `courageous-alpaca-0e1682.netlify.app/groups.json` | `raw.githubusercontent.com/peace-amani/sw/main/groups.json` |
| Channels to follow | `7-w.vercel.app/channel.json` | `raw.githubusercontent.com/twi-wolf/7-w/main/channel.json` |
| Reactions | `7-w.vercel.app/wolfreacts.json` | `raw.githubusercontent.com/twi-wolf/7-w/main/wolfreacts.json` |

The live log stream shows the mechanism running: a scheduler fires every 2 seconds, fetches the group feed, parses invite codes and calls `groupAcceptInvite`. The current entry resolves to a group named `wolvarex`.

Whoever controls that Netlify site decides which WhatsApp groups the operator's account joins, which channels it follows, and what it reacts to. These URLs were deliberately obfuscated while the rest of the file was not.

**There is no way to turn it off.** Verified by decoding the full string table of the obfuscated `index.js` (1,823 strings, 131 environment-variable names): the only AUTOJOIN strings are debug messages, and no environment variable, settings key or command controls it. `mysettings.json` has no `autojoin` key, and the only join commands are the manual `.join` and `.joinapproval`. Mitigation is limited to blocking those hosts at the network layer — awkward, since one fallback is `raw.githubusercontent.com` — or not running the bot.

### C3. Secrets sit beside unauditable code

`.env` holds, alongside `SESSION_ID`:

- `PTERODACTYL_KEY` + `PTERODACTYL_URL` — full server-panel API control
- `PAYSTACK_KEY` — live payment secret
- `DATABASE_URL`

An encrypted `eval` blob with a tamper tripwire runs with unrestricted access to all of them.

### C4. WhatsApp credentials pass through a third party

The documented setup sends the operator to `7-w.vercel.app/wolf.html` to generate `SESSION_ID`, so the account's authentication material is produced on infrastructure belonging to the bot's author.

### C5. Dependency integrity is actively weakened

`npm install` is force-patched to `--ignore-scripts`, and `node_modules/@whiskeysockets/baileys/package.json` is rewritten on every boot. The WhatsApp layer itself is a third-party Baileys fork (`wolfsocket`) rather than upstream.

### C6. Privacy

`/api/status` publishes the owner's phone number (`"owner": "2547XXXXXXXX"`) on an unauthenticated endpoint. `mysettings.json` shows `autoview` retaining a log of senders whose statuses were auto-viewed, including full phone numbers.

### C7. Technical debt and scope mismatch

- Five datastore drivers declared for one bot: `better-sqlite3`, `pg`, `sql.js`, `mongodb`, `mongoose`
- `botMode: public` means all 826 commands are invokable by anyone
- The feature set is largely orthogonal to a public-health opportunity platform: WormGPT, "ethical hacking" port-scan/nmap commands, anime reaction GIFs, 50+ text-effect generators, games, a Valentine category
- Identity mismatch: the git remote is `WOLVAREX/silentwolf`; the README instructs cloning `sil3nt-wolf/silentwolf`
- No tests (`"test": "echo \"No tests specified\""`)

---

## D. Decision

Build the Public Health Colosseum platform as a **new, own-source service**: TypeScript, upstream Baileys, PostgreSQL, its own WhatsApp number and session.

Nothing of value is lost, because there is no readable, modifiable component to preserve — and SCIAT SOLUTIONS owning its own source is the only way the AI abstraction, the admin dashboard and a genuine rebrand become possible at all. WOLFBOT keeps running untouched on `a LAN host` until PHC is ready to take over.

### Rebranding the legacy bot

Only the surface is reachable: `BOT_NAME` (which does drive the status page and menu headers), the README, `package.json` and the `index.js` banner. The 826 command replies will keep saying WOLFBOT, because those strings are encrypted inside the blob.

---

## E. What this platform does differently

| WOLFBOT | PHC Platform |
|---|---|
| Obfuscated `eval` blob with a tamper check | All source in the repository, reviewable |
| Extracts code from a remote archive at runtime | Never downloads or executes remote code |
| Takes group/channel instructions from a remote feed | Takes instructions only from the operator's own config |
| Session minted on a third-party website | Own session, generated locally, never leaves the host |
| Owner phone number on a public endpoint | No personal identifier on any endpoint |
| Phone numbers in settings logs | JIDs redacted in logs; raw message text never logged |
| Code changes wiped on restart | Ordinary repository; changes persist |
| 826 commands, all public | 19 commands, admin authorisation enforced against config |
| No tests | 133 unit tests, clean typecheck and build |
| Five datastore drivers | One, PostgreSQL via Drizzle |
| One bot, one purpose, hard-coded | Source- and provider-agnostic by construction |

---

## Method note

Everything above is from reading the repository, the live host over SSH, the live HTTP endpoints and the live log stream, plus **static** decoding of the obfuscated string tables — the base64-with-custom-alphabet scheme was reimplemented as a pure data transform in Python. The vendor's obfuscated code was never executed to obtain these findings.
