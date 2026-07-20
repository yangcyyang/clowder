#!/usr/bin/env bash
# Fail-closed runner for the redis-backed SECURITY test suites.
#
# Why this exists (F-3): redis-authorization-stores.test.js and
# redis-capability-receipt-store.test.js skip ENTIRELY ("REDIS_URL not set")
# in any default invocation, and `node --test` still exits 0 — a CI green that
# never exercised the redis security stores. This runner makes that impossible:
#   1. Preflight: refuses to start without REDIS_URL + CAT_CAFE_REDIS_TEST_ISOLATED=1.
#   2. Runs each suite SERIALLY — the suites share redis DB 15, parallel runs
#      false-red on each other's keys.
#   3. After every suite, scripts/assert-tests-ran.sh parses the TAP summary and
#      fails loudly when zero tests ran or anything was skipped.
#
# Intended entrypoint (spins up the isolated redis for you):
#   pnpm --filter @cat-cafe/api run test:redis:security
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

SUITES=(
  "test/redis-authorization-stores.test.js"
  "test/redis-capability-receipt-store.test.js"
)

echo "[redis-security] fail-closed redis security suites runner"

if [[ -z "${REDIS_URL:-}" || "${CAT_CAFE_REDIS_TEST_ISOLATED:-}" != "1" ]]; then
  echo "" >&2
  echo "================================================================" >&2
  echo "[redis-security] FAIL-CLOSED PREFLIGHT: REDIS_URL and" >&2
  echo "CAT_CAFE_REDIS_TEST_ISOLATED=1 are both required. Without them the" >&2
  echo "security suites SKIP SILENTLY and node --test still exits 0." >&2
  echo "Run via: pnpm --filter @cat-cafe/api run test:redis:security" >&2
  echo "================================================================" >&2
  exit 1
fi

cd "$API_DIR"

LOG_DIR="$(mktemp -d -t cat-cafe-redis-security.XXXXXX)"
cleanup() {
  rm -rf "$LOG_DIR"
}
trap cleanup EXIT INT TERM

OVERALL_STATUS=0

for SUITE in "${SUITES[@]}"; do
  LOG_FILE="${LOG_DIR}/$(basename "$SUITE" .test.js).log"
  echo "[redis-security] running ${SUITE} (serial)"
  set +e
  CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 \
    bash scripts/with-test-home.sh \
    node --import ./test/helpers/setup-cat-registry.js --test --test-timeout=60000 "$SUITE" 2>&1 | tee "$LOG_FILE"
  NODE_STATUS=${PIPESTATUS[0]}
  set -e

  if [[ "$NODE_STATUS" -ne 0 ]]; then
    echo "[redis-security] node --test exited ${NODE_STATUS} for ${SUITE}" >&2
    OVERALL_STATUS=1
    continue
  fi

  if ! bash "${SCRIPT_DIR}/assert-tests-ran.sh" "$SUITE" "$LOG_FILE"; then
    OVERALL_STATUS=1
  fi
done

if [[ "$OVERALL_STATUS" -ne 0 ]]; then
  echo "[redis-security] FAILED — see guard output above" >&2
  exit 1
fi

echo "[redis-security] PASS — all ${#SUITES[@]} redis security suites ran real tests, zero skips"
