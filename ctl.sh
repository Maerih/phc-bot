#!/usr/bin/env bash
#
# Public Health Colosseum — control script.
#
# Runs the bot and its PostgreSQL database as two containers. Everything the
# bot owns lives under this folder: the WhatsApp session (data/auth), generated
# secrets and, when no system Docker is available, the Docker binaries
# themselves (.runtime/bin) running rootless as your own user — no sudo.
#
#   ./ctl.sh start            everything: check the machine, get Docker, set up
#                             .env, build, start the database and the bot, pair
#   ./ctl.sh doctor           run every check and report; changes nothing
#   ./ctl.sh setup            (re)answer the configuration questions
#   ./ctl.sh stop             stop the bot and the database
#   ./ctl.sh restart          restart the bot (keeps session and data)
#   ./ctl.sh status           what is running, and is WhatsApp connected
#   ./ctl.sh logs             follow the bot's log
#   ./ctl.sh pair             show the WhatsApp QR code here, in the terminal
#   ./ctl.sh update           get the latest from GitHub, rebuild if it changed,
#                             restart (keeps the session, settings and data)
#   ./ctl.sh backup           database dump + WhatsApp session, timestamped
#   ./ctl.sh reset-session    delete the WhatsApp session and pair again
#   ./ctl.sh autostart on|off start the bot by itself after a reboot
#   ./ctl.sh install-docker   fetch rootless Docker into .runtime (no sudo)
#   ./ctl.sh uninstall        remove containers, image and database volume
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RT="$ROOT/.runtime"
DATA="$ROOT/data"

# Names of everything this bot creates. PHC_NAME=other gives a second,
# independent bot its own containers, network, database and service — run it
# from its own folder, since the folder holds the WhatsApp session.
NAME="${PHC_NAME:-phc}"
[[ "$NAME" =~ ^[a-z][a-z0-9-]{0,30}$ ]] || { echo "Error: PHC_NAME must be lowercase letters, digits and dashes." >&2; exit 1; }
UNIT="$NAME-dockerd"

DOCKER_VERSION="${DOCKER_VERSION:-29.8.2}"
IMAGE="$NAME-platform:latest"
NET="$NAME-net"
DB="$NAME-db"
APP="$NAME-app"
DB_VOLUME="$NAME-pgdata"
DB_IMAGE="postgres:18"

# Where the bot listens on the host. 127.0.0.1 keeps it off the public
# internet; reach it through an SSH tunnel or a reverse proxy. Set
# PHC_BIND=0.0.0.0 only if you put HTTPS in front of it.
PHC_BIND="${PHC_BIND:-127.0.0.1}"
PHC_PORT="${PHC_PORT:-3100}"

cd "$ROOT"

say()  { printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }
die()  { warn ""; warn "Error: $*"; exit 1; }

# Progress output for start and doctor.
STEP=0
STEPS=6
step()    { STEP=$((STEP + 1)); say ""; say "[$STEP/$STEPS] $*"; }
ok()      { say "  ✓ $*"; }
note()    { say "  • $*"; }
problem() { warn "  ✗ $*"; }

# Questions only when a person is at the keyboard; under systemd or cron
# every prompt is skipped and a missing answer is an error that says why.
interactive() { [ -t 0 ] && [ -t 1 ]; }

ask() {
	local prompt="$1" default="${2:-}" answer=""
	if [ -n "$default" ]; then printf '  %s [%s]: ' "$prompt" "$default" >&2; else printf '  %s: ' "$prompt" >&2; fi
	IFS= read -r answer || true
	printf '%s' "${answer:-$default}"
}

# For API keys: typed without echo, so they never sit on the screen.
ask_secret() {
	local answer=""
	printf '  %s: ' "$1" >&2
	IFS= read -rs answer || true
	printf '\n' >&2
	printf '%s' "$answer"
}

confirm() {
	case "$(ask "$1 (y/n)" "$2")" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

# ── Docker: system if it works, otherwise folder-local rootless ─────────────

LOCAL_DOCKER=0

resolve_docker() {
	if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
		return 0 # a working system Docker; use it as-is
	fi
	if [ -x "$RT/bin/dockerd-rootless.sh" ]; then
		LOCAL_DOCKER=1
		export PATH="$RT/bin:$PATH"
		export DOCKER_HOST="unix://${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/docker.sock"
		return 0
	fi
	die "no working Docker found.
  Either install Docker on this machine, or run:  ./ctl.sh install-docker
  (fetches rootless Docker into .runtime — no sudo, nothing installed system-wide)"
}

daemon_up() { docker info >/dev/null 2>&1; }

daemon_start() {
	daemon_up && return 0
	[ "$LOCAL_DOCKER" = 1 ] || die "Docker is installed but its daemon is not running."
	say "Starting rootless Docker daemon..."
	mkdir -p "$RT/data"
	if systemctl --user show-environment >/dev/null 2>&1; then
		# Transient user unit: leaves no unit file behind, logs go to the journal.
		systemctl --user reset-failed "$UNIT" 2>/dev/null || true
		systemd-run --user --quiet --collect --unit="$UNIT" -p Delegate=yes \
			-E PATH="$PATH" -E HOME="$HOME" -E XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-}" \
			"$RT/bin/dockerd-rootless.sh" --data-root "$RT/data"
	else
		setsid nohup "$RT/bin/dockerd-rootless.sh" --data-root "$RT/data" \
			>"$RT/dockerd.log" 2>&1 &
	fi
	for _ in $(seq 1 60); do
		daemon_up && return 0
		sleep 1
	done
	warn "Docker daemon did not come up."
	die "logs: journalctl --user -u $UNIT   (or $RT/dockerd.log)"
}

