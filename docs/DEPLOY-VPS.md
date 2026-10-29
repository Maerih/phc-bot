# Running the bot on a VPS

The recommended way to run the platform. Unlike shared hosting, a VPS gives the bot what it actually needs: one process that stays up, a disk that persists, and no one recycling it behind your back.

Everything is driven by **`./ctl.sh`**. It runs the bot and PostgreSQL as two containers and keeps everything the bot owns inside the project folder.

---

## What you need

| | |
|---|---|
| A Linux VPS | Any x86-64 distribution. Ubuntu or Debian are simplest. |
| Memory | 1 GB is comfortable. The bot itself uses ~90 MB; PostgreSQL the rest. |
| Disk | 2 GB free, mostly for container images. |
| A WhatsApp number | **Its own number** — not one another bot already uses. |

You do **not** need Node.js or PostgreSQL installed. Both run in containers.

---

## 1. Get Docker

Pick one.

### Option A — system Docker (simplest, survives reboots by itself)

If you have `sudo` on the VPS:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"
```

Log out and back in so the group change applies, then check:

```bash
docker info
```

The daemon starts at boot automatically, and with it the bot.

### Option B — rootless, folder-local, no sudo

Docker's binaries go into the project's `.runtime/` folder and run as your own user. Nothing is installed system-wide.

```bash
./ctl.sh install-docker
```

It needs the `uidmap` package. Most VPS images already have it; if `install-docker` warns that `newuidmap` is missing, an administrator runs `apt install uidmap` once.

> **Reboots:** a rootless daemon does not start on boot by itself. After a VPS restart, run `./ctl.sh start` again. To make it automatic you would need a user service plus `loginctl enable-linger` — a one-time change outside the project folder. If unattended restarts matter, Option A is the simpler answer.

`ctl.sh` prefers a working system Docker when there is one, and falls back to the folder-local copy otherwise. You never choose between them by hand.

---

## 2. Copy the project to the VPS

From your own computer:

```bash
rsync -av --exclude node_modules --exclude dist --exclude .runtime \
  --exclude .devservices --exclude data --exclude auth --exclude logs \
  ./phc-platform/ you@your-vps:~/phc-platform/
```

Or `git clone` it there.

**Do not copy a WhatsApp session (`auth/` or `data/auth/`) from another machine that is still running the bot.** Two machines on one session destroy it — see [The one rule](#the-one-rule).

---

## 3. Configure

On the VPS:

```bash
cd ~/phc-platform
cp .env.example .env
nano .env
```

Fill in at least:

```ini
ADMIN_NUMBERS=2547XXXXXXXX
AI_PROVIDER=gemini
GEMINI_API_KEY=your-key
WEB_SEARCH_PROVIDER=tavily
TAVILY_API_KEY=tvly-...
```

Leave `PAIRING_PAGE=off` (the default). On a server you pair in the terminal, so no web page ever shows the QR.

You do **not** set `DATABASE_URL`, `PORT` or `WHATSAPP_AUTH_DIR` — `ctl.sh` sets those to match the containers, and creates a random database password the first time.

---

## 4. Start

```bash
./ctl.sh start
```

The first run builds the image (downloads Node and the npm packages) and creates the database with the full schema. That takes a few minutes. Later starts take seconds, and apply any database changes a new version brings by themselves.

When it finishes:

```
Docker:     running (system)
phc-db:     running
phc-app:    running / healthy
WhatsApp:   not paired — run ./ctl.sh pair
```

If WhatsApp is not paired yet, `start` goes straight on to show the QR code — see the next step.

---

## 5. Pair WhatsApp

In your SSH session on the VPS:

```bash
./ctl.sh pair
```

The QR code is drawn right there in the terminal. Scan it with **WhatsApp → Settings → Linked devices → Link a device**. WhatsApp issues a new code about every 20 seconds and the terminal redraws it; scan the newest. When it connects the view closes by itself:

```
WhatsApp connected. Send .ping to the bot to check it answers.
```

Ctrl-C only closes the view; the bot keeps running and waiting. Make the terminal at least 60 columns wide, or the code wraps and will not scan.

Confirm from WhatsApp:

```
.ping
```

> The QR is a credential. Whoever scans it binds the bot to *their* account and takes your deployment over. That is why it is shown only in the terminal of someone already logged in to the server, and never on a web page.

---

## Day to day

| Command | Does |
|---|---|
| `./ctl.sh status` | What is running, and whether WhatsApp is connected |
| `./ctl.sh pair` | Show the QR code in the terminal (only needed when not paired) |
| `./ctl.sh logs` | Follow the bot's log (Ctrl-C to stop following) |
| `./ctl.sh restart` | Restart the bot. Picks up `.env` changes. Keeps the session. |
| `./ctl.sh update` | Rebuild from source and restart. Keeps the session and data. |
| `./ctl.sh backup` | Database dump + WhatsApp session into `backups/` |
| `./ctl.sh stop` | Stop the bot and the database |
| `./ctl.sh reset-session` | Delete the session and pair again (shows the new QR) |
| `./ctl.sh uninstall` | Remove containers, image and **database**. Keeps `data/auth`. |

### Updating the code

```bash
# copy or pull the new code, then:
./ctl.sh update
```

### Where things live

```
phc-platform/
  .env                you edit this
  data/auth/          the WhatsApp session — a credential
  backups/            ./ctl.sh backup output — also credentials
  .runtime/           generated: DB password, container env, Docker (Option B)
