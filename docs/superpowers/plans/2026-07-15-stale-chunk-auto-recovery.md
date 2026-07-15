# Stale Chunk Auto Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让已打开的 Clowder 旧标签页在新 Web 构建上线后自动恢复且不出现持久白屏，同时保护未发送草稿并严格防止 reload 循环。

**Architecture:** 构建时生成稳定 build id，并同时注入客户端 bundle 与 `/_clowder/build-id` no-store endpoint；已运行页面通过 mount/focus/visibility/online/定时探测发现新构建。首屏 inline bootstrap 捕获 React hydration 前的 Next chunk 资源错误，React Guard 处理主动探测、完整草稿门禁、可操作刷新提示与跨标签通知；两条入口共享“同一目标构建最多一次自动恢复”的 sessionStorage + 内存兜底。

**Tech Stack:** Next.js 14 App Router、React 18、TypeScript、Vitest/jsdom、Node test、next-pwa/Workbox、PM2。

## Global Constraints

- 基线必须是 `feature/slock-like-webui` 的 committed HEAD `07eeb8c`，只在独立 worktree `/Users/cy/.slock/worktrees/clowder-stale-chunk-recovery` 工作。
- 版本探测失败、超时、5xx、非法 JSON 或空 build id 都不等于发现新版本，绝不触发 reload。
- 同一目标 build id 每个标签页最多自动 reload 一次；sessionStorage 不可用时仍必须用内存 latch fail-closed。
- 任何未发送文字、图片、文件附件或正在编辑的 textarea 内容存在时，只显示可操作刷新提示，不强制 reload。
- 普通图片、头像、API、Socket 或业务错误不能触发 chunk recovery；资源错误仅接受同源 `/_next/static/chunks/`、`/_next/static/css/`。
- 保留 Service Worker registration 与 PushSubscription；恢复时只调用 registration update 并清 CacheStorage，禁止 unregister。
- build-id endpoint 必须绕开 `/api/*` rewrite，响应 `Cache-Control: no-store, max-age=0`。
- 首次上线只能验证旧 guard 的被动路径；主动 build-id 合同必须用两个连续、均包含新机制且 build id 不同的构建 A→B 验收。
- 不得使用 `page.reload()`、刷新快捷键或注入 `location.reload()` 伪造 live 通过；导航必须由产品恢复逻辑发起。

---

## File Structure

- `packages/web/src/utils/web-build-version.ts`：build-id 常量、响应校验、no-store probe 纯函数。
- `packages/web/src/app/_clowder/build-id/route.ts`：返回当前 server build id 的 no-store endpoint。
- `packages/web/next.config.js`：解析/覆盖稳定 build id、配置 `generateBuildId`、安全注入 public build id、Workbox NetworkOnly。
- `packages/web/src/utils/chunk-load-recovery.ts`：错误分类、草稿判断、目标版本 reload reservation、缓存刷新。
- `packages/web/src/utils/chunk-load-bootstrap.ts`：生成 hydration 前 inline recovery script。
- `packages/web/src/components/ChunkLoadRefreshGuard.tsx`：主动 probe、事件监听、BroadcastChannel、提示 UI、人工刷新。
- `packages/web/src/components/thread-drafts.ts`：全局草稿真源与 browser bootstrap bridge。
- `packages/web/src/app/global-error.tsx`：React/Next 可控错误的最终可见兜底。
- `packages/web/src/app/layout.tsx`：把 early bootstrap 放在所有 Next client/app script 之前，保留 React Guard。
- 测试文件分别锁定 config/endpoint、纯逻辑、early script 顺序、React 行为与草稿保护。

### Task 1: Stable build-id contract and no-store endpoint

**Files:**
- Create: `packages/web/src/utils/web-build-version.ts`
- Create: `packages/web/src/app/_clowder/build-id/route.ts`
- Modify: `packages/web/next.config.js`
- Modify: `packages/web/test/next-config.test.cjs`
- Create: `packages/web/src/utils/__tests__/web-build-version.test.ts`