is_rootless() {
	docker info --format '{{json .SecurityOptions}}' 2>/dev/null | grep -q rootless
}

# ── Secrets and configuration ───────────────────────────────────────────────

db_password() {
	mkdir -p "$RT"
	if [ ! -s "$RT/db-password" ]; then
		head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$RT/db-password"
		chmod 600 "$RT/db-password"
	fi
	cat "$RT/db-password"
}

# The container's environment: your .env, with the four values that must
# match the container layout replaced rather than trusted.
write_app_env() {
	[ -f "$ROOT/.env" ] || die ".env not found. Create it first:  cp .env.example .env  (then edit it)"
	mkdir -p "$RT"
	{
		grep -vE '^(DATABASE_URL|WHATSAPP_AUTH_DIR|PORT|NODE_ENV)=' "$ROOT/.env" || true
		echo "NODE_ENV=production"
		echo "PORT=3100"
		echo "WHATSAPP_AUTH_DIR=/app/auth"
		echo "DATABASE_URL=postgres://phc:$(db_password)@$DB:5432/phc"
	} >"$RT/app.env"
	chmod 600 "$RT/app.env"
}

env_value() { grep -E "^$1=" "$ROOT/.env" 2>/dev/null | tail -1 | cut -d= -f2- || true; }

# Set KEY=VALUE in .env, replacing the existing line or appending one. Values
# go through the environment rather than the awk program, so no character in
# an API key can break the edit.
set_env() {
	local tmp="$ROOT/.env.tmp.$$"
	K="$1" V="$2" awk '
		BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; done = 0 }
		index($0, k "=") == 1 { if (!done) print k "=" v; done = 1; next }
		{ print }
		END { if (!done) print k "=" v }
	' "$ROOT/.env" >"$tmp"
	chmod 600 "$tmp"
	mv "$tmp" "$ROOT/.env"
}

# WhatsApp numbers: international format, digits only, comma-separated.
valid_numbers() { [[ "$1" =~ ^[0-9]{9,15}(,[0-9]{9,15})*$ ]]; }

# ── Checks ──────────────────────────────────────────────────────────────────

# Things every install needs, whatever Docker it ends up using.
check_machine() {
	local fatal=0 t missing=()
	if [ "$(uname -s)" = Linux ]; then ok "Linux $(uname -r)"; else problem "This needs Linux (found $(uname -s))."; fatal=1; fi
	if docker_arch >/dev/null; then ok "CPU: $(uname -m)"; else problem "Unsupported CPU $(uname -m): Docker is published for x86_64 and aarch64."; fatal=1; fi

	for t in curl tar awk sed grep od sha256sum find df git; do
		command -v "$t" >/dev/null 2>&1 || missing+=("$t")
	done
	if [ ${#missing[@]} -eq 0 ]; then
		ok "Tools: curl, git, tar and the rest are present"
	else
		problem "Missing tools: ${missing[*]} — an administrator installs them once:  sudo apt install ${missing[*]/sha256sum/coreutils}"
		fatal=1
	fi

	local free_kb mem_kb
	free_kb="$(df -Pk "$ROOT" | awk 'NR == 2 { print $4 }')"
	if [ "$free_kb" -lt 1048576 ]; then
		problem "Only $((free_kb / 1024)) MB of disk free here; the bot needs about 3 GB."
		fatal=1
	elif [ "$free_kb" -lt 3145728 ]; then
		note "Disk: $((free_kb / 1024)) MB free — enough, but tight (3 GB recommended)."
	else
		ok "Disk: $((free_kb / 1048576)) GB free"
	fi
	mem_kb="$(awk '/^MemTotal/ { print $2 }' /proc/meminfo 2>/dev/null || echo 0)"
	if [ "$mem_kb" -gt 0 ] && [ "$mem_kb" -lt 900000 ]; then
		note "Memory: $((mem_kb / 1024)) MB — under 1 GB; the first build may be slow."
	else
		ok "Memory: $((mem_kb / 1024)) MB"
	fi
	return $fatal
}

docker_arch() {
	case "$(uname -m)" in
		x86_64 | amd64) echo x86_64 ;;
		aarch64 | arm64) echo aarch64 ;;
		*) return 1 ;;
	esac
}

# What rootless Docker needs from the system. None of it can be done without
# an administrator, so each item says exactly what to run, once.
check_rootless() {
	local fatal=0 user uid runtime
	user="$(id -un)"
	uid="$(id -u)"
	if command -v newuidmap >/dev/null 2>&1 && command -v newgidmap >/dev/null 2>&1; then
		ok "uidmap tools present"
	else
		problem "newuidmap/newgidmap are missing — an administrator runs once:  sudo apt install uidmap"
		fatal=1
	fi
	if grep -qE "^($user|$uid):" /etc/subuid 2>/dev/null && grep -qE "^($user|$uid):" /etc/subgid 2>/dev/null; then
		ok "Subordinate user and group ranges for $user"
	else
		problem "No /etc/subuid or /etc/subgid range for $user — an administrator runs once:"
		warn "      sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $user"
		fatal=1
	fi
	if [ "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo 1)" = 0 ] ||
		[ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)" = 0 ]; then
		problem "User namespaces are switched off — an administrator runs once:"
		warn "      sudo sysctl -w kernel.unprivileged_userns_clone=1 user.max_user_namespaces=28633"
		fatal=1
	fi
	# Ubuntu 23.10+ blocks unprivileged user namespaces unless AppArmor allows
	# the specific program.
	if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ] &&
		! grep -rqsF "$RT/bin/rootlesskit" /etc/apparmor.d/ 2>/dev/null; then
		problem "AppArmor blocks rootless Docker on this system — an administrator runs once:"
		warn "      printf '%s\n' 'abi <abi/4.0>,' 'include <tunables/global>' '\"$RT/bin/rootlesskit\" flags=(unconfined) {' '  userns,' '}' | sudo tee /etc/apparmor.d/phc-rootlesskit"
		warn "      sudo systemctl reload apparmor"
		fatal=1
	fi
	runtime="${XDG_RUNTIME_DIR:-/run/user/$uid}"
	if [ -d "$runtime" ]; then
		ok "Login session has a runtime directory"
	else
		problem "No runtime directory ($runtime). Log in to this account directly over SSH, not through su or sudo."
		fatal=1
	fi
	return $fatal
}

