---
title: Freshness Hold Implementation Plan
feature_ids:
  - F193
topics:
  - agent-runtime
  - freshness
  - message-delivery
doc_kind: implementation-plan
created: 2026-07-11
---

# Freshness Hold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `tdd` for every behavior change, then run `quality-gate → request-review → receive-review → merge-gate` before completion.

**Goal:** 当猫基于旧上下文准备发送实质消息时，原子扣住旧稿、回灌新消息并要求 review；旧稿不得从 history、WebSocket、TTS、connector、push 或 A2A 任一出口泄漏。

**Architecture:** MessageStore 提供不可绕过的 per-thread append watermark 与 `appendIfFresh()` 原语；FreshnessEgressGate 负责发布或创建持久 hold；InvocationRecord 携带读取上下文前捕获的 baseline；callback 与 stdout 共用同一 gate。流式正文改为私有缓冲，只有 verdict 为 `published` 才一次性释放。

**Tech Stack:** TypeScript, Fastify, ioredis/Lua, Node test runner, existing InvocationRegistry, MessageStore, DraftStore, QueueProcessor and MCP callback tools.

---

## Scope And Decisions

首版保护范围：

- invocation-auth 的同 thread callback。
- serial / parallel stdout 最终消息。
- direct `/api/messages`、QueueProcessor 与 ConnectorInvokeTrigger 三类消费者。
- 正文、rich block、附件、语音、A2A、push、connector outbound。

明确边界：

- agent-key 与 cross-thread 没有可信已读 baseline，首版保留 legacy 行为并明确不标记为 protected。
- callback 活跃期通过 MCP tool result 原位回灌；stdout 已结束时使用独立 `freshness_review` 接力，不复用 session-seal continuation。
- review 最多 2 次；30 分钟超时或再次冲突超限后进入 `needs_attention`，保留草稿且绝不自动发送。
- status 只能由受信任结构字段声明；system、briefing、progress heartbeat 不推进水位。

否决方案及理由：

- 不比较 MessageId：queued 查询会被过滤，ID 也不是稳定的消费序号。
- 不比较 timestamp：Redis `markDelivered()` 会重排 timeline score，调用方时间戳也可能相同或倒退。
- 不复用 WebSocket seq / delivery cursor：它们不是持久、per-thread 的 append 顺序。
- 不做 `check → append` 两步：存在 TOCTOU，必须在同一 Redis Lua / 内存同步临界区内完成。
- 不复用现有 DraftStore 作为 hold 真相源：它缺少 CAS、review 次数、终态与 fail-closed 保留语义。

## Runtime Contract

```ts
type ThreadAppendWatermark = string;
type MessageClass = 'substantive' | 'status';

type ConditionalAppendResult =
  | { outcome: 'appended'; message: StoredMessage; committedWatermark: ThreadAppendWatermark }
  | {
      outcome: 'stale';
      baseline: ThreadAppendWatermark;
      observedWatermark: ThreadAppendWatermark;
    };

type FreshnessHoldStatus =
  | 'held'
  | 'reviewing'
  | 'released'
  | 'discarded'
  | 'needs_attention';
```

Watermark 是不透明十进制字符串；业务层不得自行转成 JavaScript `number` 比较。

```text
capture baseline（读上下文前）
  → 组 prompt / 创建 invocation
  → agent 生成私有稿
  → appendIfFresh
      ├── fresh：原子 append → published → 统一释放各出口
      └── stale：零正式 append → createOrGet hold → 回灌 delta
            ├── replace / send_draft → 再做 appendIfFresh
            ├── discard → discarded
            └── 第 3 次冲突/超时 → needs_attention
```

---

## Task 1: Message Watermark And Atomic Conditional Append

**Files:**

- Modify: `packages/api/src/domains/cats/services/stores/ports/MessageStore.ts`
- Modify: `packages/api/src/domains/cats/services/stores/redis/RedisMessageStore.ts`
- Modify: `packages/api/src/domains/cats/services/stores/redis-keys/message-keys.ts`
- Test: `packages/api/test/message-freshness-watermark.test.js`
- Test: `packages/api/test/redis-message-store-freshness.test.js`

- [ ] Write RED tests for monotonic append revision independent of timestamp/ID.
- [ ] Write RED tests proving queued advances immediately, delivered does not advance again, canceled is removed.
- [ ] Write RED tests proving status/system/briefing are structurally exempt and whisper only advances recipients.
- [ ] Write a Redis concurrency RED test allowing only `inbound first → stale` or `outbound first → appended`.
- [ ] Add `messageClass`, `appendWatermark`, capture/delta/conditional-append types to MessageStore.
- [ ] Implement the in-memory synchronous revision/index path.
- [ ] Move Redis ordinary append and conditional append onto one Lua primitive that writes the message and freshness indexes in one linearization point.
- [ ] Keep idempotency replay ahead of stale evaluation so a published retry returns the original message.
- [ ] Re-run targeted tests and API build.

