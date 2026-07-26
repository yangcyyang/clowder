#!/usr/bin/env bash
# A5 (batch 4-A): process hygiene tests for with-test-home.sh and
# run-isolated-redis-tests.sh — the two test-runner wrapper scripts identified
# as spawning (and, before this batch, leaking) processes.
#
# Real incident (07-26): a test-spawned api instance was orphaned into a
# persistent process; two instances ran for 1-2 days, eating a full core +
# 26GB swap combined. Root cause (see batch report for the empirical proof):
# with-test-home.sh used `exec "$@"` with `trap cleanup EXIT` — exec REPLACES
# the shell process, so the registered EXIT trap NEVER fires for ANY exit
# path. That silently leaked the temp $HOME dir on every invocation and, more
# importantly, left no supervising shell alive to reap the wrapped command's
# own orphaned children.
#
# Run: bash packages/api/scripts/test-hygiene.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
FAILURES=0

pass() { echo "PASS: $1"; }
fail() {
  echo "FAIL: $1"
  FAILURES=$((FAILURES + 1))
}

# ── with-test-home.sh: exit code passthrough ──

out="$(bash "$SCRIPT_DIR/with-test-home.sh" bash -c 'exit 0')"
status=$?
[[ "$status" -eq 0 ]] && pass "with-test-home.sh: success exit code (0) passes through" \
  || fail "with-test-home.sh: expected exit 0, got $status"

bash "$SCRIPT_DIR/with-test-home.sh" bash -c 'exit 7' >/dev/null 2>&1
status=$?
[[ "$status" -eq 7 ]] && pass "with-test-home.sh: failure exit code (7) passes through" \
  || fail "with-test-home.sh: expected exit 7, got $status"

# ── with-test-home.sh: the temp $HOME sandbox is actually cleaned up ──
# (this used to leak on EVERY invocation — see module doc's `exec` finding)

tmp_parent="${TMPDIR:-/tmp}"
tmp_parent="${tmp_parent%/}"
before_count=$(find "$tmp_parent" -maxdepth 1 -name "cat-cafe-test-home-*" 2>/dev/null | wc -l | tr -d ' ')
bash "$SCRIPT_DIR/with-test-home.sh" bash -c 'exit 0' >/dev/null 2>&1
after_count=$(find "$tmp_parent" -maxdepth 1 -name "cat-cafe-test-home-*" 2>/dev/null | wc -l | tr -d ' ')
[[ "$after_count" -eq "$before_count" ]] && pass "with-test-home.sh: temp \$HOME sandbox removed after exit (no net leak)" \
  || fail "with-test-home.sh: temp \$HOME sandbox count grew from $before_count to $after_count"

# ── with-test-home.sh: A-AC4 — abnormal exit (SIGTERM) leaves no residual process,
#    including a process detached via double-fork (subshell exits before its own
#    backgrounded job finishes, re-parenting the job to init) ──

pidfile="$(mktemp -t hygiene-test-pid.XXXXXX)"
cmdfile="$(mktemp -t hygiene-test-cmd.XXXXXX.sh)"
cat > "$cmdfile" << SCRIPT
#!/usr/bin/env bash
( sleep 250 & echo \$! > "$pidfile" )
sleep 250
SCRIPT
chmod +x "$cmdfile"

bash "$SCRIPT_DIR/with-test-home.sh" "$cmdfile" &
wrapper_pid=$!
for _ in $(seq 1 20); do
  [[ -s "$pidfile" ]] && break
  sleep 0.1
done
detached_pid="$(cat "$pidfile" 2>/dev/null || echo "")"

if [[ -z "$detached_pid" ]]; then
  fail "with-test-home.sh: could not observe the simulated detached child (test setup issue)"
else
  kill -TERM "$wrapper_pid" 2>/dev/null || true
  # Give cleanup a moment to run its TERM→sleep→KILL escalation.
  for _ in $(seq 1 20); do
    kill -0 "$detached_pid" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$detached_pid" 2>/dev/null; then
    fail "with-test-home.sh: A-AC4 — detached (double-fork) descendant pid=$detached_pid survived SIGTERM to the wrapper"
    kill -9 "$detached_pid" 2>/dev/null || true
  else
    pass "with-test-home.sh: A-AC4 — detached (double-fork) descendant correctly reaped on SIGTERM to the wrapper"
  fi
fi
wait "$wrapper_pid" 2>/dev/null
rm -f "$pidfile" "$cmdfile"

# ── run-isolated-redis-tests.sh: exit code + redis lifecycle + timeout kill ──

if command -v redis-server >/dev/null 2>&1; then
  out="$(bash "$SCRIPT_DIR/run-isolated-redis-tests.sh" bash -c 'echo "$REDIS_URL"' 2>&1)"
  status=$?
  [[ "$status" -eq 0 ]] && echo "$out" | grep -q "redis://127.0.0.1:" \
    && pass "run-isolated-redis-tests.sh: success exit + REDIS_URL exported to the wrapped command" \
    || fail "run-isolated-redis-tests.sh: expected exit 0 with a REDIS_URL, got status=$status output=[$out]"

  redis_count_before=$(pgrep -f "redis-server.*cat-cafe-redis-test" 2>/dev/null | wc -l | tr -d ' ')

  cmdfile2="$(mktemp -t hygiene-test-cmd2.XXXXXX.sh)"
  cat > "$cmdfile2" << 'SCRIPT2'
#!/usr/bin/env bash
( sleep 250 & )
sleep 250
SCRIPT2
  chmod +x "$cmdfile2"

  timeout_out="$(CAT_CAFE_REDIS_TEST_TIMEOUT_SECS=2 bash "$SCRIPT_DIR/run-isolated-redis-tests.sh" "$cmdfile2" 2>&1)"
  timeout_status=$?
  sleep 1
  [[ "$timeout_status" -ne 0 ]] && pass "run-isolated-redis-tests.sh: A-AC4 — internal timeout kills a hung command (non-zero exit)" \
    || fail "run-isolated-redis-tests.sh: timeout run unexpectedly exited 0"

  echo "$timeout_out" | grep -q "residual process" \
    && fail "run-isolated-redis-tests.sh: A-AC4 — script itself reported a residual process (see output above)" \
    || pass "run-isolated-redis-tests.sh: A-AC4 — no residual-process assertion failure reported"

  redis_count_after=$(pgrep -f "redis-server.*cat-cafe-redis-test" 2>/dev/null | wc -l | tr -d ' ')
  [[ "$redis_count_after" -eq "$redis_count_before" ]] && pass "run-isolated-redis-tests.sh: isolated redis-server instance cleaned up (no net growth)" \
    || fail "run-isolated-redis-tests.sh: isolated redis-server count grew from $redis_count_before to $redis_count_after"

  rm -f "$cmdfile2"
else
  echo "SKIP: redis-server not found — skipping run-isolated-redis-tests.sh checks"
fi

echo ""
if [[ "$FAILURES" -eq 0 ]]; then
  echo "test-hygiene.test.sh: all checks passed"
  exit 0
else
  echo "test-hygiene.test.sh: $FAILURES check(s) FAILED"
  exit 1
fi