# Something on the bot's port that is not this bot?
check_port() {
	if ! (exec 3<>"/dev/tcp/127.0.0.1/$PHC_PORT") 2>/dev/null; then
		ok "Port $PHC_PORT is free"
		return 0
	fi
	if exists "$APP" && running "$APP"; then
		ok "Port $PHC_PORT is this bot's"
		return 0
	fi
	if curl -s -m 3 "http://127.0.0.1:$PHC_PORT/health" 2>/dev/null | grep -q '"whatsapp"'; then
		problem "Another copy of this bot is already running on port $PHC_PORT (npm start, or a second folder?). Stop it first."
	else
		problem "Port $PHC_PORT is used by another program. Stop it, or pick another port:  PHC_PORT=3200 ./ctl.sh start"
	fi
	return 1
}

# ── Docker ──────────────────────────────────────────────────────────────────

install_local_docker() {
	local arch base p1 p2 tmp
	arch="$(docker_arch)" || die "no Docker build exists for CPU $(uname -m)."
	base="https://download.docker.com/linux/static/stable/$arch"
	curl -sS -o /dev/null -m 30 "$base/" || die "cannot reach download.docker.com; this step needs internet access."
	tmp="${RT:?}/tmp"
	mkdir -p "$RT/bin" "$tmp"
	note "Downloading Docker $DOCKER_VERSION ($arch) into .runtime/bin — about 90 MB, once."
	# Both at once, with generous timeouts: some networks throttle these hosts
	# per connection, and a short timeout fails a download that would finish.
	curl -fsSL --retry 3 --connect-timeout 30 -o "$tmp/docker.tgz" "$base/docker-$DOCKER_VERSION.tgz" &
	p1=$!
	curl -fsSL --retry 3 --connect-timeout 30 -o "$tmp/extras.tgz" "$base/docker-rootless-extras-$DOCKER_VERSION.tgz" &
	p2=$!
	if ! wait "$p1" || ! wait "$p2"; then
		rm -rf "${RT:?}/tmp"
		die "the Docker download failed. Check the connection and run ./ctl.sh start again."
	fi
	tar -xzf "$tmp/docker.tgz" -C "$tmp"
	tar -xzf "$tmp/extras.tgz" -C "$tmp"
	cp "$tmp/docker/"* "$RT/bin/"
	cp "$tmp/docker-rootless-extras/"* "$RT/bin/"
	rm -rf "${RT:?}/tmp"
	chmod +x "$RT/bin/"*
	ok "Installed $("$RT/bin/docker" --version)"
}

# A working Docker, by whatever route: the system's if it works, otherwise a
# private rootless copy in .runtime, downloaded on first use.
ensure_docker() {
	if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
		ok "Docker $(docker version -f '{{.Server.Version}}' 2>/dev/null) (installed on this machine)"
		return 0
	fi
	if command -v docker >/dev/null 2>&1 && [ ! -x "$RT/bin/dockerd-rootless.sh" ]; then
		note "Docker is installed here but $(id -un) cannot use it (stopped, or not in the docker group)."
		note "Using a private copy in this folder instead."
	fi
	check_rootless || die "Docker cannot run as $(id -un) until the items marked ✗ are fixed.
  Or install Docker system-wide instead: see docs/DEPLOY-VPS.md, Option A."
	[ -x "$RT/bin/dockerd-rootless.sh" ] || install_local_docker
	resolve_docker
	daemon_start
	ok "Docker $(docker version -f '{{.Server.Version}}' 2>/dev/null) (private rootless copy in .runtime)"
}

# ── Configuration ───────────────────────────────────────────────────────────

ask_admin_numbers() {
	local value current
	current="$(env_value ADMIN_NUMBERS)"
	valid_numbers "$current" || current=""
	say "  Admin numbers may run every command, including group moderation."
	while :; do
		value="$(ask "Admin WhatsApp number(s): country code first, digits only, e.g. 254712345678" "$current")"
		value="${value//[ +]/}"
		if valid_numbers "$value"; then
			set_env ADMIN_NUMBERS "$value"
			return 0
		fi
		say "  Not valid: digits only, 9 to 15 per number, country code first, commas between several."
	done
}