## Task 2: Persistent Hold Store And CAS State Machine

**Files:**

- Create: `packages/api/src/domains/cats/services/stores/ports/FreshnessHoldStore.ts`
- Create: `packages/api/src/domains/cats/services/stores/redis/RedisFreshnessHoldStore.ts`
- Create: `packages/api/src/domains/cats/services/stores/redis-keys/freshness-hold-keys.ts`
- Create: `packages/api/src/domains/cats/services/stores/factories/FreshnessHoldStoreFactory.ts`
- Test: `packages/api/test/freshness-hold-store.test.js`
- Test: `packages/api/test/redis-freshness-hold-store.test.js`

- [ ] Write RED tests for `createOrGet` dedupe by invocation submission key.
- [ ] Write RED tests proving only one concurrent `claimReview(expectedVersion)` wins.
- [ ] Write RED tests for re-hold, release, discard, review limit and timeout.
- [ ] Require `needs_attention` to retain the full draft without TTL auto-delete.
- [ ] Implement memory and Redis stores with the same CAS contract.
- [ ] Verify Redis reconstruction after a new store instance.

## Task 3: Capture And Persist Invocation Baseline

**Files:**

- Modify: `packages/api/src/domains/cats/services/agents/invocation/InvocationRegistry.ts`
- Modify: `packages/api/src/domains/cats/services/agents/invocation/IAuthInvocationBackend.ts`
- Modify: `packages/api/src/domains/cats/services/agents/invocation/MemoryAuthInvocationBackend.ts`
- Modify: `packages/api/src/domains/cats/services/agents/invocation/RedisAuthInvocationBackend.ts`
- Modify: `packages/api/src/domains/cats/services/agents/invocation/invoke-single-cat.ts`
- Modify: `packages/api/src/domains/cats/services/agents/routing/route-serial.ts`
- Modify: `packages/api/src/domains/cats/services/agents/routing/route-parallel.ts`
- Test: `packages/api/test/invocation-registry.test.js`
- Test: `packages/api/test/auth-invocation-redis-ttl-slide.test.js`

- [ ] Write RED round-trip tests for memory and Redis baselines.
- [ ] Capture per-cat baseline before context/history reads.
- [ ] Pass baseline through `InvocationParams` into `InvocationRegistry.create()`.
- [ ] Preserve baseline through verify, getRecord, TTL slide and restart hydration.
- [ ] Tag sibling outputs with the common parent invocation group so parallel siblings do not hold each other.

## Task 4: Freshness Gate And Callback Review Loop

**Files:**

- Create: `packages/api/src/domains/cats/services/agents/freshness/FreshnessEgressGate.ts`
- Modify: `packages/api/src/routes/callbacks.ts`
- Modify: `packages/api/src/index.ts`
- Modify: `packages/mcp-server/src/tools/callback-tools.ts`
- Test: `packages/api/test/freshness-hold-callback.test.js`
- Test: `packages/mcp-server/test/callback-tools.test.js`

- [ ] RED: current baseline publishes once.
- [ ] RED: newer visible/queued message returns `freshness_held` before append/fanout.
- [ ] RED: retry with one clientMessageId returns the same holdId and delta.
- [ ] RED: held rich blocks, reply metadata and targets survive `send_draft`.
- [ ] RED: replace can re-hold; third conflict becomes `needs_attention`; discard is idempotent.
- [ ] Move same-thread invocation callback claim into FreshnessEgressGate.
- [ ] Add `POST /api/callbacks/freshness-holds/:holdId/review` and MCP `cat_cafe_review_held_message`.
- [ ] Treat held/discarded as successful control flow; only published messages may broadcast, enqueue A2A or outbound.
- [ ] Keep agent-key/cross-thread legacy branches explicit and observable.

## Task 5: Buffer Serial And Parallel Output Until Verdict

**Files:**

- Modify: `packages/api/src/domains/cats/services/agents/routing/route-helpers.ts`
- Modify: `packages/api/src/domains/cats/services/agents/routing/route-serial.ts`
- Modify: `packages/api/src/domains/cats/services/agents/routing/route-parallel.ts`
- Test: `packages/api/test/route-serial-freshness-hold.test.js`
- Test: `packages/api/test/route-parallel-freshness-hold.test.js`
- Test: `packages/api/test/route-serial-callback-dedup.test.js`
- Test: `packages/api/test/route-serial-voice.test.js`

