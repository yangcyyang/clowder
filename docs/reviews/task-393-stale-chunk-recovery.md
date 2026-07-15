# Task 393 stale-build recovery review evidence

## Scope and commits

This review covers the stale-chunk and build-version recovery chain implemented by these exact prerequisite commits:

- `d13e7f6` — `feat(web): expose stable build version`
- `a37dbec` — `fix(web): recover stale chunks before hydration`
- `7034763` — `fix(web): read inherited chunk rejection reasons`
- `6b1949e` — `feat(web): reload safely on build changes`
- `53e88d5` — `fix(web): expose escaped build version route`
- `f653750` — `test(web): verify stale build recovery`
- `99732a9` — `fix(web): share stale build recovery controller`
- `b0a834b` — `test(web): lock stale recovery review regressions`

Independent review of the first Task 4 harness found two Important gaps: it duplicated the Guard's recovery branches,
and its escape-hatch check scanned only the automation module, not the test driver. Commit `99732a9` closes those
verification gaps with a shared production controller and a two-file TypeScript-AST scanner.

## Deterministic harness evidence

Initial RED:

```text
$ node --test packages/web/test/stale-build-recovery-harness.test.mjs
Could not find 'packages/web/test/stale-build-recovery-harness.test.mjs'
```

Important-fix RED:

```text
SyntaxError: verify-stale-build-recovery.mjs does not provide scanAutomationEscapeHatches
Error: Failed to resolve import "../build-recovery-controller"
```

The first failure proved that the scanner did not cover the test driver. The second locked the missing shared
production controller before implementation.

GREEN command:

```bash
pnpm --dir packages/web test:stale-build-recovery
```

Result: 6 tests passed. The Node harness starts a same-origin HTTP build-id fixture and invokes the bundled production
`build-recovery-controller.ts`, `web-build-version.ts`, and `chunk-load-recovery.ts` contracts. The React Guard invokes
the same controller for probe results, BroadcastChannel/chunk requests, and the manual prompt action. The harness no
longer implements build comparison, failure capping, reservation, prompt, announce, or reload decisions itself.
It emits JSON evidence with `source=product-recovery` and verifies:

- A is first probed as the matching build, then the fixture switches A→B: one controller-emitted navigation; a
  repeated B target stays at one navigation.
- B is first probed successfully, then three 503 probes cap failures; the fourth attempt sends no HTTP. Attention
  resets the cap and permits a new probe.
- B is first probed as matching, then the fixture switches B→C with a text draft: zero navigation before the
  controller's manual prompt action, one after it.
- The real `prepareBrowserForReload` updates the existing service worker and clears the stale cache before the
  controller-emitted navigation callback.
- A TypeScript AST scanner checks exactly the Task 4 automation module and test driver. Negative fixtures cover direct,
  optional, computed, and optional-computed `page`/`location` reload calls plus Cmd/Meta hard-refresh shortcuts.

The real React guard suites continue to own component lifecycle, persistent prompt, BroadcastChannel, cleanup order,
and manual-action control-flow coverage.

The final whole-branch review also locked same-origin resource filtering, a persistent per-tab attempted-target ledger,
storage-denial safety, StrictMode prompt continuity, finite probe timeout, and standard CI wiring with RED tests before
their implementation. The deterministic harness is now part of both `test:ci` and the required GitHub Web Native and
Config job rather than an opt-in local-only script.

Final-review RED evidence:

```text
focused Vitest: 3 files failed; 8 failed / 21 passed
deterministic harness: CI wiring assertion failed; 1 failed / 6 passed
```

Those failures independently exercised cross-origin resource rejection, B→C→B page reconstruction, legacy storage
migration, storage getter denial, StrictMode effect reconstruction, a hung probe timeout, and standard CI registration.

## Local gate

The final remediation gate ran from the committed recovery chain through the whole-branch review fixes:

```bash
pnpm --dir packages/web exec vitest run \
  src/utils/__tests__/web-build-version.test.ts \
  src/utils/__tests__/chunk-load-recovery.test.ts \
  src/utils/__tests__/chunk-load-bootstrap.test.ts \
  src/utils/__tests__/build-recovery-controller.test.ts \
  src/components/__tests__/chunk-load-bootstrap-layout.test.ts \
  src/components/__tests__/chunk-load-refresh-guard.test.tsx \
  src/components/__tests__/global-error.test.tsx
pnpm --dir packages/web test:stale-build-recovery
pnpm --dir packages/web test:ci:config
pnpm --dir packages/web lint
CLOWDER_WEB_BUILD_ID=task393-review-fixes pnpm --dir packages/web build
test "$(cat packages/web/.next/BUILD_ID)" = task393-review-fixes
git diff --check
```

Results:

- focused recovery Vitest: 7 files, 38 tests passed;
- deterministic Node harness: 7 tests passed, including package/GitHub CI wiring;
- Web config/security Node tests: 13 tests passed;
- Biome on all changed code/tests/config: clean;
- lint: exit 0; warnings only (existing hook/image warnings and Tasks 1–3 recovery UI color-token warnings);
- production build: exit 0; generated `.next/BUILD_ID` is `task393-review-fixes`.

The production endpoint was tested without touching live port 3003 or PM2. A temporary server was started from this
worktree on `127.0.0.1:5106`, then stopped after the probe:

```text
HTTP/1.1 200 OK
cache-control: no-store, max-age=0
pragma: no-cache
content-type: application/json

{"buildId":"task393-review-fixes"}
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
   - On deployed build B, enter unsent text in a thread, attach a small image, and keep the tab open.
   - Deploy build C.
   - Confirm the text and image attachment remain intact, no automatic navigation occurs, and the persistent recovery
     dialog is shown.
   - Save the draft, choose **保存好草稿并刷新**, and confirm exactly one navigation to C.
3. In both cases, confirm the build-id response is network-only/no-store and the existing service-worker registration
   remains registered.
