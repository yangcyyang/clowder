---
feature_ids: [ci-test-lanes]
topics: [testing, ci, api]
doc_kind: guide
created: 2026-07-15
---
# API test lanes

API tests are discovered recursively from `packages/api/test/**/*.test.js`. An untagged file belongs to the
`core` lane, so new deterministic tests enter the required CI lane by default.

## File tag

Tests that cannot run in the core lane must declare exactly one marker in the first 12 lines:

```js
// @ci-tier redis reason="requires an isolated Redis server"
```

Allowed tiers are `core`, `redis`, `integration`, `slow`, `local-os`, and `external`. Tagged files require a
non-empty reason. Unknown tiers, duplicate markers, and malformed or reasonless markers fail closed.

Do not tag a test merely because it currently fails. Fix deterministic tests and keep them in `core`. If one file
mixes core and environment-dependent suites, split it before tagging so core coverage is not lost.

## Commands

```bash
# Build dependencies and run the required core lane.
pnpm --filter @cat-cafe/api test:ci

# Inspect deterministic selections without running tests.
pnpm --filter @cat-cafe/api test:lane:contracts
pnpm --filter @cat-cafe/api test:lane:list --tier core
pnpm --filter @cat-cafe/api test:lane:json --tier redis

# Run one lane against existing build artifacts.
pnpm --filter @cat-cafe/api test:lane:core
pnpm --filter @cat-cafe/api test:lane:redis
pnpm --filter @cat-cafe/api test:lane:integration
pnpm --filter @cat-cafe/api test:lane:slow
pnpm --filter @cat-cafe/api test:lane:local-os

# External tests require an explicit opt-in.
RUN_EXTERNAL_TESTS=1 pnpm --filter @cat-cafe/api test:lane:external
```

The runner requires Node.js 20 or newer, enters `scripts/with-test-home.sh`, imports the deterministic cat registry,
and passes an explicit sorted file list to `node:test`. Core defaults to one worker and a 120-second per-test timeout.
The `redis` lane additionally routes that exact command through `scripts/run-isolated-redis-tests.sh -- ...`; it starts
an ephemeral Redis database and refuses to run when `redis-server` is unavailable rather than silently skipping tests.

GitHub CI requires the `core`, `redis`, `integration`, and `slow` lanes. `local-os` is reserved for tests that require
host-specific executables, permissions, or filesystem behavior. `external` is opt-in for upstream fixtures or services
that are intentionally absent from the public checkout; `RUN_EXTERNAL_TESTS=1` acknowledges that dependency but does
not turn missing dependencies into skips.

Lane scripts intentionally do not infer classifications from paths or names. A separate migration must add tags only
after each excluded test has been audited.
