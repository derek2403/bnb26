#!/usr/bin/env bash
# Local always-on keeper for BSC testnet 97 (no Docker image needed; Postgres runs in the `splitstock-pg` container).
#   bash services/scripts/keeper-97.sh start    start in the background (logs: services/logs/keeper-97.log)
#   bash services/scripts/keeper-97.sh stop     stop it
#   bash services/scripts/keeper-97.sh status   pid + last log lines
# Postgres:  docker start splitstock-pg   (first time: see docs/DEPLOYED.md for the docker run line)
# Keys come from ./.env. With only KEEPER_PRIVATE_KEY set, KEY_FALLBACK=keeper makes it sign every testnet role.
# Never commit .env; nothing here prints a key.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="$ROOT/services/logs"
PID_FILE="$LOG_DIR/keeper-97.pid"
LOG_FILE="$LOG_DIR/keeper-97.log"
JOBS="${KEEPER_JOBS:-mirror,cmc,risk,rebalance,accrue,backstop,openfour}"
mkdir -p "$LOG_DIR"

running() { [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

case "${1:-status}" in
  start)
    if running; then echo "keeper already running (pid $(cat "$PID_FILE"))"; exit 0; fi
    cd "$ROOT/services"
    (
      set -a; [ -f "$ROOT/.env" ] && . "$ROOT/.env"; set +a
      export KEY_FALLBACK="${KEY_FALLBACK_OVERRIDE:-keeper}" MAINNET_ENABLED="${MAINNET_ENABLED:-false}" \
        DATABASE_URL="${DATABASE_URL:-postgres://splitstock:splitstock@localhost:5432/splitstock}" DB_DISABLED=false
      nohup npx tsx src/cli.ts keeper run --jobs "$JOBS" >>"$LOG_FILE" 2>&1 &
      echo $! >"$PID_FILE"
    )
    echo "keeper started (pid $(cat "$PID_FILE")), jobs $JOBS, log $LOG_FILE"
    ;;
  stop)
    if running; then
      pid="$(cat "$PID_FILE")"
      kill -TERM "$pid" 2>/dev/null || true
      pkill -TERM -f "src/cli.ts keeper run" 2>/dev/null || true
      rm -f "$PID_FILE"; echo "keeper stopped"
    else
      echo "keeper not running"; rm -f "$PID_FILE"
    fi
    ;;
  status)
    if running; then echo "running (pid $(cat "$PID_FILE"))"; else echo "not running"; fi
    [ -f "$LOG_FILE" ] && tail -n 20 "$LOG_FILE" || true
    ;;
  *) echo "usage: $0 start|stop|status"; exit 1 ;;
esac