# The questions. Run on first start, or any time with ./ctl.sh setup.
run_setup() {
	interactive || die "setup asks questions, so run it in a terminal:  ./ctl.sh setup"
	if [ ! -f "$ROOT/.env" ]; then
		cp "$ROOT/.env.example" "$ROOT/.env"
		chmod 600 "$ROOT/.env"
	fi
	say ""
	say "  Press Enter to keep what is in [brackets]."
	say ""
	ask_admin_numbers

	local key hint tz
	say ""
	say "  AI assistant: .ask, and searching online when the sources find nothing."
	say "  It uses Google Gemini. Get a free key at https://aistudio.google.com/apikey"
	hint="Enter to skip"
	[ -n "$(env_value GEMINI_API_KEY)" ] && hint="Enter keeps the current key"
	key="$(ask_secret "Gemini API key ($hint; typing is hidden)")"
	if [ -n "$key" ]; then
		set_env GEMINI_API_KEY "$key"
		set_env AI_PROVIDER gemini
	fi

	say ""
	say "  Live web search: finds scholarships and fellowships online."
	say "  It uses Tavily. Get a free key at https://app.tavily.com"
	hint="Enter to skip"
	[ -n "$(env_value TAVILY_API_KEY)" ] && hint="Enter keeps the current key"
	key="$(ask_secret "Tavily API key ($hint; typing is hidden)")"
	if [ -n "$key" ]; then
		set_env TAVILY_API_KEY "$key"
		set_env WEB_SEARCH_PROVIDER tavily
	fi

	say ""
	tz="$(ask "Timezone for dates and deadlines" "$(env_value TIMEZONE)")"
	[ -n "$tz" ] && set_env TIMEZONE "$tz"
	say ""
	ok "Saved in .env (readable only by you). Change it any time with ./ctl.sh setup"
}

# Is the Gemini key real? One free request: list one model.
check_gemini_key() {
	local code
	# The key goes in a header read from a file descriptor, so it never
	# appears in a URL or in the process list.
	code="$(curl -s -o /dev/null -w '%{http_code}' -m 15 \
		-H @<(printf 'x-goog-api-key: %s\n' "$1") \
		'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1' 2>/dev/null || true)"
	case "$code" in
		200) ok "AI assistant: Gemini (Google accepted the key)" ;;
		400 | 401 | 403) problem "AI assistant: Google rejected GEMINI_API_KEY (HTTP $code). New key: https://aistudio.google.com/apikey, then ./ctl.sh setup" ;;
		000 | "") note "AI assistant: Gemini (could not reach Google to check the key)" ;;
		*) note "AI assistant: Gemini (the key check answered HTTP $code)" ;;
	esac
}

# What is switched on, so nobody wonders why .ask says the assistant is off.
report_features() {
	local provider key
	provider="$(env_value AI_PROVIDER)"
	provider="${provider:-gemini}"
	case "$provider" in
		none) note "AI assistant: off (AI_PROVIDER=none)" ;;
		gemini | anthropic | openai)
			key="$(env_value "${provider^^}_API_KEY")"
			if [ -z "$key" ]; then
				note "AI assistant: off — no ${provider^^}_API_KEY. A free Gemini key: https://aistudio.google.com/apikey, then ./ctl.sh setup"
			elif [ "$provider" = gemini ]; then
				check_gemini_key "$key"
			else
				ok "AI assistant: $provider"
			fi
			;;
		*) problem "AI_PROVIDER=$provider is not one of: gemini, anthropic, openai, none" ;;
	esac
	case "$(env_value WEB_SEARCH_PROVIDER)" in
		tavily)
			if [ -n "$(env_value TAVILY_API_KEY)" ]; then ok "Live web search: Tavily"; else note "Live web search: off — TAVILY_API_KEY is empty"; fi
			;;
		searxng)
			if [ -n "$(env_value SEARXNG_URL)" ]; then ok "Live web search: SearXNG"; else note "Live web search: off — SEARXNG_URL is empty"; fi
			;;
		*) note "Live web search: off. A free Tavily key (https://app.tavily.com) adds it: ./ctl.sh setup" ;;
	esac
	if [ "$(env_value PAIRING_PAGE)" = on ]; then note "PAIRING_PAGE=on puts the QR on a web page too. On a server, set it to off."; fi
	if [ -n "$(env_value WHATSAPP_PAIR_NUMBER)" ]; then note "Pairing with an 8-character code (WHATSAPP_PAIR_NUMBER is set), not a QR."; fi
	return 0
}

# A usable .env: created by the questions on first run, checked every run.
ensure_config() {
	if [ ! -f "$ROOT/.env" ]; then
		interactive || die ".env not found. Run this once in a terminal to answer the setup questions:  ./ctl.sh setup"
		note "First run: a few questions to create the configuration."
		run_setup
	fi
	chmod 600 "$ROOT/.env" 2>/dev/null || true

	local admins
	admins="$(env_value ADMIN_NUMBERS)"
	if ! valid_numbers "$admins"; then
		interactive || die "ADMIN_NUMBERS in .env is empty or not valid. Run:  ./ctl.sh setup"
		if [ -n "$admins" ]; then problem "ADMIN_NUMBERS in .env is not valid."; fi
		ask_admin_numbers
	fi
	ok "Admin numbers: $(env_value ADMIN_NUMBERS | tr ',' '\n' | grep -c .)"
	report_features
}

# The bot's own validation, run inside the image without starting anything:
# a typo in .env is reported here, not as a crash loop.
validate_config() {
	write_app_env
	local out
	if out="$(docker run --rm --network none --env-file "$RT/app.env" "$IMAGE" \
		node -e "import('/app/dist/config/env.js').then(() => process.exit(0))" 2>&1)"; then
		ok "Every setting in .env is valid"
		return 0
	fi
	printf '%s\n' "$out" | sed '/^[[:space:]]*$/d; s/^/    /' >&2
	problem "Some settings in .env are not valid (above)."
	return 1
}

# ── Source and image ────────────────────────────────────────────────────────