**Interfaces:**
- Produces: `CLIENT_WEB_BUILD_ID: string`、`fetchServerBuildId(fetchImpl, signal?): Promise<string | null>`、`GET(): Response`。
- Produces config contract: `generateBuildId(): Promise<string>` 与 `env.NEXT_PUBLIC_CLOWDER_WEB_BUILD_ID` 必须相同。

- [ ] **Step 1: Write failing config and probe tests**

```ts
it('returns null for 503, invalid JSON and empty build ids', async () => {
  await expect(fetchServerBuildId(async () => new Response('down', { status: 503 }))).resolves.toBeNull();
  await expect(fetchServerBuildId(async () => new Response('{bad'))).resolves.toBeNull();
  await expect(fetchServerBuildId(async () => Response.json({ buildId: '   ' }))).resolves.toBeNull();
});

it('accepts only a non-empty build id from a no-store request', async () => {
  const fetchImpl = vi.fn(async () => Response.json({ buildId: 'build-b' }));
  await expect(fetchServerBuildId(fetchImpl)).resolves.toBe('build-b');
  expect(fetchImpl).toHaveBeenCalledWith('/_clowder/build-id', expect.objectContaining({ cache: 'no-store' }));
});
```

在 `next-config.test.cjs` 增加：显式 `CLOWDER_WEB_BUILD_ID=build-a` 时 `await config.generateBuildId()` 与 `config.env.NEXT_PUBLIC_CLOWDER_WEB_BUILD_ID` 都等于 `build-a`；public config 不含 bearer；PWA production config 对 `/_clowder/build-id` 为 `NetworkOnly`。

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm --dir packages/web exec vitest run src/utils/__tests__/web-build-version.test.ts
node packages/web/scripts/run-with-node-env-test.mjs node --test --test-concurrency=1 packages/web/test/next-config.test.cjs
```

Expected: FAIL because the module, endpoint, `generateBuildId`, public build id and NetworkOnly rule do not exist.

- [ ] **Step 3: Implement the build-id contract**

`web-build-version.ts` must expose this exact behavior:

```ts
export const CLIENT_WEB_BUILD_ID = process.env.NEXT_PUBLIC_CLOWDER_WEB_BUILD_ID?.trim() || 'development';