- [ ] RED: stale stdout produces no formal append, text yield, rich block, TTS, A2A or debug handoff.
- [ ] RED: fresh stdout publishes one `replace` final message with publication timestamp.
- [ ] RED: held/discarded callback dispositions suppress stream fallback and metadata augment.
- [ ] RED: parallel siblings do not hold each other, while independent invocations do.
- [ ] Buffer user-visible text/rich/audio privately; continue lifecycle/tool progress/heartbeat realtime.
- [ ] Store per-cat egress disposition in `PersistenceContext`.
- [ ] Run all route-specific tests.

## Task 6: Seal Consumer And Draft Leakage Paths

**Files:**

- Modify: `packages/api/src/domains/cats/services/stores/ports/DraftStore.ts`
- Modify: `packages/api/src/domains/cats/services/stores/redis/RedisDraftStore.ts`
- Modify: `packages/api/src/routes/messages.ts`
- Modify: `packages/api/src/domains/cats/services/agents/invocation/QueueProcessor.ts`
- Modify: `packages/api/src/infrastructure/email/ConnectorInvokeTrigger.ts`
- Modify: `packages/api/src/infrastructure/connectors/StreamingOutboundHook.ts`
- Test: `packages/api/test/draft-messages-merge.test.js`
- Test: `packages/api/test/messages-delivery-mode.test.js`
- Test: `packages/api/test/queue-processor.test.js`
- Test: `packages/api/test/connector-invoke-trigger.test.js`
- Test: `packages/api/test/streaming-outbound-hook.test.js`

- [ ] RED: private freshness drafts never appear in GET history or restart recovery.
- [ ] RED: held direct/queued/connector results emit no text socket, stream chunk, push, outbound or silent-success substitute.
- [ ] RED: `onStreamHold` changes only the matching external placeholder to “重新审阅”.
- [ ] Add private/public draft exposure and filter private drafts from all user-visible hydration.
- [ ] Make all consumers read the route verdict rather than independently guessing freshness.
- [ ] Ensure fast-lane completion text also passes the gate.

## Task 7: Review Continuation And Observability

**Files:**

- Modify: `packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts`
- Modify: `packages/api/src/domains/cats/services/agents/invocation/QueueProcessor.ts`
- Modify: `packages/api/src/domains/cats/services/agents/routing/route-helpers.ts`
- Modify: `packages/shared/src/types/agent-events.ts` (or the existing event type owner)
- Test: `packages/api/test/freshness-review-continuation.test.js`

- [ ] RED: held callback returns delta to the active tool call.
- [ ] RED: held stdout schedules one bounded `freshness_review` continuation or attaches it to the earliest queued entry for that cat.
- [ ] RED: no continuation is scheduled after discard, timeout or review limit.
- [ ] Emit structured hold events without draft content: created, reviewing, resolved, needs_attention.
- [ ] Persist a visible hold notice and expose active holds for refresh/recovery.

## Task 8: Acceptance, Documentation And Review

**Files:**

- Modify: `docs/agent-runtime/slock-agent-protocol.md`
- Modify: `docs/agent-runtime/slock-governance-runtime.md`
- Create: `packages/api/test/integration/freshness-hold-two-agent.test.js`

- [ ] Build API, MCP server and affected frontend/shared packages.
- [ ] Run targeted suites, Redis suites and the existing baseline suites.
- [ ] Run a deterministic two-agent integration: A starts, B/user appends midway, A becomes held, receives delta, reviews, and no stale bytes appear in history/socket/connector.
- [ ] Verify status/system exemption and review-limit behavior.
- [ ] Record the protocol, observability fields and unsupported identity boundaries in docs.
- [ ] Run `quality-gate → request-review → receive-review → merge-gate` with an independent reviewer.

## Verification Commands

```bash
pnpm --filter @cat-cafe/api build
node --test packages/api/test/message-freshness-watermark.test.js
node --test packages/api/test/freshness-hold-store.test.js
node --test packages/api/test/freshness-hold-callback.test.js
node --test packages/api/test/route-serial-freshness-hold.test.js
node --test packages/api/test/route-parallel-freshness-hold.test.js
node --test packages/api/test/freshness-review-continuation.test.js
pnpm --filter @cat-cafe/mcp-server test
pnpm test:api:redis
pnpm --filter @cat-cafe/api test
```

Known baseline exception before this branch: two unrelated connector batching assertions in `queue-processor.test.js` already fail (`does not batch connector entries` and `P1-2: connector entry is NOT absorbed into user batch`). Freshness changes must not add failures beyond that recorded baseline.
