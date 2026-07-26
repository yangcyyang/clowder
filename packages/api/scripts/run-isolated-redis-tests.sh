#!/usr/bin/env bash
set -euo pipefail
# A5 (batch 4-A): monitor mode — makes the wrapped CMD its own process-group
# leader, so a descendant that gets re-parented to init (double-fork detach)
# is still killable via its pgid even after `pgrep -P` can no longer find it
# as a descendant. See run_with_timeout/cleanup below and the batch report
# for the empirical verification.
set -m

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

REPEAT=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repeat)
      if [[ $# -lt 2 ]]; then
        echo "[redis-test] --repeat requires a positive integer" >&2
        exit 2
      fi
      REPEAT="$2"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done

if ! [[ "$REPEAT" =~ ^[1-9][0-9]*$ ]]; then
  echo "[redis-test] invalid --repeat value: $REPEAT" >&2
  exit 2
fi

if ! command -v redis-server >/dev/null 2>&1; then
  echo "[redis-test] redis-server not found. Install Redis first." >&2
  exit 127
fi

CMD=("pnpm" "test")
if [[ $# -gt 0 ]]; then
  CMD=("$@")
fi

# A5 (batch 4-A test process hygiene): the wrapped CMD previously ran directly in the
# foreground with NO bound on how long it could run and NO tracking of its own
# descendant processes — only redis-server (tracked via PIDFILE) was ever cleaned up.
# A hung/leaked CMD (or a descendant it forgot to reap) would run forever, exactly the
# shape of the 07-26 incident (a test-spawned api instance orphaned into a persistent
# process, two instances eating a full core + 26GB swap for 1-2 days). Fixed:
#   1. CMD now runs under an internal timeout watchdog (default 600s, overridable via
#      CAT_CAFE_REDIS_TEST_TIMEOUT_SECS) that SIGTERMs then SIGKILLs its full process
#      tree (not just its own pid) if it runs too long.
#   2. cleanup() (already trapped on EXIT/INT/TERM) now ALSO reaps that same tree on
#      every exit path, not only redis-server.
#   3. After every run, assert no descendant of the CMD we just ran survives — a
#      failed assertion is a hygiene test FAILURE (non-zero exit), not a silently
#      ignored best-effort.
TIMEOUT_SECS="${CAT_CAFE_REDIS_TEST_TIMEOUT_SECS:-600}"
if ! [[ "$TIMEOUT_SECS" =~ ^[1-9][0-9]*$ ]]; then
  echo "[redis-test] invalid CAT_CAFE_REDIS_TEST_TIMEOUT_SECS: $TIMEOUT_SECS" >&2
  exit 2
fi

DATADIR="$(mktemp -d -t cat-cafe-redis-test.XXXXXX)"
PIDFILE="${DATADIR}/redis.pid"
LOGFILE="${DATADIR}/redis.log"

# Set by run_with_timeout while a CMD invocation is in flight, so cleanup() (which
# can fire mid-run on INT/TERM) knows what else to reap besides redis-server.
CURRENT_CMD_PID=""
HYGIENE_FAILED=0

kill_tree() {
  local pid="$1"
  local sig="$2"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$child" "$sig"
  done
  kill "-${sig}" "$pid" 2>/dev/null || true
}

# Runs "$@" under a timeout, tracking it in CURRENT_CMD_PID so cleanup() can reap it
# from a signal handler too. Returns the command's real exit status (or 124 on
# self-inflicted timeout kill, matching the conventional `timeout(1)` exit code).
run_with_timeout() {
  local timeout_secs="$1"
  shift
  "$@" &
  local pid=$!
  CURRENT_CMD_PID="$pid"

  (
    sleep "$timeout_secs"
    if kill -0 "$pid" 2>/dev/null; then
      echo "[redis-test] command exceeded ${timeout_secs}s timeout — killing pid ${pid} and its process tree" >&2
      kill_tree "$pid" TERM
      kill -TERM -- "-$pid" 2>/dev/null || true
      sleep 0.2
      kill_tree "$pid" KILL
      kill -KILL -- "-$pid" 2>/dev/null || true
    fi
  ) &
  local watchdog_pid=$!

  local status=0
  wait "$pid" || status=$?
  # Command finished (or was just killed by the watchdog) — stop the watchdog itself.
  # A5 correctness note (found via testing, not just reasoning): a plain
  # `kill "$watchdog_pid"` only kills the watchdog subshell process — its OWN
  # `sleep "$timeout_secs"` child (still normally parented at this point) survives
  # as a fresh orphan and keeps running for the rest of the timeout window. Must
  # use kill_tree here too, exactly like the CMD it was watching.
  kill_tree "$watchdog_pid" TERM
  wait "$watchdog_pid" 2>/dev/null || true

  # A5: assert no residual descendant of this specific CMD invocation survives.
  # Two checks: `pgrep -P` (ordinary still-parented descendants) and the
  # process-group (catches a double-fork-detached descendant re-parented to
  # init, which `pgrep -P` can no longer see — see module doc top of file).
  sleep 0.1
  local leftover leftover_pgrp
  leftover="$(pgrep -P "$pid" 2>/dev/null || true)"
  leftover_pgrp="$(pgrep -g "$pid" 2>/dev/null | grep -v "^${pid}$" || true)"
  if [[ -n "$leftover" || -n "$leftover_pgrp" ]]; then
    echo "[redis-test] residual process(es) survived cleanup under pid ${pid}: children=[${leftover}] process-group=[${leftover_pgrp}]" >&2
    HYGIENE_FAILED=1
  fi
  CURRENT_CMD_PID=""
  return "$status"
}

cleanup() {
  set +e
  if [[ -n "$CURRENT_CMD_PID" ]] && kill -0 "$CURRENT_CMD_PID" 2>/dev/null; then
    kill_tree "$CURRENT_CMD_PID" TERM
    kill -TERM -- "-$CURRENT_CMD_PID" 2>/dev/null || true
    sleep 0.2
    kill_tree "$CURRENT_CMD_PID" KILL
    kill -KILL -- "-$CURRENT_CMD_PID" 2>/dev/null || true
  fi
  if [[ -f "$PIDFILE" ]]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    /bin/rm -f "$PIDFILE"
  fi
  /bin/rm -rf "$DATADIR"
}

trap cleanup EXIT INT TERM

PORT="${REDIS_TEST_PORT:-}"
if [[ -z "$PORT" ]]; then
  for _ in $(seq 1 30); do
    CANDIDATE="$((6300 + RANDOM % 700))"
    if redis-server \
      --port "$CANDIDATE" \
      --dir "$DATADIR" \
      --dbfilename dump.rdb \
      --save "" \
      --appendonly no \
      --daemonize yes \
      --pidfile "$PIDFILE" \
      --logfile "$LOGFILE" >/dev/null 2>&1; then
      PORT="$CANDIDATE"
      break
    fi
  done
else
  redis-server \
    --port "$PORT" \
    --dir "$DATADIR" \
    --dbfilename dump.rdb \
    --save "" \
    --appendonly no \
    --daemonize yes \
    --pidfile "$PIDFILE" \
    --logfile "$LOGFILE"
fi

if [[ -z "$PORT" ]]; then
  echo "[redis-test] failed to allocate an isolated redis port" >&2
  if [[ -f "$LOGFILE" ]]; then
    echo "[redis-test] redis log:" >&2
    cat "$LOGFILE" >&2
  fi
  exit 1
fi

if command -v redis-cli >/dev/null 2>&1; then
  READY=0
  for _ in $(seq 1 50); do
    if redis-cli -h 127.0.0.1 -p "$PORT" ping >/dev/null 2>&1; then
      READY=1
      break
    fi
    sleep 0.1
  done
  if [[ "$READY" -ne 1 ]]; then
    echo "[redis-test] redis failed to become ready on port ${PORT}" >&2
    if [[ -f "$LOGFILE" ]]; then
      echo "[redis-test] redis log:" >&2
      cat "$LOGFILE" >&2
    fi
    exit 1
  fi
else
  sleep 0.2
fi

export REDIS_URL="redis://127.0.0.1:${PORT}/15"
export CAT_CAFE_REDIS_TEST_ISOLATED=1

cd "$API_DIR"

echo "[redis-test] isolated redis started: ${REDIS_URL}"
OVERALL_STATUS=0
for RUN in $(seq 1 "$REPEAT"); do
  echo "[redis-test] run ${RUN}/${REPEAT}: ${CMD[*]} (timeout ${TIMEOUT_SECS}s)"
  set +e
  run_with_timeout "$TIMEOUT_SECS" "${CMD[@]}"
  RUN_STATUS=$?
  set -e
  if [[ "$RUN_STATUS" -ne 0 ]]; then
    OVERALL_STATUS="$RUN_STATUS"
  fi
done

if [[ "$HYGIENE_FAILED" -ne 0 ]]; then
  echo "[redis-test] FAILED — a residual process survived cleanup (see above); treating as a test failure" >&2
  exit 1
fi

exit "$OVERALL_STATUS"
