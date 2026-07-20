#!/usr/bin/env bash
# Zero-tests-ran sentinel for node --test output (fail-closed).
#
# Usage: assert-tests-ran.sh <suite-label> <log-file>
#
# Parses the top-level TAP summary of a `node --test` run and exits 1 LOUDLY
# when the suite did not actually execute any test:
#   - no summary block at all (runner died before reporting)
#   - # fail > 0
#   - # pass == 0  (e.g. every suite skipped via `{ skip: ... }` — this is how
#     redis-backed suites silently masquerade as green when REDIS_URL is unset)
#   - # skipped > 0 (security suites must not skip anything once isolated)
#
# Only unindented `# <key> <n>` lines are considered, so per-subtest nested
# summaries cannot confuse the parse.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "[assert-tests-ran] usage: $0 <suite-label> <log-file>" >&2
  exit 2
fi

LABEL="$1"
LOG_FILE="$2"

fail_loud() {
  echo "" >&2
  echo "================================================================" >&2
  echo "[assert-tests-ran] FAIL-CLOSED GUARD TRIGGERED: ${LABEL}" >&2
  echo "[assert-tests-ran] $1" >&2
  echo "================================================================" >&2
  exit 1
}

if [[ ! -s "$LOG_FILE" ]]; then
  fail_loud "log file '${LOG_FILE}' is missing or empty — the test runner produced no output"
fi

summary_value() {
  # Last top-level `# <key> <n>` value; empty when absent.
  awk -v key="$1" '$0 ~ "^# " key " [0-9]+$" { value = $3 } END { if (value != "") print value }' "$LOG_FILE"
}

TESTS="$(summary_value tests)"
PASS="$(summary_value pass)"
FAIL="$(summary_value fail)"
SKIPPED="$(summary_value skipped)"
CANCELLED="$(summary_value cancelled)"

if [[ -z "$TESTS" || -z "$PASS" || -z "$FAIL" ]]; then
  fail_loud "no node --test TAP summary found in output — runner died before reporting"
fi

if [[ "$FAIL" -gt 0 ]]; then
  fail_loud "${FAIL} test(s) failed"
fi

if [[ "$PASS" -eq 0 ]]; then
  fail_loud "ZERO TESTS RAN (tests=${TESTS} pass=0 skipped=${SKIPPED:-0}) — silent skip detected; refusing to report green. Redis-backed suites require an isolated REDIS_URL + CAT_CAFE_REDIS_TEST_ISOLATED=1 (run via: pnpm --filter @cat-cafe/api run test:redis:security)"
fi

if [[ "${SKIPPED:-0}" -gt 0 || "${CANCELLED:-0}" -gt 0 ]]; then
  fail_loud "suite partially skipped/cancelled (skipped=${SKIPPED:-0} cancelled=${CANCELLED:-0}) — security suites must run in full"
fi

echo "[assert-tests-ran] OK: ${LABEL} ran ${PASS}/${TESTS} tests, 0 failed, 0 skipped"
