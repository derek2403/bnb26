#!/usr/bin/env bash
# Local always-on keeper for BSC testnet 97 (no Docker image needed; Postgres runs in the `splitstock-pg` container).
#   bash services/scripts/keeper-97.sh start    start in the background (logs: services/logs/keeper-97.log)
#   bash services/scripts/keeper-97.sh stop     stop it
#   bash services/scripts/keeper-97.sh status   pid + last log lines
#   bash services/scripts/keeper-97.sh api-start|api-stop   the read API on :8080 (/events, /risk, /agent; the app
#                                                proxies to it). It signs nothing, so it may run beside the keeper.
# FLAP_DISPATCH=false bash ... start             keeper without the Flap tax dispatch (leave it to a person on camera)
# Postgres:  docker start splitstock-pg   (first time: see docs/DEPLOYED.md for the docker run line)
# Keys come from ./.env. With only KEEPER_PRIVATE_KEY set, KEY_FALLBACK=keeper makes it sign every testnet role.
# Never commit .env; nothing here prints a key.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="$ROOT/services/logs"
PID_FILE="$LOG_DIR/keeper-97.pid"
LOG_FILE="$LOG_DIR/keeper-97.log"
JOBS="${KEEPER_JOBS:-mirror,cmc,risk,rebalance,accrue,backstop,openfour,indexer,anchor}"
API_PID="$LOG_DIR/api-97.pid"
API_LOG="$LOG_DIR/api-97.log"
# eth_getLogs for the indexer: the bnbchain data-seed RPC rejects it ("limit exceeded"); publicnode allows
# 2000-block ranges with up to 10 addresses per call (INDEXER_MAX_ADDRESSES).
LOGS_RPC_DEFAULT="https://bsc-testnet-rpc.publicnode.com"
mkdir -p "$LOG_DIR"

running() { [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

case "${1:-status}" in
  start)
    if running; then echo "keeper already running (pid $(cat "$PID_FILE"))"; exit 0; fi
    cd "$ROOT/services"
    (
      set -a; [ -f "$ROOT/.env" ] && . "$ROOT/.env"; set +a
      export KEY_FALLBACK="${KEY_FALLBACK_OVERRIDE:-keeper}" MAINNET_ENABLED="${MAINNET_ENABLED:-false}" \
        DATABASE_URL="${DATABASE_URL:-postgres://splitstock:splitstock@localhost:5432/splitstock}" DB_DISABLED=false \
        BSC_TESTNET_LOGS_RPC="${BSC_TESTNET_LOGS_RPC:-$LOGS_RPC_DEFAULT}"
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
  api-start)
    if [ -f "$API_PID" ] && kill -0 "$(cat "$API_PID")" 2>/dev/null; then echo "api already running (pid $(cat "$API_PID"))"; exit 0; fi
    cd "$ROOT/services"
    (
      set -a; [ -f "$ROOT/.env" ] && . "$ROOT/.env"; set +a
      export KEY_FALLBACK=none MAINNET_ENABLED=false DB_DISABLED=false \
        DATABASE_URL="${DATABASE_URL:-postgres://splitstock:splitstock@localhost:5432/splitstock}"
      nohup npx tsx src/cli.ts api >>"$API_LOG" 2>&1 &
      echo $! >"$API_PID"
    )
    echo "api started (pid $(cat "$API_PID")), log $API_LOG"
    ;;
  api-stop)
    if [ -f "$API_PID" ]; then kill -TERM "$(cat "$API_PID")" 2>/dev/null || true; rm -f "$API_PID"; fi
    pkill -TERM -f "src/cli.ts api" 2>/dev/null || true
    echo "api stopped"
    ;;
  *) echo "usage: $0 start|stop|status|api-start|api-stop"; exit 1 ;;
esac