# Fingerprint of everything that goes into the image, so start knows when the
# code changed (after ./ctl.sh update, or an edit) and rebuilds only then.
source_hash() {
	(
		cd "$ROOT"
		{
			find src public views drizzle -type f -print0 | sort -z | xargs -0 sha256sum
			sha256sum Dockerfile .dockerignore package.json package-lock.json tsconfig.json
		} | sha256sum | cut -c1-16
	)
}

ensure_image() {
	local want have
	want="$(source_hash)"
	have="$(docker image inspect -f '{{index .Config.Labels "phc.source"}}' "$IMAGE" 2>/dev/null || true)"
	if [ -n "$have" ] && [ "$want" = "$have" ]; then
		ok "Bot image is up to date"
		return 0
	fi
	if docker image inspect "$IMAGE" >/dev/null 2>&1; then
		note "The code changed since the last build; rebuilding."
	else
		note "First build: downloads Node.js and the npm packages, so it takes a few minutes."
	fi
	build_image "$want"
	ok "Bot image built"
}

# ── Start after reboot ──────────────────────────────────────────────────────

AUTOSTART_SERVICE="$NAME-bot.service"
AUTOSTART_UNIT="$HOME/.config/systemd/user/$AUTOSTART_SERVICE"

autostart_enabled() { systemctl --user is-enabled "$AUTOSTART_SERVICE" >/dev/null 2>&1; }

autostart_on() {
	if ! systemctl --user show-environment >/dev/null 2>&1; then
		problem "No systemd user session here, so starting after a reboot cannot be set up."
		return 1
	fi
	mkdir -p "$(dirname "$AUTOSTART_UNIT")"
	cat >"$AUTOSTART_UNIT" <<EOF
[Unit]
Description=Public Health Colosseum bot ($ROOT)

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=PHC_NAME=$NAME PHC_PORT=$PHC_PORT PHC_BIND=$PHC_BIND
ExecStart="$ROOT/ctl.sh" start
ExecStop="$ROOT/ctl.sh" stop
TimeoutStartSec=1200

[Install]
WantedBy=default.target
EOF
	systemctl --user daemon-reload
	systemctl --user enable "$AUTOSTART_SERVICE" >/dev/null 2>&1
	rm -f "$RT/autostart-declined"
	if loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q '=yes' ||
		loginctl enable-linger "$(id -un)" >/dev/null 2>&1; then
		ok "Starts by itself after a reboot"
	else
		ok "Starts by itself when $(id -un) logs in"
		note "To start at boot with nobody logged in, an administrator runs once:  sudo loginctl enable-linger $(id -un)"
	fi
}

# System Docker brings the containers back by itself; the private copy needs
# a user service, offered once.
ensure_autostart() {
	if [ "$LOCAL_DOCKER" = 0 ]; then
		ok "Comes back after a reboot with Docker itself"
		return 0
	fi
	if autostart_enabled; then
		ok "Starts by itself after a reboot"
		return 0
	fi
	if ! interactive || [ -f "$RT/autostart-declined" ]; then
		note "Does not start after a reboot. Turn that on with:  ./ctl.sh autostart on"
		return 0
	fi
	if confirm "Start the bot by itself after a reboot? (adds one file under ~/.config/systemd/user)" y; then
		autostart_on || true
	else
		mkdir -p "$RT"
		touch "$RT/autostart-declined"
		note "Not set up. Turn it on later with:  ./ctl.sh autostart on"
	fi
}

# ── Lifecycle ───────────────────────────────────────────────────────────────

