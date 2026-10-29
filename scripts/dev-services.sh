#!/usr/bin/env bash
#
# Local development services — PostgreSQL and Redis, without root.
#
# Both run as the current user out of .devservices/, on non-default ports, so
# they cannot collide with (or disturb) a system-wide installation. Nothing
# here needs sudo and nothing is installed system-wide.
#
#   ./scripts/dev-services.sh start     start both, create the database
#   ./scripts/dev-services.sh stop      stop both
#   ./scripts/dev-services.sh status    show what is running
#   ./scripts/dev-services.sh destroy   stop and delete all local data
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$ROOT/.devservices"
PG_DIR="$DATA_DIR/postgres"
PG_LOG="$DATA_DIR/postgres.log"
REDIS_LOG="$DATA_DIR/redis.log"
REDIS_PID="$DATA_DIR/redis.pid"

PG_PORT="${PG_PORT:-55432}"
REDIS_PORT="${REDIS_PORT:-56379}"
DB_NAME="${DB_NAME:-phc}"

# Debian/Ubuntu keep the server binaries off PATH; find them.
find_pg_bin() {
  if command -v pg_ctl >/dev/null 2>&1; then
    dirname "$(command -v pg_ctl)"
    return
  fi
  local candidate
  # Debian layout is /usr/lib/postgresql/<major>/bin/pg_ctl; take the newest major.
  candidate="$(find /usr/lib/postgresql -maxdepth 3 -name pg_ctl -type f 2>/dev/null | sort -V | tail -1)"
  if [ -n "$candidate" ]; then
    dirname "$candidate"
    return
  fi
  echo "ERROR: could not find pg_ctl. Install PostgreSQL (e.g. apt install postgresql)." >&2
  exit 1
}

PG_BIN="$(find_pg_bin)"

start_postgres() {
  mkdir -p "$DATA_DIR"

  if [ ! -d "$PG_DIR/base" ]; then
    echo "→ initialising PostgreSQL cluster in $PG_DIR"
    "$PG_BIN/initdb" -D "$PG_DIR" -U "$USER" --auth=trust >/dev/null
  fi

  if "$PG_BIN/pg_ctl" -D "$PG_DIR" status >/dev/null 2>&1; then
    echo "→ PostgreSQL already running on port $PG_PORT"
  else
    echo "→ starting PostgreSQL on port $PG_PORT"
    # Unix socket in the data dir keeps it off the system socket path.
    "$PG_BIN/pg_ctl" -D "$PG_DIR" -l "$PG_LOG" \
      -o "-p $PG_PORT -k $PG_DIR -c listen_addresses=127.0.0.1" start >/dev/null
  fi

  # pg_ctl returns before the server accepts connections.
  for _ in $(seq 1 30); do
    if "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PG_PORT" >/dev/null 2>&1; then break; fi
    sleep 0.5
  done

  if ! "$PG_BIN/psql" -h 127.0.0.1 -p "$PG_PORT" -lqt | cut -d'|' -f1 | grep -qw "$DB_NAME"; then
    echo "→ creating database $DB_NAME"
    "$PG_BIN/createdb" -h 127.0.0.1 -p "$PG_PORT" "$DB_NAME"
  fi

  echo "   DATABASE_URL=postgres://127.0.0.1:$PG_PORT/$DB_NAME"
}

start_redis() {
  if ! command -v redis-server >/dev/null 2>&1; then
    echo "→ redis-server not installed; skipping (only needed from Phase 2 onward)"
    return
  fi
  if [ -f "$REDIS_PID" ] && kill -0 "$(cat "$REDIS_PID")" 2>/dev/null; then
    echo "→ Redis already running on port $REDIS_PORT"
    return
  fi
  echo "→ starting Redis on port $REDIS_PORT"
  redis-server --port "$REDIS_PORT" --bind 127.0.0.1 --daemonize yes \
    --dir "$DATA_DIR" --pidfile "$REDIS_PID" --logfile "$REDIS_LOG" --save ''
  echo "   REDIS_URL=redis://127.0.0.1:$REDIS_PORT"
}

stop_postgres() {
  if "$PG_BIN/pg_ctl" -D "$PG_DIR" status >/dev/null 2>&1; then
    echo "→ stopping PostgreSQL"
    "$PG_BIN/pg_ctl" -D "$PG_DIR" -m fast stop >/dev/null
  else
    echo "→ PostgreSQL not running"
  fi
}

stop_redis() {
  if [ -f "$REDIS_PID" ] && kill -0 "$(cat "$REDIS_PID")" 2>/dev/null; then
    echo "→ stopping Redis"
    kill "$(cat "$REDIS_PID")"
    rm -f "$REDIS_PID"
  else
    echo "→ Redis not running"
  fi
}

case "${1:-start}" in
  start)
    start_postgres
    start_redis
    echo
    echo "Ready. Next: npm run db:push"
    ;;
  stop)
    stop_redis
    stop_postgres
    ;;
  status)
    "$PG_BIN/pg_ctl" -D "$PG_DIR" status || true
    if [ -f "$REDIS_PID" ] && kill -0 "$(cat "$REDIS_PID")" 2>/dev/null; then
      echo "Redis running (pid $(cat "$REDIS_PID")) on port $REDIS_PORT"
    else
      echo "Redis not running"
    fi
    ;;
  destroy)
    stop_redis
    stop_postgres
    echo "→ deleting $DATA_DIR"
    rm -rf "$DATA_DIR"
    ;;
  *)
    echo "usage: $0 {start|stop|status|destroy}" >&2
    exit 1
    ;;
esac
