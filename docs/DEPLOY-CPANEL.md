# Deploying to cPanel shared hosting

This works, with caveats you should understand before you start. Read [Known limitations](#known-limitations) first — not to talk you out of it, but because the failure modes are silent and you will want to recognise them.

---

## Why it's possible

| Requirement | Status |
|---|---|
| Native modules needing a compiler | **None.** All 11 runtime dependencies are pure JavaScript |
| Injected `PORT` | Honoured — Passenger can assign the port |
| Disk footprint | `dist/` 848 KB + `public/` 24 KB + `auth/` ~600 KB |
| Memory | ~87 MB resident |

## What cPanel can't give you

| Need | Problem | Solution in this guide |
|---|---|---|
| PostgreSQL | Most cPanel hosts offer MySQL only | Free external Postgres |
| TypeScript build | cPanel runs `npm install`, not `npm run build` | Build locally, upload `dist/` |
| Terminal to scan a QR | Usually none | **Browser pairing page** — or pair locally and upload `auth/` |
| Exactly one process | Passenger may spawn several | Force max instances to 1 |
| A process that never idles | Passenger stops idle apps | Keep-alive cron |

---

## Step 0 — Check your host first

Do this before anything else. If any fails, stop: the bot will not work on that host.

**1. Node.js support.** cPanel → **Setup Node.js App**. If that icon is missing, the host does not support Node and nothing below applies. You need **Node 20 or newer**.

**2. Outbound WebSocket.** Many shared hosts block them, which silently kills the WhatsApp connection. If you have SSH or a terminal:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://web.whatsapp.com
```

A `200` is a good sign but not proof. Ask support directly: *"Are outbound WebSocket (wss://) connections to third-party services permitted?"* A "no" or a vague answer means this will not work.

**3. Persistent processes.** Check the Terms of Service for "background processes" or "daemons". Many shared hosts forbid them outright, and a WhatsApp bot is exactly that. Being suspended for a ToS breach is worse than not deploying.

---

## Step 1 — Get a PostgreSQL database

cPanel's MySQL will not work; the schema uses PostgreSQL types and arrays.

Free managed Postgres (any of these):

- **Neon** — <https://neon.tech>
- **Supabase** — <https://supabase.com>
- **Aiven** — <https://aiven.io>

Create a database, copy the connection string. It looks like:

```
postgres://user:password@host.neon.tech/dbname?sslmode=require
```

Apply the schema **from your local machine**, pointing at the remote database:

```bash
cd phc-platform
psql 'postgres://...' -v ON_ERROR_STOP=1 -f drizzle/schema.sql
```

That is the full schema, once. Later versions change the database by themselves: on startup the app applies any change it has not seen yet, and records it in a `schema_migrations` table.

---

## Step 2 — Pairing

You have two options. **Option A is usually easier**, and works entirely in a browser.

### Option A — pair from the browser (recommended)

The platform ships a pairing page that renders the QR code as an image, so no terminal is needed.

The page is off by default (on a VPS you pair in the terminal instead). Shared hosting has no terminal, so turn it on here. Generate a token and add both to your cPanel environment variables:

```bash
openssl rand -hex 24
```

```
PAIRING_PAGE=on
ADMIN_PANEL_TOKEN=the-value-you-generated
```

After deploying (Step 5), open:

```
https://your-domain.com/admin/pair?token=YOUR_TOKEN
```

Scan the QR with **WhatsApp → Settings → Linked devices → Link a device**. The page polls every 3 seconds and refreshes the code as WhatsApp rotates it, then switches to a green "Connected" state showing the masked account.

The same page has a **Reset session and pair again** button — the recovery path if the encryption session ever corrupts, which otherwise needs shell access to delete `auth/`.

> **The page is disabled unless `PAIRING_PAGE=on` and `ADMIN_PANEL_TOKEN` is set.** Once paired, you can set `PAIRING_PAGE=off` again and restart, so the page is not there at all until you need it. A WhatsApp QR is a credential: anyone who scans it links the bot to *their* account and takes the deployment over. Without a token, every pairing route returns `404` — it does not even admit the page exists. Treat the URL like a password and use HTTPS.

### Option B — pair locally, upload the session

If you would rather not expose a pairing route at all, do the pairing where you have a terminal.

```bash
cd phc-platform
rm -rf auth
npm run dev
```

Scan the QR, wait for `whatsapp: connected`, then stop it with Ctrl-C. Upload the resulting `auth/` directory with the rest of the files.

You now have a valid `auth/` directory. **It is a credential — treat it like a password.** Anyone with those files can act as your WhatsApp account.

> **Only one process may ever use these files.** Running the bot locally and on cPanel at the same time corrupts the encryption session permanently (`Bad MAC` errors, messages silently undecryptable). When you deploy, stop your local instance.

---

## Step 3 — Build locally

cPanel will not compile TypeScript.

```bash
npm run build        # produces dist/
```

---

## Step 4 — Upload

Upload to a folder **outside** `public_html` (e.g. `/home/USER/phc-platform`) so the files are not web-accessible:

```
dist/              compiled app
public/            web UI
views/             pairing page (not publicly served)
drizzle/           migrations
package.json
package-lock.json
auth/              the paired session (Option B only)
```

**Do not upload** `node_modules/`, `src/`, or `.env` — dependencies are installed by cPanel and configuration is set in its UI.

---

## Step 5 — Create the Node.js app

cPanel → **Setup Node.js App** → **Create Application**:

| Field | Value |
|---|---|
| Node.js version | 20 or newer |
| Application mode | Production |
| Application root | `phc-platform` |
| Application URL | your domain or subdomain |
| Application startup file | `dist/index.js` |

Click **Create**, then **Run NPM Install**.

### Environment variables

Add these in the same screen. Do **not** set `PORT` — Passenger assigns it.

```
NODE_ENV=production
DATABASE_URL=postgres://...your external database...
WHATSAPP_PROVIDER=baileys
WHATSAPP_AUTH_DIR=./auth
COMMAND_PREFIX=.
ADMIN_NUMBERS=2547XXXXXXXX
PAIRING_PAGE=on
ADMIN_PANEL_TOKEN=your-generated-token
SOURCES_ENABLED=greenhouse,remotive,arbeitnow,jobicy,remoteok
GREENHOUSE_BOARDS=oneacrefund,resolvetosavelives,dimagi,givedirectly
AI_PROVIDER=gemini
GEMINI_API_KEY=your-key
GEMINI_MODEL=gemini-3.8-flash
WEB_SEARCH_PROVIDER=tavily
TAVILY_API_KEY=tvly-...
```

Then **Restart** the application.

---

## Step 6 — Force a single instance

**This is the most important step.** Two processes sharing `auth/` destroys the WhatsApp session.

Look for **Maximum application instances** (or similar) in the Node.js App screen and set it to **1**. If the option is absent, ask support to set `passenger_max_pool_size = 1` and `passenger_max_instances = 1` for your application.

Verify after a few minutes:

```bash
ps aux | grep "dist/index.js" | grep -v grep | wc -l
```

### The platform now enforces this itself

A second instance **refuses to start** rather than corrupting the session. It writes `auth/.lock` holding its process id, and any other process that finds a live owner exits immediately:

```
Refusing to start.

  Another instance (pid 30317) is already using this WhatsApp session.
  Only one process may use auth at a time — two will corrupt it
  permanently and the bot will silently stop responding.

  Stop the other instance first:  kill 30317
```

A lock left by a crashed process is reclaimed automatically, so an unclean shutdown never needs manual intervention.

**On cPanel this means:** if Passenger spawns a second worker, that worker fails loudly in the Passenger log instead of silently destroying your session. If you see that message in the log, Step 6 was not applied — fix the instance limit rather than deleting the lock file.

---

## Step 7 — Keep it awake

Passenger stops applications that go idle, which disconnects WhatsApp. Add a cron job in cPanel → **Cron Jobs**, every 5 minutes:

```
*/5 * * * * curl -fsS https://your-domain.com/health > /dev/null 2>&1
```

This is a mitigation, not a cure — see below.

---

## Step 8 — Verify

```bash
curl https://your-domain.com/health
```

Expect:

```json
{"status":"ok","whatsapp":"connected","uptimeSeconds":123}
```

Then send `.ping` from WhatsApp. If `/health` reports `connected` but commands do nothing, read the Passenger log (cPanel → Setup Node.js App → log file path) and look for `Bad MAC` or `Session error`.

If you see those, open the pairing page and use **Reset session and pair again** — no shell access required.

---

## Known limitations

Be realistic about what you are signing up for.

**Passenger restarts break the WhatsApp session.** Every restart re-reads `auth/` and re-establishes the encryption ratchet. Occasional restarts are survivable; frequent ones are not. If the host restarts your app aggressively, you will re-pair often.

**The keep-alive cron is a workaround, not a fix.** It reduces idle shutdowns; it does not prevent the host from recycling your process.

**If Passenger ever runs two instances, the second now refuses to start** and says why in the log. Before the lock existed, this silently destroyed the session: `/health` reported `connected`, commands did nothing, and nothing reached the database, because messages arrived but could not be decrypted. If you ever do see `Bad MAC` or `Session error` in the log, recovery is the **Reset session and pair again** button on the pairing page.

**Resource limits.** Shared hosting caps CPU, memory and process count. A search fans out to five sources concurrently; under a tight CPU cap that gets slow or killed.

**Terms of service.** Long-running background processes breach many shared-hosting agreements. Check yours.

### When to move

If you find yourself re-pairing more than once a week, the host is recycling the process too aggressively and no configuration will fix it. At that point a small VPS — or the Ubuntu server you already run — is the answer. The bot needs 87 MB of RAM and one reliable process; that is the cheapest VPS tier anywhere.

A reasonable middle ground: **web UI on cPanel, bot on a machine you control.** The search service is transport-agnostic, so this needs no code changes.