exists()  { docker container inspect "$1" >/dev/null 2>&1; }
running() { [ "$(docker container inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ]; }

# On an empty volume the PostgreSQL image starts a *temporary* server to
# initialise the database, which answers pg_isready, then shuts it down and
# starts the real one. Observed here: the temporary server accepted
# connections for about 230 ms. Polling readiness alone races that window, so
# first wait for the image's own marker that initialisation is over:
#   "init process complete"     — fresh volume, just initialised
#   "Skipping initialization"   — existing volume, no temporary server at all
wait_for_db() {
	local settled=0
	for _ in $(seq 1 120); do
		if docker logs "$DB" 2>&1 | grep -qE 'init process complete|Skipping initialization'; then
			settled=1
			break
		fi
		sleep 1
	done
	[ "$settled" = 1 ] || return 1
	for _ in $(seq 1 60); do
		docker exec "$DB" psql -U phc -d phc -tAc 'select 1' >/dev/null 2>&1 && return 0
		sleep 1
	done
	return 1
}


build_image() {
	local label="${1:-$(source_hash)}" rc
	mkdir -p "$RT"
	# Progress lines only; the full output goes to .runtime/build.log.
	set +e
	docker build --label "phc.source=$label" -t "$IMAGE" "$ROOT" 2>&1 |
		tee "$RT/build.log" |
		grep --line-buffered -E '^Step [0-9]+/[0-9]+ :|^#[0-9]+ \[' |
		cut -c1-90 | sed -u 's/^/    /'
	rc=${PIPESTATUS[0]}
	set -e
	if [ "$rc" != 0 ]; then
		tail -25 "$RT/build.log" | sed 's/^/    /' >&2
		die "the build failed (full log: .runtime/build.log)"
	fi
	# Superseded images of this bot are dead weight; nothing else is touched.
	docker image prune -f --filter "label=phc.source" >/dev/null 2>&1 || true
}

start_db() {
	docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
	if ! exists "$DB"; then
		note "Creating the database (first run)"
		docker run -d --name "$DB" --network "$NET" --restart unless-stopped \
			-e POSTGRES_USER=phc -e POSTGRES_DB=phc \
			-e POSTGRES_PASSWORD="$(db_password)" \
			-v "$DB_VOLUME":/var/lib/postgresql \
			"$DB_IMAGE" >/dev/null
	elif ! running "$DB"; then
		docker start "$DB" >/dev/null
	fi

	wait_for_db || die "database did not become ready (./ctl.sh logs-db)"

	# First start only: an empty database gets the full schema.
	local has_schema
	has_schema="$(docker exec "$DB" psql -U phc -d phc -tAc \
		"select to_regclass('public.opportunities') is not null" 2>/dev/null || echo f)"
	if [ "$has_schema" != "t" ]; then
		docker exec -i "$DB" psql -U phc -d phc -v ON_ERROR_STOP=1 -q <"$ROOT/drizzle/schema.sql" >/dev/null
		ok "Database schema created"
	fi
	ok "Database ready"
}



start_app() {
	write_app_env
	mkdir -p "$DATA/auth"
	local env_hash image_id
	env_hash="$(sha256sum "$RT/app.env" | cut -c1-16)"
	image_id="$(docker image inspect -f '{{.Id}}' "$IMAGE")"

	if exists "$APP"; then
		if running "$APP" &&
			[ "$(docker container inspect -f '{{.Image}}' "$APP")" = "$image_id" ] &&
			[ "$(docker container inspect -f '{{index .Config.Labels "phc.env"}}' "$APP")" = "$env_hash" ]; then
			ok "Bot already running with this code and these settings"
			return 0
		fi
		if running "$APP"; then note "Restarting the bot with the new code or settings (the WhatsApp session is kept)"; fi
		docker stop -t 20 "$APP" >/dev/null 2>&1 || true
		docker rm "$APP" >/dev/null
	fi

	# Rootless: container root IS your user and has no host privileges, so
	# files in data/auth stay owned by you. Rootful: run as your own uid for
	# the same result, rather than as real root.
	local run_as=()
	is_rootless || run_as=(--user "$(id -u):$(id -g)")

	docker run -d --name "$APP" --network "$NET" --restart unless-stopped \
		"${run_as[@]}" \
		--label "phc.env=$env_hash" \
		--env-file "$RT/app.env" \
		-v "$DATA/auth":/app/auth \
		-p "$PHC_BIND:$PHC_PORT:3100" \
		--log-opt max-size=10m --log-opt max-file=3 \
		"$IMAGE" >/dev/null
	ok "Bot started"
}

cmd_start() {
	STEPS=6
	say "Public Health Colosseum — setting up and starting everything in $ROOT"

	step "Checking this machine"
	check_machine || die "this machine is missing something the bot needs (marked ✗ above)."

	step "Docker"
	ensure_docker
	check_port || die "port $PHC_PORT is taken (see above)."

	step "Configuration"
	ensure_config

	step "Building the bot"
	ensure_image
	validate_config || die "fix the settings above in .env (or run ./ctl.sh setup), then run ./ctl.sh start again."

	step "Database"
	start_db

	step "Starting the bot"
	start_app
	ensure_autostart

	say ""
	cmd_status
	say ""
	pair_if_needed
}

# Every check start makes, and a few more, without changing anything.
cmd_doctor() {
	STEPS=4
	local failed=0
	say "Public Health Colosseum — checking $ROOT (nothing is changed)"

	step "This machine"
	check_machine || failed=1

	step "Docker"
	if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
		ok "Docker $(docker version -f '{{.Server.Version}}' 2>/dev/null) (installed on this machine)"
	else
		check_rootless || failed=1
		if [ -x "$RT/bin/dockerd-rootless.sh" ]; then
			resolve_docker
			if daemon_up; then ok "Private Docker copy is running"; else note "Private Docker copy installed; ./ctl.sh start starts it"; fi
		else
			note "No Docker yet; ./ctl.sh start downloads a private copy into .runtime"
		fi
	fi
	local docker_ok=0
	daemon_up 2>/dev/null && docker_ok=1
	if [ "$docker_ok" = 1 ]; then check_port || failed=1; fi

	step "Configuration"
	if [ -f "$ROOT/.env" ]; then
		if valid_numbers "$(env_value ADMIN_NUMBERS)"; then
			ok "Admin numbers: $(env_value ADMIN_NUMBERS | tr ',' '\n' | grep -c .)"
		else
			problem "ADMIN_NUMBERS is empty or not valid; ./ctl.sh setup fixes it"
			failed=1
		fi
		if [ "$(stat -c %a "$ROOT/.env")" = 600 ]; then ok ".env is readable only by you"; else note ".env is readable by others; ./ctl.sh start tightens it"; fi
		report_features
		if [ "$docker_ok" = 1 ] && docker image inspect "$IMAGE" >/dev/null 2>&1; then
			validate_config || failed=1
		fi
	else
		note "No .env yet; ./ctl.sh start asks the setup questions"
	fi

	step "Bot"
	if [ -d "$ROOT/.git" ] && git -C "$ROOT" fetch -q 2>/dev/null; then
		local behind
		behind="$(git -C "$ROOT" rev-list --count 'HEAD..@{upstream}' 2>/dev/null || echo 0)"
		if [ "$behind" -gt 0 ]; then note "$behind newer change(s) on GitHub; ./ctl.sh update installs them"; else ok "Up to date with GitHub"; fi
	fi
	if [ "$docker_ok" = 1 ]; then
		if [ "$(docker image inspect -f '{{index .Config.Labels "phc.source"}}' "$IMAGE" 2>/dev/null || true)" = "$(source_hash)" ]; then
			ok "Bot image matches the code"
		else
			note "Bot image is older than the code (or not built); ./ctl.sh start rebuilds it"
		fi
		cmd_status | sed 's/^/  /'
	fi
	if [ "$LOCAL_DOCKER" = 1 ]; then
		if autostart_enabled; then ok "Starts by itself after a reboot"; else note "Does not start after a reboot; ./ctl.sh autostart on"; fi
	fi

	say ""
	if [ "$failed" = 0 ]; then say "No problems found."; else say "Something needs attention: the items marked ✗ above."; fi
	return "$failed"
}

cmd_setup() {
	run_setup
	say ""
	say "Run ./ctl.sh start to apply it (the bot restarts only if something changed)."
}

cmd_autostart() {
	case "${1:-}" in
		on)
			resolve_docker
			if [ "$LOCAL_DOCKER" = 0 ]; then
				say "Docker is installed on this machine, and it brings the bot back after a reboot by itself."
				return 0
			fi
			autostart_on
			;;
		off)
			systemctl --user disable "$AUTOSTART_SERVICE" >/dev/null 2>&1 || true
			rm -f "$AUTOSTART_UNIT"
			systemctl --user daemon-reload 2>/dev/null || true
			mkdir -p "$RT"
			touch "$RT/autostart-declined"
			say "The bot will no longer start by itself after a reboot. (It keeps running now.)"
			;;
		*)
			if autostart_enabled; then say "Start after reboot: on"; else say "Start after reboot: off"; fi
			say "Change it with:  ./ctl.sh autostart on   or   ./ctl.sh autostart off"
			;;
	esac
}

