# Running the bot on a VPS

The recommended way to run the platform. Unlike shared hosting, a VPS gives the bot what it actually needs: one process that stays up, a disk that persists, and no one recycling it behind your back.

---

## Install: one command

Log in to the server over SSH, as root or as any user, and run:

```bash
curl -fsSL https://raw.githubusercontent.com/Maerih/phc-bot/main/install.sh | bash
```

That downloads the bot from GitHub into `~/phc-bot` and runs `./ctl.sh start`, which does everything else:

| Step | What happens |
|---|---|
| 1. Checking this machine | Linux and CPU type, the tools it needs, disk space, memory |
| 2. Docker | Uses Docker if it is installed and you can use it. Otherwise downloads the bot's own copy into its folder: as root it runs as an ordinary daemon with nothing to set up; as another user it runs rootless. Checks the bot's port is free. |
| 3. Configuration | First run: asks a few questions and writes `.env` (see below). Every run: checks the admin numbers, tests the Gemini key with Google, and says which features are on |
| 4. Building the bot | Builds the bot, but only when the code changed since the last build. Then runs the bot's own settings check, so a typo in `.env` is reported here instead of crashing the bot |
| 5. Database | Creates PostgreSQL and its tables on the first run; starts it after that |
| 6. Starting the bot | Starts the bot, or restarts it if the code or settings changed. Offers to start it by itself after a reboot, then shows the WhatsApp QR code right in the terminal |

The questions on the first run:

- **Admin WhatsApp number(s):** country code first, digits only, for example `254712345678`. Admins can run every command, including group moderation.
- **Gemini API key** (optional): turns on `.ask` and searching online when the sources find nothing. A free key: <https://aistudio.google.com/apikey>.
- **Tavily API key** (optional): turns on live web search for scholarships and fellowships. A free key: <https://app.tavily.com>.
- **Timezone** (Enter keeps Africa/Nairobi).

Keys are typed hidden, and `.env` is readable only by you. Answer again any time with `./ctl.sh setup`.

The first run takes a few minutes, mostly downloading. Later runs take seconds.

### What the server needs

| | |
|---|---|
| A Linux server | x86-64 or ARM64. Ubuntu or Debian are simplest. |
| Memory | 1 GB is comfortable. |
| Disk | 3 GB free. |
| `git` and `curl` | On almost every server image already. If not: `sudo apt install git curl` |
| A WhatsApp number | **Its own number**, not one another bot is using. |

Missing pieces are installed, not reported:

