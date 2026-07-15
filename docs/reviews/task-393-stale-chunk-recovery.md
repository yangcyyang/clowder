# Task 393 stale-build recovery review evidence

## Scope and commits

This review covers the stale-chunk and build-version recovery chain implemented by these exact prerequisite commits:

- `d13e7f6` — `feat(web): expose stable build version`
- `a37dbec` — `fix(web): recover stale chunks before hydration`
- `7034763` — `fix(web): read inherited chunk rejection reasons`
- `6b1949e` — `feat(web): reload safely on build changes`
- `53e88d5` — `fix(web): expose escaped build version route`

The deterministic acceptance harness and this evidence are delivered together by the Task 4 commit with subject
`test(web): verify stale build recovery`.

## Deterministic harness evidence

Initial RED:

```text
$ node --test packages/web/test/stale-build-recovery-harness.test.mjs
Could not find 'packages/web/test/stale-build-recovery-harness.test.mjs'
```

GREEN command:

```bash
pnpm --dir packages/web test:stale-build-recovery
```

Result: 4 tests passed. The Node harness starts a same-origin HTTP build-id fixture and invokes bundled production
contracts from `web-build-version.ts` and `chunk-load-recovery.ts`; it does not copy the recovery decision logic.
It emits JSON evidence with `source=product-recovery` and verifies:

- A→B without a draft: one navigation; a repeated B target stays at one navigation.
- Three B-side HTTP 503 probes: zero navigation.
- B→C with a text draft: zero navigation before the prompt action, one after it.
- No browser-automation hard-refresh escape hatch is present in the harness.

The real React guard suites continue to own component lifecycle, persistent prompt, BroadcastChannel, cleanup order,
and manual-action control-flow coverage.

## Local gate

All commands ran from worktree commit `53e88d5` plus the four Task 4 delivery files:

```bash
pnpm --dir packages/web exec vitest run \
  src/utils/__tests__/web-build-version.test.ts \
  src/utils/__tests__/chunk-load-recovery.test.ts \
  src/utils/__tests__/chunk-load-bootstrap.test.ts \
  src/components/__tests__/chunk-load-bootstrap-layout.test.ts \
  src/components/__tests__/chunk-load-refresh-guard.test.tsx \
  src/components/__tests__/global-error.test.tsx
pnpm --dir packages/web test:stale-build-recovery
pnpm --dir packages/web test:ci:config
pnpm --dir packages/web lint
CLOWDER_WEB_BUILD_ID=task393-local-b pnpm --dir packages/web build
test "$(cat packages/web/.next/BUILD_ID)" = task393-local-b
git diff --check
```

Results:

- focused recovery Vitest: 6 files, 28 tests passed;
- deterministic Node harness: 4 tests passed;
- Web config/security Node tests: 13 tests passed;
- lint: exit 0; warnings only (existing hook/image warnings and Tasks 1–3 recovery UI color-token warnings);
- production build: exit 0; generated `.next/BUILD_ID` is `task393-local-b`.

The production endpoint was tested without touching live port 3003 or PM2. A temporary server was started from this
worktree on `127.0.0.1:5103`, then stopped after the probe:

```text
HTTP/1.1 200 OK
cache-control: no-store, max-age=0
pragma: no-cache
content-type: application/json

{"buildId":"task393-local-b"}
```

## Service worker contract

Service-worker registration is preserved. Recovery calls `registration.update()` on existing registrations and clears
stale Cache Storage entries; it never unregisters the service worker.

## Known first-deploy limitation

Tabs opened from a build that predates this recovery feature do not contain the new bootstrap or hydrated guard. The
first rollout of the feature can therefore still require one manual refresh for those already-open legacy tabs. After
a tab has loaded a build containing this feature, later A→B and B→C deployments use the automatic/draft-safe path.

## Required live deployment acceptance

These steps are intentionally deferred until an approved deployment; the local harness does not mutate live state.

1. **A→B without a draft**
   - Open a tab on deployed build A and leave it focused with no pending text, image, or file draft.
   - Deploy build B without manually refreshing the old tab.
   - Confirm the old tab probes `/_clowder/build-id`, performs exactly one product-originated navigation, and renders B.
   - Keep the tab open through repeated probes and confirm no reload loop.
2. **Draft-protected B→C**
   - On deployed build B, enter unsent text in a thread and keep the tab open.
   - Deploy build C.
   - Confirm the draft remains intact, no automatic navigation occurs, and the persistent recovery dialog is shown.
   - Save the draft, choose **保存好草稿并刷新**, and confirm exactly one navigation to C.
3. In both cases, confirm the build-id response is network-only/no-store and the existing service-worker registration
   remains registered.