# Fetch the latest code from GitHub, then do everything start does: rebuild
# only if the code changed, recreate the bot, keep the session and data.
cmd_update() {
	if [ -d "$ROOT/.git" ]; then
		say "Fetching the latest version from GitHub..."
		local before after
		before="$(git -C "$ROOT" rev-parse --short HEAD)"
		git -C "$ROOT" pull --ff-only --quiet ||
			die "could not update from GitHub. If you changed files here, see:  git -C \"$ROOT\" status"
		after="$(git -C "$ROOT" rev-parse --short HEAD)"
		if [ "$before" = "$after" ]; then
			say "Already the latest version ($after)."
		else
			say "Updated $before → $after:"
			git -C "$ROOT" log --oneline "$before..$after" | sed 's/^/  /'
		fi
	else
		say "This folder is not a git checkout, so there is nothing to pull; using the files here."
	fi
	# The new ctl.sh may differ from the one running now, so hand over to it.
	exec "$ROOT/ctl.sh" start
}

cmd_install_docker() {
	if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
		say "A working Docker is already installed on this machine; nothing to do."
		return 0
	fi
	check_rootless || warn "Rootless Docker will not run until the items marked ✗ are fixed."
	install_local_docker
	say "Next: ./ctl.sh start"
}

cmd_stop() {
	resolve_docker
	daemon_up || { say "Docker is not running; nothing to stop."; return 0; }
	# The bot first, so it can release its session lock and flush writes
	# before the database goes away.
	exists "$APP" && docker stop -t 20 "$APP" >/dev/null && say "Bot stopped."
	exists "$DB" && docker stop "$DB" >/dev/null && say "Database stopped."
	return 0
}

cmd_restart() {
	resolve_docker
	daemon_start
	exists "$APP" || die "bot container not found. Run: ./ctl.sh start"
	write_app_env
	# Recreate rather than restart, so changes to .env take effect.
	docker stop -t 20 "$APP" >/dev/null 2>&1 || true
	docker rm "$APP" >/dev/null
	start_app
	say "Restarted."
}

cmd_status() {
	resolve_docker
	if ! daemon_up; then say "Docker: not running"; return 0; fi
	local mode="system"
	[ "$LOCAL_DOCKER" = 1 ] && mode="folder-local rootless"
	is_rootless && [ "$LOCAL_DOCKER" = 0 ] && mode="system rootless"
	say "Docker:     running ($mode)"
	for c in "$DB" "$APP"; do
		if exists "$c"; then
			say "$(printf '%-11s %s' "$c:" "$(docker container inspect -f '{{.State.Status}}{{if .State.Health}} / {{.State.Health.Status}}{{end}}' "$c")")"
		else
			say "$(printf '%-11s %s' "$c:" 'not created')"
		fi
	done
	if running "$APP"; then
		case "$(wa_state_code)" in
			0) say "WhatsApp:   connected" ;;
			1) say "WhatsApp:   not paired — run ./ctl.sh pair" ;;
			*) say "WhatsApp:   starting..." ;;
		esac
	fi
}

cmd_logs() { resolve_docker; daemon_up || die "Docker is not running."; docker logs -f --tail 200 "$APP"; }
cmd_logs_db() { resolve_docker; docker logs --tail 100 "$DB"; }

# WhatsApp state from the bot's /health: 0 paired, 1 waiting for a scan,
# 2 not answering yet (still starting).
wa_state() {
	local health
	health="$(curl -s -m 5 "http://127.0.0.1:$PHC_PORT/health" 2>/dev/null || true)"
	case "$health" in
		*'"connected"'*) return 0 ;;
		*disconnected*)  return 1 ;;
		*)               return 2 ;;
	esac
}
wa_state_code() { if wa_state; then echo 0; else echo $?; fi; }