- **As root**, anything missing (a tool such as `curl`, or `iptables` for Docker's networking) is installed with the system's package manager, and Docker needs no further setup. Inside its container the bot still runs as an ordinary unprivileged user, never as root.
- **As another user**, Docker runs rootless, which needs the `uidmap` package, a user-ID range for your user and, on Ubuntu 23.10 and later, an AppArmor rule. `start` lists what is missing and offers to set it all up with `sudo`, which asks for your password once. Without sudo rights, it prints the exact commands for an administrator.

If you have sudo and would rather install Docker system-wide, do it first. The bot then uses it, and Docker brings the bot back after a reboot by itself:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"   # then log out and back in
```

### Without the one-liner

The same thing by hand:

```bash
git clone https://github.com/Maerih/phc-bot.git ~/phc-bot
cd ~/phc-bot
./ctl.sh start
```

---

## Pair WhatsApp

At the end of the first start, the QR code is drawn in the terminal. Scan it with **WhatsApp → Settings → Linked devices → Link a device**. WhatsApp issues a new code about every 20 seconds and the terminal redraws it; scan the newest one. When it connects, the view closes by itself:

```
WhatsApp connected. Send .ping to the bot to check it answers.
```

If you closed the view before scanning, show it again with `./ctl.sh pair`. Make the terminal at least 60 columns wide, or the code wraps and will not scan.

> The QR is a credential. Whoever scans it binds the bot to *their* account and takes your deployment over. That is why it appears only in the terminal of someone already logged in to the server, never on a web page.

---

## Update to the latest version

```bash
cd ~/phc-bot
./ctl.sh update
```

It pulls the latest code from GitHub, shows what changed, then runs the same steps as `start`. It rebuilds only if the code changed, and keeps your WhatsApp session, settings and database. Running the install one-liner again does the same thing.

---

## Day to day

Run these in `~/phc-bot`.

| Command | Does |
|---|---|
| `./ctl.sh start` | Everything above. Safe to run any time: it only changes what needs changing |
| `./ctl.sh update` | Pull the latest version from GitHub, then start |
| `./ctl.sh doctor` | Run every check and report, without changing anything |
| `./ctl.sh status` | What is running, and whether WhatsApp is connected |
| `./ctl.sh logs` | Follow the bot's log (Ctrl-C stops following) |
| `./ctl.sh setup` | Change the answers in `.env`; `start` then applies them |
| `./ctl.sh pair` | Show the QR code (only needed when not paired) |
| `./ctl.sh restart` | Restart the bot. Keeps the session |
| `./ctl.sh backup` | Database dump and WhatsApp session into `backups/` |
| `./ctl.sh autostart on` / `off` | Start by itself after a reboot, or not |
| `./ctl.sh stop` | Stop the bot and the database |
| `./ctl.sh reset-session` | Delete the session and pair again (shows the new QR) |
| `./ctl.sh uninstall` | Remove containers, image and **database**. Keeps `data/auth` |

### Where things live

```
phc-bot/
  .env                your settings (./ctl.sh setup edits it)
  data/auth/          the WhatsApp session — a credential
  backups/            ./ctl.sh backup output — also credentials
  .runtime/           generated: database password, the private Docker copy
```

The database lives in the Docker volume `phc-pgdata`. With the private Docker copy, that volume is itself inside `.runtime`, so the whole deployment is one folder.

### After a reboot

With Docker installed system-wide, the bot comes back by itself. With the bot's own copy, the first `start` asks whether to set that up; say yes, or later run `./ctl.sh autostart on`. As root it adds a system service that starts at boot; as another user, a user service. If a user's service needs an administrator to allow it to start before anyone logs in, it prints the one command to run.

---

## The one rule

**Exactly one running bot per WhatsApp session.**

Two processes sharing a session each advance its encryption keys independently and destroy it within seconds. The symptom is deceptive: `/health` says connected, `.ping` does nothing, and the log fills with `Bad MAC` and `Session error`. Messages arrive; they just can't be decrypted. Recovery is `./ctl.sh reset-session` and pairing again.

The platform defends against this in three layers:

- the containers have fixed names, so Docker refuses to start a second copy;
- `start` refuses when another copy of the bot already answers on its port;
- the bot locks its session at startup, and a second instance exits at once with an explanation.

What none of them can see is **another machine** using a copy of the same session. Never copy `data/auth` from a machine where the bot is still running. Moving to a new server? Pair it fresh, and once it works, stop the old one and unlink its device in WhatsApp.

---

## Making it public (optional)

The web search page is the only part members need over the internet. The browser pairing page is off on a VPS (`PAIRING_PAGE=off`), so there is nothing there to find.

Put a reverse proxy with HTTPS in front, for example Caddy:

```
opportunities.your-domain.com {
    reverse_proxy 127.0.0.1:3100
}
```

Keep the bot listening on `127.0.0.1` (the default): the proxy reaches it locally, and nothing else can. `PHC_BIND=0.0.0.0 ./ctl.sh start` exposes the port directly; do that only if you understand why.

---

## Troubleshooting

Start with `./ctl.sh doctor`: it runs every check and marks problems with ✗, with the fix next to each.

**An item is marked ✗ under Docker.** Run `./ctl.sh start` in a terminal: it offers to fix them with sudo. Without sudo rights, an administrator runs the command printed beside each item, once. Or run the install as root, which needs none of them.

**`Some settings in .env are not valid`.** The lines above it name the setting and the allowed values. Fix `.env`, or run `./ctl.sh setup`. The running bot is left as it was until the settings are valid.

**`Port 3100 is used by another program`.** Stop that program, or run on another port: `PHC_PORT=3200 ./ctl.sh start`.

**`Another copy of this bot is already running`.** Probably `npm start` or `npm run dev` in another folder. Stop it first; see [The one rule](#the-one-rule).

**`could not update from GitHub`.** Files in the folder were edited by hand. `git status` shows which; `git stash` sets the edits aside.

**`.ping` does nothing but status says connected.** Almost always a session used by two processes. Check `./ctl.sh logs` for `Bad MAC`. Stop every other copy of the bot, then `./ctl.sh reset-session`.

**The QR will not scan.** The terminal is too narrow and the code wrapped. Widen the window (60+ columns) or zoom out; the next code redraws.

**The bot stopped answering after you installed other software.** Run `./ctl.sh update`, then `./ctl.sh doctor`. Other apps often install Docker system-wide; the bot keeps using the Docker it was set up with, so its database and settings stay where they are. `start` stops any second copy of the bot it finds in another Docker, and `doctor` says whether the bot is running, whether WhatsApp is connected, whether the bot can reach the internet, and whether messages are failing to decrypt. If the bot cannot reach the internet because two Docker daemons now share the machine, `./ctl.sh use-system-docker` moves it onto the system one, copying the database across; the WhatsApp session and `.env` are not touched.

**After a reboot nothing is running.** With the private Docker copy, run `./ctl.sh autostart on` once.
