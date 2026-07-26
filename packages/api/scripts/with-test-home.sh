#!/usr/bin/env bash
set -euo pipefail

real_home="${HOME:-}"
tmp_parent="${TMPDIR:-/tmp}"
tmp_parent="${tmp_parent%/}"
raw_test_home="$(mktemp -d "${tmp_parent}/cat-cafe-test-home-XXXXXX")"
test_home="$(cd "$raw_test_home" && pwd -P)"

export HOME="$test_home"
export CAT_CAFE_TEST_SANDBOX="${CAT_CAFE_TEST_SANDBOX:-1}"
export CAT_CAFE_TEST_REAL_HOME="${CAT_CAFE_TEST_REAL_HOME:-$real_home}"
# Test entrypoints must not inherit a production NODE_ENV from the outer shell.
# Telemetry redaction tests rely on test-mode defaults instead of production secrets.
export NODE_ENV="test"
# Default-cat routing assertions must not inherit a developer's persisted choice
# from the repo .env (for example DEFAULT_CAT_ID=gpt52). Tests that exercise a
# different default still set process.env.DEFAULT_CAT_ID explicitly in-process.
export DEFAULT_CAT_ID="opus"

# Runtime-only envs leak from invocation env (set by the running cat-cafe-runtime
# process when launching a cat). resolveBinaryRoot()/orchestrator code treats
# CAT_CAFE_RUNTIME_ROOT as the highest-priority binary root override, which makes
# capabilities/MCP-path tests assert against `cat-cafe-runtime/...` instead of the
# stable main repo root. Strip them so test runs see the same environment whether
# launched from a runtime invocation or a clean shell.
unset CAT_CAFE_RUNTIME_ROOT
unset CAT_CAFE_MCP_SERVER_PATH
unset CAT_CAFE_WORKSPACE_ROOT

# A5 (batch 4-A test process hygiene): this used to be `exec "$@"` with
# `trap cleanup EXIT`. Verified empirically (see batch report): `exec` REPLACES
# this shell process with the wrapped command, so the EXIT trap registered on
# the shell that no longer exists NEVER fires — for ANY exit path (normal,
# error, or signal). That silently leaked the temp $HOME directory on every
# single invocation, and — the more serious half — left no supervising shell
# alive to reap the wrapped command's OWN children if the command itself got
# killed abnormally (SIGTERM/timeout) mid-run: exactly the shape of the 07-26
# incident (a test-spawned api instance orphaned into a persistent process,
# two instances eating a full core + 26GB swap for 1-2 days).
#
# Fixed: run the command as a tracked background job so this shell survives
# to run cleanup on every exit path, and kill the command's FULL process tree
# before exiting. A residual process surviving SIGKILL is treated as a
# hygiene test failure (non-zero exit), not a silently-ignored best-effort
# cleanup.
#
# Two complementary sweeps, because either one alone has a gap:
#   - `pgrep -P` tree-walk: catches ordinary descendants (e.g. a Node child
#     server spawned via child_process.spawn without `detached`) as long as
#     they are still parented when we walk — the realistic shape in this
#     repo's tests, verified directly against a real spawned-child scenario.
#   - Process-group kill (`kill -- -PID`): `set -m` below makes the wrapped
#     command its own process group leader. A descendant that gets
#     RE-PARENTED to init (e.g. an intermediate shell/subshell that exits
#     before its own backgrounded job finishes — a double-fork detach) keeps
#     its ORIGINAL process group even after re-parenting, so `pgrep -P` can
#     no longer find it but a process-group-wide kill still can. Verified
#     empirically (see batch report) — reparented processes are invisible to
#     `pgrep -P` but still killable via their pgid.
set -m

FINAL_EXIT_CODE=1 # pessimistic default — overwritten once the wrapped command's real result is known
CMD_PID=""

kill_tree() {
  local pid="$1"
  local sig="$2"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$child" "$sig"
  done
  kill "-${sig}" "$pid" 2>/dev/null || true
}

cleanup() {
  set +e
  if [[ -n "$CMD_PID" ]]; then
    if kill -0 "$CMD_PID" 2>/dev/null; then
      kill_tree "$CMD_PID" TERM
      kill -TERM -- "-$CMD_PID" 2>/dev/null || true
      sleep 0.2
    fi
    if kill -0 "$CMD_PID" 2>/dev/null; then
      kill_tree "$CMD_PID" KILL
      kill -KILL -- "-$CMD_PID" 2>/dev/null || true
      sleep 0.1
    fi
    # A5: assert no residual process this script started survives cleanup —
    # a failed assertion here IS the point (surface the leak loudly instead
    # of silently ignoring it), not a nice-to-have.
    if kill -0 "$CMD_PID" 2>/dev/null; then
      echo "[with-test-home] residual process pid=${CMD_PID} survived SIGKILL during cleanup" >&2
      FINAL_EXIT_CODE=1
    fi
  fi
  rm -rf "$raw_test_home"
  exit "$FINAL_EXIT_CODE"
}
trap cleanup EXIT INT TERM

"$@" &
CMD_PID=$!
if wait "$CMD_PID"; then
  FINAL_EXIT_CODE=0
else
  FINAL_EXIT_CODE=$?
fi