# Draw the bot's QR codes here as it issues them, until WhatsApp connects.
# The QR never goes near a web page: it is read from the container's own
# output, on this server, by whoever is logged in to it.
show_qr() {
	say "Waiting for the QR code... (Ctrl-C stops this view; the bot keeps running)"
	local line logpid next_check=0
	# The last minute of output too, so a code issued just before this ran
	# appears at once instead of after the next rotation.
	exec 3< <(docker logs -f --since 60s "$APP" 2>&1)
	logpid=$!
	trap 'kill "$logpid" 2>/dev/null; exec 3<&-; say ""; exit 130' INT TERM

	while :; do
		if IFS= read -r -t 2 line <&3; then
			case "$line" in
				*'scan the QR code'*)
					# A new code replaces the old one: clear, so only the live code shows.
					[ -t 1 ] && printf '\033[2J\033[H'
					say "Scan with WhatsApp > Settings > Linked devices > Link a device."
					say "A new code appears about every 20 seconds; scan the newest."
					say "" ;;
				*'enter this pairing code'*)
					say "Pairing code: $(printf '%s' "$line" | sed -n 's/.*"code":"\([^"]*\)".*/\1/p')"
					say "Enter it in WhatsApp > Linked devices > Link with phone number." ;;
				*'WhatsApp connected'*)
					break ;;
				*)
					# QR rows are made of block characters and spaces only.
					if [ -n "$line" ] && [ -z "${line//[█▀▄ ]/}" ]; then printf '%s\n' "$line"; fi ;;
			esac
		elif [ $? -le 128 ]; then
			# Not a timeout: the log ended, so the bot stopped.
			exec 3<&-
			trap - INT TERM
			die "the bot stopped while pairing. See: ./ctl.sh logs"
		fi
		if [ "$SECONDS" -ge "$next_check" ]; then
			next_check=$((SECONDS + 3))
			wa_state && break
		fi
	done

	kill "$logpid" 2>/dev/null || true
	exec 3<&-
	trap - INT TERM
	say ""
	say "WhatsApp connected. Send .ping to the bot to check it answers."
}

# After a start: pair right here when WhatsApp needs it, like `npm start` does.
pair_if_needed() {
	if [ ! -t 1 ]; then
		say "Next: ./ctl.sh pair   — shows the QR code to scan with WhatsApp."
		return 0
	fi
	local state=2
	for _ in $(seq 1 30); do
		state="$(wa_state_code)"
		[ "$state" != 2 ] && break
		sleep 2
	done
	case "$state" in
		0) say "WhatsApp is connected." ;;
		1) show_qr ;;
		*) say "The bot is still starting. Run ./ctl.sh pair in a moment to show the QR code." ;;
	esac
}

cmd_pair() {
	resolve_docker
	daemon_up || die "Docker is not running. Run: ./ctl.sh start"
	running "$APP" || die "the bot is not running. Run: ./ctl.sh start"
	case "$(wa_state_code)" in
		0) say "WhatsApp is already paired. To link a different number: ./ctl.sh reset-session" ;;
		*) show_qr ;;
	esac
}


cmd_backup() {
	resolve_docker
	daemon_up || die "Docker is not running."
	running "$DB" || die "database is not running. Run: ./ctl.sh start"
	local stamp dir
	stamp="$(date +%Y%m%d-%H%M%S)"
	dir="$ROOT/backups"
	mkdir -p "$dir"
	docker exec "$DB" pg_dump -U phc -d phc --no-owner >"$dir/db-$stamp.sql"
	tar -czf "$dir/session-$stamp.tgz" -C "$DATA" auth
	chmod 600 "$dir/db-$stamp.sql" "$dir/session-$stamp.tgz"
	say "Backed up to backups/:"
	say "  db-$stamp.sql"
	say "  session-$stamp.tgz   (a credential — keep it private)"
}

cmd_reset_session() {
	resolve_docker
	say "This deletes the WhatsApp session. The bot will need pairing again."
	printf 'Type yes to continue: '
	read -r answer
	[ "$answer" = "yes" ] || { say "Cancelled."; return 0; }
	exists "$APP" && { docker stop -t 20 "$APP" >/dev/null 2>&1 || true; docker rm "$APP" >/dev/null; }
	# Contents only: the directory is the bind-mount target.
	find "$DATA/auth" -mindepth 1 -delete 2>/dev/null || true
	daemon_start
	start_app
	say "Session cleared."
	pair_if_needed
}


cmd_uninstall() {
	resolve_docker
	daemon_start
	say "This removes the containers, the image and the DATABASE volume."
	say "data/auth (the WhatsApp session) is kept. Take a backup first if unsure."
	printf 'Type yes to continue: '
	read -r answer
	[ "$answer" = "yes" ] || { say "Cancelled."; return 0; }
	for c in "$APP" "$DB"; do exists "$c" && docker rm -f "$c" >/dev/null; done
	docker volume rm "$DB_VOLUME" >/dev/null 2>&1 || true
	docker network rm "$NET" >/dev/null 2>&1 || true
	docker image rm "$IMAGE" >/dev/null 2>&1 || true
	say "Removed."
}

usage() { awk 'NR > 2 && /^#/ { sub(/^# ?/, ""); print; next } NR > 2 { exit }' "$0"; }

case "${1:-}" in
	start)          cmd_start ;;
	doctor)         cmd_doctor ;;
	setup)          cmd_setup ;;
	autostart)      cmd_autostart "${2:-}" ;;
	stop)           cmd_stop ;;
	restart)        cmd_restart ;;
	status)         cmd_status ;;
	logs)           cmd_logs ;;
	logs-db)        cmd_logs_db ;;
	pair)           cmd_pair ;;
	update)         cmd_update ;;
	backup)         cmd_backup ;;
	reset-session)  cmd_reset_session ;;
	install-docker) cmd_install_docker ;;
	uninstall)      cmd_uninstall ;;
	*)              usage; exit 1 ;;
esac