export async function fetchServerBuildId(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const response = await fetchImpl('/_clowder/build-id', {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { buildId?: unknown };
    const buildId = typeof payload.buildId === 'string' ? payload.buildId.trim() : '';
    return buildId || null;
  } catch {
    return null;
  }
}
```

Endpoint response:

```ts
import { CLIENT_WEB_BUILD_ID } from '@/utils/web-build-version';

export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json(
    { buildId: CLIENT_WEB_BUILD_ID },
    { headers: { 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache' } },
  );
}
```

`next.config.js` must resolve `CLOWDER_WEB_BUILD_ID` first, otherwise `git rev-parse --verify HEAD`, sanitize to `[A-Za-z0-9._-]`, then expose the same value through `generateBuildId` and `NEXT_PUBLIC_CLOWDER_WEB_BUILD_ID`. The PWA runtimeCaching array must put `/_clowder/build-id` NetworkOnly before generic rules.

- [ ] **Step 4: Run tests and verify GREEN**

Run the two Step 2 commands.

Expected: build-version Vitest passes and next-config Node tests pass with the new assertions.

- [ ] **Step 5: Commit Task 1**

```bash
git add packages/web/next.config.js packages/web/test/next-config.test.cjs \
  packages/web/src/utils/web-build-version.ts \
  packages/web/src/utils/__tests__/web-build-version.test.ts \
  packages/web/src/app/_clowder/build-id/route.ts
git commit -m "feat(web): expose stable build version"
```

### Task 2: Fail-closed recovery decisions, draft bridge and early bootstrap

**Files:**
- Modify: `packages/web/src/utils/chunk-load-recovery.ts`
- Modify: `packages/web/src/utils/__tests__/chunk-load-recovery.test.ts`
- Modify: `packages/web/src/components/thread-drafts.ts`
- Create: `packages/web/src/utils/chunk-load-bootstrap.ts`
- Create: `packages/web/src/utils/__tests__/chunk-load-bootstrap.test.ts`
- Modify: `packages/web/src/app/layout.tsx`
- Create: `packages/web/src/components/__tests__/chunk-load-bootstrap-layout.test.ts`

**Interfaces:**
- Consumes: `CLIENT_WEB_BUILD_ID` from Task 1.
- Produces: `isRecoverableChunkLoadError(reason): boolean`、`hasUnsavedUserWork(documentRef?): boolean`、`reserveAutomaticRecovery(storage, targetBuildId, now?): boolean`、`prepareBrowserForReload(windowRef): Promise<void>`。
- Produces: `installThreadDraftBridge()` and browser global `window.__CLOWDER_HAS_PENDING_DRAFT__(): boolean`。
- Produces: `createChunkLoadBootstrapScript(clientBuildId): string`。

- [ ] **Step 1: Replace cooldown tests with target-version hard-limit RED tests**

```ts
it('allows one automatic recovery per target build, never a second after cooldown', () => {
  const storage = memoryStorage();
  expect(reserveAutomaticRecovery(storage, 'build-b', 1_000)).toBe(true);
  expect(reserveAutomaticRecovery(storage, 'build-b', 130_000)).toBe(false);
  expect(reserveAutomaticRecovery(storage, 'build-c', 131_000)).toBe(true);
});

it('fails closed with an in-memory latch when sessionStorage throws', () => {
  const storage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  expect(reserveAutomaticRecovery(storage, 'build-storage-off')).toBe(true);
  expect(reserveAutomaticRecovery(storage, 'build-storage-off')).toBe(false);
});

it('recognizes only Next chunk/css resource failures', () => {
  expect(isRecoverableChunkLoadError({ target: { src: 'http://localhost:3003/_next/static/chunks/app.js' } })).toBe(true);
  expect(isRecoverableChunkLoadError({ target: { href: 'http://localhost:3003/_next/static/css/app.css' } })).toBe(true);
  expect(isRecoverableChunkLoadError({ target: { src: 'http://localhost:3003/avatar.png' } })).toBe(false);
});
```

补草稿矩阵：空格=false；任一 thread 文字、图片、文件=true；任意非空 textarea=true。补清理测试：`serviceWorker.getRegistrations()` 只调用 `registration.update()`，从不 `unregister()`；cache delete rejection 不阻断 resolve。

- [ ] **Step 2: Write early-bootstrap and layout-order RED tests**

`chunk-load-bootstrap.test.ts` 用 `new Function('window', 'document', script)` 在 fake window 上验证：capture listener 为 true；资源 chunk error 在无草稿时同一 `build-a` 只 reload 一次；global draft bridge 返回 true 时零 reload 并写 `clowder:recovery-prompt`；storage 抛错时第二次事件也不 reload。

`chunk-load-bootstrap-layout.test.ts` 读取 `src/app/layout.tsx` 源码，断言 `id="clowder-chunk-recovery-bootstrap"` 出现在 `<ChunkLoadRefreshGuard />` 之前，且 inline script 使用 `createChunkLoadBootstrapScript(CLIENT_WEB_BUILD_ID)`。

- [ ] **Step 3: Run tests and verify RED**

```bash
pnpm --dir packages/web exec vitest run \
  src/utils/__tests__/chunk-load-recovery.test.ts \
  src/utils/__tests__/chunk-load-bootstrap.test.ts \
  src/components/__tests__/chunk-load-bootstrap-layout.test.ts
```

Expected: FAIL on cooldown semantics, storage fail-open, target loss, unregister behavior, missing draft bridge and missing bootstrap.

- [ ] **Step 4: Implement pure recovery and browser bridge**

The persisted record must be JSON `{ "targetBuildId": string, "attemptedAt": number }` under `clowder:automatic-recovery`; malformed records are treated as absent. Use a module-level `Set<string>` before storage access so a throwing storage cannot allow the same target twice.

`hasUnsavedUserWork` must combine `hasAnyPendingThreadDraft()` with non-empty enabled textarea values. `installThreadDraftBridge()` must assign a function, not a snapshot boolean, so pasted images/attachments and background-thread drafts remain current.

`prepareBrowserForReload` must use:

```ts
await Promise.allSettled([
  windowRef.navigator.serviceWorker?.getRegistrations().then((registrations) =>
    Promise.allSettled(registrations.map((registration) => registration.update())),
  ),
  'caches' in windowRef
    ? windowRef.caches.keys().then((keys) => Promise.allSettled(keys.map((key) => windowRef.caches.delete(key))))
    : Promise.resolve(),
]);
```

No `registration.unregister()` may remain.

- [ ] **Step 5: Implement the hydration-before bootstrap**

The generated script must:

1. install capture-phase `error` and `unhandledrejection` listeners immediately;
2. accept only the exact chunk regex or `/_next/static/chunks|css/` resource URLs;
3. check `window.__CLOWDER_HAS_PENDING_DRAFT__?.()` plus non-empty textareas;
4. on draft, persist `{ kind:'chunk', targetBuildId, reason:'unsaved-draft' }` under `clowder:recovery-prompt` and dispatch `clowder:recovery-prompt` without navigating;
5. otherwise reserve `chunk:<clientBuildId>` once, call SW `update()`, clear caches, then `location.reload()`;
6. keep an in-script Set latch so storage exceptions still allow at most one attempt.

In `layout.tsx`, inject the bootstrap immediately after the theme bootstrap and before `<ChunkLoadRefreshGuard />`:

```tsx
<script
  id="clowder-chunk-recovery-bootstrap"
  dangerouslySetInnerHTML={{ __html: createChunkLoadBootstrapScript(CLIENT_WEB_BUILD_ID) }}
/>
```

- [ ] **Step 6: Run tests and verify GREEN**

Run the Step 3 command.

Expected: all recovery, bootstrap and layout-order tests pass.

- [ ] **Step 7: Commit Task 2**

```bash
git add packages/web/src/utils/chunk-load-recovery.ts \
  packages/web/src/utils/__tests__/chunk-load-recovery.test.ts \
  packages/web/src/utils/chunk-load-bootstrap.ts \
  packages/web/src/utils/__tests__/chunk-load-bootstrap.test.ts \
  packages/web/src/components/thread-drafts.ts \
  packages/web/src/components/__tests__/chunk-load-bootstrap-layout.test.ts \
  packages/web/src/app/layout.tsx
git commit -m "fix(web): recover stale chunks before hydration"
```

### Task 3: Active version guard, draft-safe prompt and visible fallback

**Files:**
- Modify: `packages/web/src/components/ChunkLoadRefreshGuard.tsx`
- Create: `packages/web/src/components/__tests__/chunk-load-refresh-guard.test.tsx`
- Create: `packages/web/src/app/global-error.tsx`
- Create: `packages/web/src/components/__tests__/global-error.test.tsx`

**Interfaces:**
- Consumes: `CLIENT_WEB_BUILD_ID`、`fetchServerBuildId`、`reserveAutomaticRecovery`、`prepareBrowserForReload`、`hasUnsavedUserWork`。
- Produces UI contract: persistent `role="alertdialog"`, copy `检测到 Clowder 新版本` and button `保存好草稿并刷新`。

- [ ] **Step 1: Write React Guard RED tests**

Use fake timers and mocked `fetchServerBuildId`/reload. Cover all cases:

```ts
it('reloads exactly once when a valid different build id is observed without drafts', async () => {
  serverBuildId.mockResolvedValue('build-b');
  render(<ChunkLoadRefreshGuard />);
  await flushEffects();
  expect(reload).toHaveBeenCalledTimes(1);
});

it('shows an actionable prompt and preserves textarea when drafts exist', async () => {
  document.body.innerHTML = '<textarea>未发送内容</textarea>';
  serverBuildId.mockResolvedValue('build-b');
  render(<ChunkLoadRefreshGuard />);
  expect(screen.getByRole('alertdialog')).toHaveTextContent('检测到 Clowder 新版本');
  expect(reload).not.toHaveBeenCalled();
  expect(document.querySelector('textarea')?.value).toBe('未发送内容');
});
```

Also assert: same ID=no action; three null probes=no reload; focus/visibility/online re-probe after failure cap; duplicate BroadcastChannel event reloads once; chunk event with draft shares the same prompt; clicking `保存好草稿并刷新` runs cleanup then one reload.

- [ ] **Step 2: Write global-error RED test**

Render `GlobalError` with an Error and assert visible copy `Clowder 页面加载失败`, a button `重新加载`, and button click calls `reset()` first; if reset throws, it calls `window.location.reload()`.

- [ ] **Step 3: Run React tests and verify RED**

```bash
pnpm --dir packages/web exec vitest run \
  src/components/__tests__/chunk-load-refresh-guard.test.tsx \
  src/components/__tests__/global-error.test.tsx
```

Expected: FAIL because active probing, prompt UI and global-error do not exist.

- [ ] **Step 4: Implement active probing and prompt**

The Guard must use a single `requestRecovery(kind, targetBuildId)` path for build mismatch, chunk errors, BroadcastChannel and bootstrap prompt events. Probe schedule:

- immediate mount;
- `focus`, `online`, and visible `visibilitychange`;
- 30-second interval while visible;
- max 3 consecutive failed/null probes, reset only by `online` or explicit focus/visibility event;
- one in-flight AbortController; abort on unmount.

On valid mismatch, broadcast `{ type:'build-changed', buildId }` on `BroadcastChannel('clowder:web-build')`. Each tab applies its own session reservation. When unsaved work exists, render a fixed, high-z-index alertdialog with the exact copy and manual button; never auto-dismiss it.

- [ ] **Step 5: Implement global error fallback**

Create a client `global-error.tsx` that renders its own `<html><body>` and a readable centered panel. The primary button calls `reset()`; a secondary explicit `重新加载` action calls `window.location.reload()`. It must not auto reload because the Guard owns loop limits.

- [ ] **Step 6: Run React tests and verify GREEN**

Run the Step 3 command.

Expected: all Guard and global-error tests pass with no unhandled timers.

- [ ] **Step 7: Commit Task 3**

```bash
git add packages/web/src/components/ChunkLoadRefreshGuard.tsx \
  packages/web/src/components/__tests__/chunk-load-refresh-guard.test.tsx \
  packages/web/src/app/global-error.tsx \
  packages/web/src/components/__tests__/global-error.test.tsx
git commit -m "feat(web): reload safely on build changes"
```

### Task 4: Full local gate and two-build acceptance harness

**Files:**
- Create: `packages/web/scripts/verify-stale-build-recovery.mjs`
- Create: `packages/web/test/stale-build-recovery-harness.test.mjs`
- Modify: `packages/web/package.json`
- Create: `docs/reviews/task-393-stale-chunk-recovery.md`

**Interfaces:**
- Consumes all Tasks 1–3 contracts.
- Produces: `pnpm --dir packages/web test:stale-build-recovery` deterministic harness and reviewer evidence document.

- [ ] **Step 1: Write harness RED test**

The Node test must start a tiny same-origin HTTP fixture that serves build A then build B, load the bootstrap/controller harness, and record probe requests plus document navigation. Assert:

- A→B without draft: one product-originated navigation;
- B probe 503 three times: zero navigation;
- B→C with text draft: zero navigation until the harness clicks the prompt action;
- same target repeated: navigation count remains one.

The harness source must not contain `page.reload`, `Cmd+Shift+R`, `Meta+Shift+R`, or automation-side `location.reload`.

- [ ] **Step 2: Run harness and verify RED**

```bash
node --test packages/web/test/stale-build-recovery-harness.test.mjs
```

Expected: FAIL because the harness and package script do not exist.

- [ ] **Step 3: Implement harness and package script**

Add:

```json
"test:stale-build-recovery": "node --test test/stale-build-recovery-harness.test.mjs"
```

The harness must expose emitted evidence as JSON with keys `source`, `fromBuildId`, `toBuildId`, `probeStatuses`, `navigationCount`, `draftProtected`, and `loopPrevented`; `source` must equal `product-recovery`.

- [ ] **Step 4: Run focused and full local gates**

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
curl --fail --silent --show-error http://127.0.0.1:3003/_clowder/build-id
git diff --check
```

Expected: all tests/lint/build pass; generated BUILD_ID equals override; endpoint returns the same id with no-store header when the production server is running.

- [ ] **Step 5: Write reviewer evidence**

`docs/reviews/task-393-stale-chunk-recovery.md` must record exact commits, test totals, build command, build-id response/header, known first-deploy limitation, and the required live A→B plus draft B→C acceptance steps. It must explicitly state that SW registration is preserved and only `update()` is called.

- [ ] **Step 6: Commit Task 4**

```bash
git add packages/web/scripts/verify-stale-build-recovery.mjs \
  packages/web/test/stale-build-recovery-harness.test.mjs \
  packages/web/package.json docs/reviews/task-393-stale-chunk-recovery.md
git commit -m "test(web): verify stale build recovery"
```

### Task 5: Review, merge gate, deploy and live proof

**Files:**
- Modify after evidence only: `docs/reviews/task-393-stale-chunk-recovery.md`

**Interfaces:**
- Consumes all commits and Task 4 evidence.
- Produces Claude PASS, canonical fast-forward, GitHub Actions green, live A→B and B→C evidence, task #393 `in_review`.

- [ ] **Step 1: Run independent specification and code-quality review**

Reviewer checks exact diff from `07eeb8c` to branch HEAD, validates every Global Constraint, and reports findings as P0/P1/P2/P3 with file:line evidence. Any P0/P1 blocks merge; fix via red test and rerun review.

- [ ] **Step 2: Request @专家-Claude merge gate**

Post in `#clowderAI:2ede3deb`: commits, diff scope, exact tests, loop/draft/SW proof, known first-deploy limitation, and request `PASS / BLOCK` verdict. Do not merge or deploy before PASS.

- [ ] **Step 3: Fast-forward canonical and push without touching dirty user files**

Verify canonical user dirty inventory before and after. Fast-forward `feature/slock-like-webui` only; no reset/checkout/stash of user files. Push the canonical branch and monitor its GitHub Actions run through all required jobs.

- [ ] **Step 4: Run live A→B automatic recovery proof**

Build/deploy the approved code once with command-local `CLOWDER_WEB_BUILD_ID=task393-live-a`, restart Web, then open the old-tab canary and record A. Build/deploy the same approved code with `CLOWDER_WEB_BUILD_ID=task393-live-b`, restart Web, and leave the A tab untouched. Trigger only natural focus/visibility or wait ≤35 seconds. Pass requires exactly one product-originated navigation, final endpoint/build B, usable AppShell, no `Application error`, and no manual refresh calls in automation.

- [ ] **Step 5: Run live draft protection proof**

In B, enter a unique unsent text and attach a small image. Deploy `task393-live-c`, restart Web, refocus the B tab. Pass requires no navigation, persistent actionable prompt, text and attachment preserved. Click only the product button `保存好草稿并刷新`; then require exactly one navigation to C.

- [ ] **Step 6: Verify production health and preserve push registration**

Check `3003` HTTP 200, `3003/_clowder/build-id`, `3003/api/ready`, `3004/api/ready`, `/api/cats` count, PM2 online status, no new fatal logs, no unhandled ChunkLoadError, and SW registration still exists before/after with unchanged PushSubscription endpoint when one existed.

- [ ] **Step 7: Append evidence, commit if documentation changed, and set review status**

Append exact run IDs, PM2 restart numbers, build ids, navigation counts, screenshots/console handles, health responses and Actions URL. Any documentation-only evidence commit requires a final narrow Claude gate if it changes the gated HEAD. When all gates are green, move task #393 to `in_review`; only human acceptance moves it to `done`.

---

## Self-Review Result

- Spec coverage: build change, pre-hydration chunk failure, probe failure, hard loop limit, all draft types, actionable prompt, SW/push preservation, two-build live proof and no-manual-refresh evidence each map to an explicit task and test.
- Placeholder scan: every code change, validation command, expected result and failure behavior is concrete.
- Type consistency: Task 1 public identifiers are consumed unchanged in Tasks 2–4; Task 2 recovery interfaces are consumed unchanged by Task 3; reviewer/deploy task consumes the exact package script created in Task 4.
