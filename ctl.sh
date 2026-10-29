#!/usr/bin/env bash
#
# Public Health Colosseum — control script.
#
# Runs the bot and its PostgreSQL database as two containers. Everything the
# bot owns lives under this folder: the WhatsApp session (data/auth), generated
# secrets and, when no system Docker is available, the Docker binaries
# themselves (.runtime/bin) running rootless as your own user — no sudo.
#
#   ./ctl.sh start            build if needed, start database and bot
#   ./ctl.sh stop             stop both
#   ./ctl.sh restart          restart the bot (keeps session and data)
#   ./ctl.sh status           what is running, and is WhatsApp connected
#   ./ctl.sh logs             follow the bot's log
#   ./ctl.sh pair             show the WhatsApp QR code here, in the terminal
#   ./ctl.sh update           rebuild from source and restart (keeps session)
#   ./ctl.sh backup           database dump + WhatsApp session, timestamped
#   ./ctl.sh reset-session    delete the WhatsApp session and pair again
#   ./ctl.sh install-docker   fetch rootless Docker into .runtime (no sudo)
#   ./ctl.sh uninstall        remove containers, image and database volume
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RT="$ROOT/.runtime"
DATA="$ROOT/data"
UNIT="phc-dockerd"

DOCKER_VERSION="${DOCKER_VERSION:-29.8.2}"
IMAGE="phc-platform:latest"
NET="phc-net"
DB="phc-db"
APP="phc-app"
DB_VOLUME="phc-pgdata"
DB_IMAGE="postgres:18"

# Where the bot listens on the host. 127.0.0.1 keeps it off the public
# internet; reach it through an SSH tunnel or a reverse proxy. Set
# PHC_BIND=0.0.0.0 only if you put HTTPS in front of it.
PHC_BIND="${PHC_BIND:-127.0.0.1}"
PHC_PORT="${PHC_PORT:-3100}"

cd "$ROOT"

say()  { printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }
die()  { warn "Error: $*"; exit 1; }

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
	say "Building image (first build downloads Node and npm packages; this can take a while)..."
	docker build -t "$IMAGE" "$ROOT"
}

start_db() {
	docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
	if ! exists "$DB"; then
		say "Creating database container..."
		docker run -d --name "$DB" --network "$NET" --restart unless-stopped \
			-e POSTGRES_USER=phc -e POSTGRES_DB=phc \
			-e POSTGRES_PASSWORD="$(db_password)" \
			-v "$DB_VOLUME":/var/lib/postgresql \
			"$DB_IMAGE" >/dev/null
	elif ! running "$DB"; then
		docker start "$DB" >/dev/null
	fi

	say "Waiting for the database..."
	wait_for_db || die "database did not become ready (./ctl.sh logs-db)"

	# First start only: an empty database gets the full schema.
	local has_schema
	has_schema="$(docker exec "$DB" psql -U phc -d phc -tAc \
		"select to_regclass('public.opportunities') is not null" 2>/dev/null || echo f)"
	if [ "$has_schema" != "t" ]; then
		say "Applying schema..."
		docker exec -i "$DB" psql -U phc -d phc -v ON_ERROR_STOP=1 -q <"$ROOT/drizzle/schema.sql" >/dev/null
		say "Schema applied."
	fi
}

start_app() {
	write_app_env
	mkdir -p "$DATA/auth"

	if exists "$APP"; then
		running "$APP" && { say "Bot already running."; return 0; }
		docker rm "$APP" >/dev/null
	fi

	# Rootless: container root IS your user and has no host privileges, so
	# files in data/auth stay owned by you. Rootful: run as your own uid for
	# the same result, rather than as real root.
	local run_as=()
	is_rootless || run_as=(--user "$(id -u):$(id -g)")

	say "Starting bot..."
	docker run -d --name "$APP" --network "$NET" --restart unless-stopped \
		"${run_as[@]}" \
		--env-file "$RT/app.env" \
		-v "$DATA/auth":/app/auth \
		-p "$PHC_BIND:$PHC_PORT:3100" \
		--log-opt max-size=10m --log-opt max-file=3 \
		"$IMAGE" >/dev/null
}

cmd_start() {
	resolve_docker
	daemon_start
	docker image inspect "$IMAGE" >/dev/null 2>&1 || build_image
	start_db
	start_app
	say ""
	cmd_status
	say ""
	pair_if_needed
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

cmd_update() {
	resolve_docker
	daemon_start
	build_image
	if exists "$APP"; then
		docker stop -t 20 "$APP" >/dev/null 2>&1 || true
		docker rm "$APP" >/dev/null
	fi
	start_db
	start_app
	say "Updated. The WhatsApp session in data/auth was kept."
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

cmd_install_docker() {
	if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
		say "A working Docker is already installed on this machine; nothing to do."
		return 0
	fi
	command -v newuidmap >/dev/null 2>&1 || warn "Warning: newuidmap not found. Rootless Docker needs the 'uidmap' package
  (on Debian/Ubuntu an administrator runs: apt install uidmap). Continuing anyway."
	mkdir -p "$RT/bin" "$RT/tmp"
	local base="https://download.docker.com/linux/static/stable/x86_64"
	say "Downloading Docker $DOCKER_VERSION (rootless) into .runtime/bin ..."
	# Long timeouts on purpose: some networks throttle these hosts heavily.
	curl -fL --retry 3 --connect-timeout 30 -o "$RT/tmp/docker.tgz" "$base/docker-$DOCKER_VERSION.tgz" &
	curl -fL --retry 3 --connect-timeout 30 -o "$RT/tmp/extras.tgz" "$base/docker-rootless-extras-$DOCKER_VERSION.tgz" &
	wait
	tar -xzf "$RT/tmp/docker.tgz" -C "$RT/tmp"
	tar -xzf "$RT/tmp/extras.tgz" -C "$RT/tmp"
	cp "$RT/tmp/docker/"* "$RT/bin/"
	cp "$RT/tmp/docker-rootless-extras/"* "$RT/bin/"
	rm -rf "$RT/tmp"
	chmod +x "$RT/bin/"*
	say "Installed: $("$RT/bin/docker" --version)"
	say "Next: ./ctl.sh start"
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

usage() { sed -n '3,22p' "$0" | sed 's/^# \{0,1\}//'; }

case "${1:-}" in
	start)          cmd_start ;;
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