```

The database lives in the Docker volume `phc-pgdata`. With Option B that volume is itself inside `.runtime/data`, so the whole deployment is one folder.

---

## The one rule

**Exactly one running bot per WhatsApp session.**

Two processes sharing a session each advance its encryption keys independently and destroy it within seconds. The symptom is deceptive: `/health` says connected, `.ping` does nothing, and the log fills with `Bad MAC` and `Session error`. Messages arrive; they just can't be decrypted. Recovery is `./ctl.sh reset-session` and pairing again.

The platform defends against this in two layers:

- the container has a fixed name, so Docker refuses to start a second one
- the bot takes a lock on its session at startup, and a second instance exits immediately with an explanation instead of corrupting anything

What neither can see is **another machine** using a copy of the same session — your laptop still running `npm run dev` with a session you copied to the VPS, for instance. Stop the bot everywhere else before starting it here.

---

## Making it public (optional)

Search on the web page is the only part members need over the internet. The browser pairing page is off on a VPS (`PAIRING_PAGE=off`), so there is nothing there to find.

Put a reverse proxy with HTTPS in front, for example Caddy:

```
opportunities.your-domain.com {
    reverse_proxy 127.0.0.1:3100
}
```

Keep `PHC_BIND` at its default of `127.0.0.1` — the proxy reaches it locally, and nothing else can. Only set `PHC_BIND=0.0.0.0` if you understand that it exposes the port directly.

---

## Troubleshooting

**`no working Docker found`** — install it (step 1).

**`.env not found`** — `cp .env.example .env` and fill it in.

**`WhatsApp: not paired` and it stays that way** — you have not scanned yet. Run `./ctl.sh pair`.

**`.ping` does nothing but status says connected** — almost always a session used by two processes. Check `./ctl.sh logs` for `Bad MAC`. Stop every other copy of the bot, then `./ctl.sh reset-session`.

**`Refusing to start ... already using this WhatsApp session`** — a second bot was started. That message is the protection working; stop the other one.

**The first `start` is very slow** — it is downloading images and npm packages. Later starts reuse them.

**After a reboot nothing is running** — with Option B the rootless daemon does not start on boot. Run `./ctl.sh start`, or use Option A.

**`./ctl.sh pair` shows nothing for a while** — the bot is between codes or still starting. A code appears within about 20 seconds; if not, check `./ctl.sh logs`.

**The QR will not scan** — the terminal is too narrow and the code wrapped. Widen the window (60+ columns) or zoom out; the next code redraws.
