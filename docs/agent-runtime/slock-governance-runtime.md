---
feature_ids:
  - F193
topics:
  - agent-runtime
  - governance
  - observability
doc_kind: runtime-governance
created: 2026-05-26
updated: 2026-07-11
---

# Slock-like Governance Runtime

Clowder 的 `shared-rules.md` 不再按“所有 Agent 每次背全文”的方式理解。
它按 Slock 的成熟秘书模型分层加载：核心规则常驻，运营规则按工具箱加载，原文按需查阅。

## 分层模型

```text
P0 核心家规       → 所有 Agent 常驻，短摘要
P1 运营家规       → standard/full 工具箱注入
P2 角色/工作流规则 → 按 Agent breed、pack、skill 注入
P3 原文规则       → 用户触发或审计时读取 shared-rules.md
```

## 当前实现

- `minimal`：只注入 `GOVERNANCE_CORE_DIGEST`
- `standard`：注入完整 `GOVERNANCE_OPERATIONAL_DIGEST`
- `full`：注入完整 `GOVERNANCE_OPERATIONAL_DIGEST`，并允许 always_on / signal / guide 等重上下文继续进入
- 命中 Magic Words 时：按需读取 `cat-cafe-skills/refs/shared-rules.md` 原文，作为本次 invocation 的动态上下文注入。
- 输出格式边界：日常对话和轻量问答必须自然短答；只有任务完成、review、handoff、BLOCKED 等状态迁移才需要结构化报告。
- F193 将实质输出收口到 `FreshnessEgressGate`：路由层先生成私有稿，只有 `published` verdict 才允许 history / socket / TTS / A2A / connector 等出口继续。

这和 `toolPolicy` 分层一致：

- 轻度工具箱：微信默认回复、Pi、短问候、简单问答
- 中度工具箱：普通工程/需求/协作任务
- 重度工具箱：深度调研、PPT、复杂工程、跨工具任务

## 设计原则

1. **硬边界常驻**：危险操作、任务状态、正确 surface 回复、完成证据必须常驻。
2. **长规则不常驻**：完整 `shared-rules.md` 是权威原文，但不是每次调用的 prompt。
3. **角色规则按需**：工程、设计、需求、PPT 规则应走资产卡、pack 或 skill。
4. **可诊断**：上下文诊断应能看出当前使用了哪个 `toolPolicy`，从而推断家规加载层级。

## 下一步

- 把 `shared-rules.md` 拆成可机器读取的章节元数据。
- 对 Magic Words 原文注入做更细的章节定位，而不是当前的截断式原文参考。
- 后续若 `shared-rules.md` 继续膨胀，需要把角色规则拆到 asset card / skill / pack。

## 运行态诊断

每次 invocation 的 `contextBudget` 会带上：

- `governanceTier`：`core` 或 `operational`
- `governanceEstimatedTokens`：家规摘要 + 按需原文的估算 token
- `governanceSourceInjected`：本次是否因 Magic Words 注入了原文

前端 `ThreadExecutionBar` 会显示 `家规:核心` 或 `家规:运营`，hover 可看到更详细的 token 和加载块。

## F193：Freshness Hold 运行治理

行为真相源见 [`slock-agent-protocol.md`](./slock-agent-protocol.md#f193freshness-hold-出口协议)。本节只固定运行时的责任边界、观测面和运维方法。

### 责任分层

```text
MessageStore
  └── per-thread 序列 + per-audience 可见索引 + 原子 appendIfFresh

InvocationRecord / routing
  └── 读取上下文前 capture baseline，正文/rich/audio 先放私有缓冲

FreshnessEgressGate + FreshnessHoldStore
  └── published / held / discarded / needs_attention verdict
      └── CAS review、幂等发布和恢复记录

HTTP / Queue / Connector consumers
  └── 只消费 verdict，不重做 freshness 判断
```

Redis 后端是跨进程恢复的前提：hold 详情、submission 去重索引和 deadline 索引均持久化，且 `needs_attention` 稿件不会因 TTL 被静默删除。无 Redis 的内存实现只保证单进程语义，API 重启后不保留 hold 或幂等索引。

### 身份治理矩阵

| 出口 | F193 首版 | 原因 |
|---|---|---|
| serial / parallel stdout | protected | 运行时在读 history 前按 cat 捕获 baseline |
| QueueProcessor fast-lane completion | protected | 工作流执行前捕获 baseline，成功结果经 Gate 后才能进入正式正文或完整 task completion |
| same-thread invocation callback | protected | InvocationRecord 持有本 thread baseline 与临时身份 |
| agent-key callback | legacy | 持久身份不能证明本轮已读位置 |
| invocation cross-thread callback | legacy | 原 thread baseline 不适用于目标 thread |

Review 不能放宽身份。Callback review 要求原 invocation 凭证；stdout `freshness_review` successor 必须携带原 hold 所有权五元组，且后继 invocation 本身必须仍是当前 latest。

### 无稿件内容的可观测契约

用户可见提示、日志、metrics 和追踪属性只能从下列字段白名单取值：

```text
event/status, disposition, holdId, threadId, catId, invocationId,
version, reviewCount, maxReviews, expiresAt, attentionReason,
baselineWatermark, observedWatermark, unseenMessageIds/newMessageCount,
truncated, releasedMessageId/messageId
```

禁止记录或广播 `draft`、`draftContent`、callback `toolInput.content`、完整 HoldStore record 或完整 `PersistenceContext`。受保护 invocation 的原始 assistant text/tool input 也不得先写 transcript 或 agent memory；`newMessages` 是回灌给授权 reviewer 的新入站上下文，不是被扣稿件，它不得被无关日志二次复制。

建议审计事件名为：

- `freshness_hold_created`
- `freshness_reviewing`
- `freshness_hold_resolved`（`released` 或 `discarded`）
- `freshness_needs_attention`

当前已实现的观测面有四个：

- callback tool result：`freshness_held` / `freshness_needs_attention` + `holdId` + `freshness.{baselineWatermark, observedWatermark, version, reviewCount, maxReviews, expiresAt}` + delta 计数/截断标记。
- stdout/WebSocket：无稿件正文的 `system_info`，type 为 `freshness_hold` 或 `freshness_needs_attention`；connector 占位符只改为“重新审阅”。
- 内部交付：`PersistenceContext.egressByCat[catId]` 携带 per-cat disposition、hold/message ID、version、reviewCount 和 holdStatus，供 Web / Queue / Connector 消费。
- 浏览器恢复查询：`GET /api/freshness-holds?threadId=...` 只返回当前用户的 `held` / `reviewing` / `needs_attention` 元数据，包括 id、catId、threadId、status、version、reviewCount、时间字段和可选 attentionReason；不暴露 draft、delta、watermark 或 invocation 凭证。
- Web 恢复条：当前 thread 每 5 秒刷新 active metadata，并在页面重新可见时立即刷新；切换 thread 或卸载时中止旧请求并用请求世代拒绝迟到响应；只显示猫、状态、复核次数与人工介入原因，不展示稿件。

当前仍无统一持久 audit event stream。Web 已通过 active-holds API 恢复只含元数据的 Hold 通知条，但它不等价于完整状态迁移审计；Hold record 仍是恢复真相源，且不得直接暴露给前端。

### 故障恢复与运维边界

- 发布恢复顺序是 `reviewing → queued → released → delivered`；重试依靠 hold version CAS 与 `freshness-hold:<holdId>` 消息幂等键，不依靠时间戳或消息 ID 大小。普通 successful submit 也从 `(invocationId, submissionKey)` 派生稳定幂等键，并把 `replayed` 向上传给所有 consumer，禁止二次 fanout。
- queued review publication 会先占据 freshness 水位并形成结构化私有 barrier，但在 released CAS 成功前不进 history、不会被 delta hydrate，也不会推进 reviewer cursor；恢复时要么补完同一条消息，要么保持私有，不得生成第二条。
- released/discarded 迁移在 memory 与 Redis 的同一终态 CAS 内擦除 draft/delta；`needs_attention` 为人工恢复需要，继续保留完整私稿且不设自动 TTL。
- 30 分钟 deadline 与最多两轮 review 都以 fail closed 收敛到 `needs_attention`。Deadline scheduler 在 API 启动时立即 sweep，随后默认每 60 秒调用 `expireDue()`；进程运行且 store 可用时，到期 held/reviewing 会在后续轮询中收敛。当前仍没有 publication reconciler，`reviewing + queued` 或 `released + queued` 在无重试时可能长期保持私有，但不得自动发布。
- `freshness_review` QueueEntry 与它的私有稿件/delta payload 是进程内状态，重启会丢失自动 review 调度；Redis hold 本体仍保留。当前没有 restart reconciler，所以运维上需将“稿件仍安全保留”与“自动 review 已恢复”区分开。
- 如果 HoldStore、MessageStore 或出口 verdict 无法确认，运行时应报错并保留稿件，禁止回退到 legacy 发布。
- Redis freshness 水位在 `9007199254740991` 达到安全上限；append / restore / reveal 必须在任何 hash/index 变更前 fail closed。扩容到更大序列前必须迁出 ZSET double score，不能静默继续 INCR。

### 渐进启用与回滚

- `CAT_CAFE_FRESHNESS_HOLD_ENABLED=true` 才构造运行时 Gate；默认关闭，避免未验证环境被一次性切换。
- `CAT_CAFE_FRESHNESS_HOLD_CATS` 与 `CAT_CAFE_FRESHNESS_HOLD_THREADS` 是可选逗号白名单；同一路由只有全部初始目标猫都命中时才启用。路线一旦选中 protected，其运行中动态发现的 A2A 后代也继承 protected 语义，避免同一路线一半缓冲、一半 legacy。
- 关闭总开关只影响新的 invocation；既有 Hold 仍由同一个 store、active API 与 expiry scheduler fail closed 管理，不能因回滚自动发布。

### 验证方法与当前验收边界

至少按下列层次验证：

1. MessageStore：同时间戳的单调序列，queued/delivered/canceled，status/system/briefing 豁免，public/whisper audience，Redis 并发只有“入站先则 stale / 出站先则 published”两种合法结果。
2. HoldStore/Gate：创建去重、version CAS、两轮上限、30 分钟、delta 分页，以及两个崩溃窗口的幂等恢复。
3. 路由/出口：被 hold 的文本、rich block、语音、A2A、push 和 connector 均为零泄漏，混合多猫结果仅交付 published 的猫。
4. Review：callback 原位 review 和 stdout `freshness_review` continuation 均会再检 freshness，同 hold/version 不重复调度，达终态后停止。
5. 真实双 Agent：A 开始答复后由 B/用户插入实质消息，验证 A 被扣住、拿到 delta、review 后只发布新答案，且旧稿在 history/socket/connector 中为零字节。

建议命令：

```bash
pnpm --filter @cat-cafe/api build
node --test packages/api/test/message-freshness-watermark.test.js \
  packages/api/test/freshness-hold-store.test.js \
  packages/api/test/freshness-egress-gate.test.js \
  packages/api/test/freshness-hold-callback.test.js \
  packages/api/test/route-serial-freshness-hold.test.js \
  packages/api/test/route-parallel-freshness-hold.test.js \
  packages/api/test/freshness-review-continuation.test.js \
  packages/api/test/fast-lane-freshness-hold.test.js \
  packages/api/test/freshness-hold-expiry-scheduler.test.js \
  packages/api/test/freshness-holds-route.test.js \
  packages/api/test/integration/freshness-hold-two-agent.test.js
pnpm test:api:redis
pnpm --filter @cat-cafe/mcp-server test
```

当前已有内存/Redis store、Gate、callback、serial/parallel、Queue/Web/Connector、fast-lane、active-holds、Web 刷新恢复通知条、deadline scheduler 和确定性双 Agent 路由碰撞集成测试。该测试用两个独立 Agent service invocation 复现 B 在 A 生成中途正式发布，验证 A 的旧稿被 Hold 并经 successor 重审；它仍不是连接外部 provider 的现场运行证据。统一持久审计流、Publication Coordinator 和 publication/restart reconciler 仍未完成，因此不得把更大的 F193 全部愿景宣称为完成。

生产 rollout 默认关闭：仅当 `CAT_CAFE_FRESHNESS_HOLD_ENABLED=true` 时注入 Gate；可用 `CAT_CAFE_FRESHNESS_HOLD_CATS` 与 `CAT_CAFE_FRESHNESS_HOLD_THREADS`（逗号分隔）做交集灰度。将总开关改回非 `true` 即恢复 legacy 路由；HoldStore 的过期 sweep 与只读恢复 API 继续保留，避免已有私有稿件因回滚被误发布。

## Agent 注入盘点

当前 Clowder 的家规不是按 Agent 名称硬编码，而是跟随 `toolPolicy` 走：

```text
Agent 默认 toolPolicy
  ↓
route-serial / route-parallel 解析用户是否显式要求轻度/标准/重度工具箱
  ↓
buildStaticIdentity(catId, { toolPolicy })
  ↓
注入 core 或 operational 家规
  ↓
buildInvocationContext(...)
  ↓
如果命中 Magic Words，再注入 shared-rules.md 原文片段
```

典型映射：

- `minimal`：Pi、任务接收、任务拆分、微信/IM 默认轻回复、短问候自动降级。
- `standard`：Codex、Claude、Kimi、OpenCode 等工程/协作 Agent。
- `full`：PPT 设计、UI 设计、Design Harness、需要重工具和长资料的专项 Agent。

用户仍可通过提示词覆盖默认工具箱：

- `轻度工具箱`：只要核心家规和当前消息，适合快问快答。
- `标准工具箱`：带运营家规、工作区上下文和必要历史。
- `重度工具箱`：加载全量上下文和重工具，适合调研、PPT、复杂工程。

## 与 Slock 的对照

Slock 的“家规”不是一个单独的长文档，而是多层运行契约：

- Runtime/daemon：消息读取、thread 回复、task claim、reminder、freshness gate 等硬规则。
- AGENTS.md/CLAUDE.md：当前工作区的项目级规则。
- MEMORY.md/notes：长期记忆、用户偏好、项目历史。
- Skill：按任务触发的专用规则。

Clowder 当前已经复刻了前三层中的一部分：

- Runtime：有 `clowder` CLI、task 认领/更新、正确 surface 回复约束。
- 项目规则：用 `shared-rules.md` 摘要 + `toolPolicy` 分层注入。
- Skill：已有 `cat-cafe-skills` 与 Harness Skills 提示。

当前对齐状态：

- Agent 级跨会话 memory 和 reminder/唤醒已有本地 runtime 实现，边界见下文 task #179。
- F193 已建立发布前 Freshness Hold 闸门，但它保护的是有可信 baseline 的 same-thread invocation 和 stdout，不等价于 Slock 对任意持久身份/跨 surface 发布的全局“先读 inbox 才能发”门禁。
- 尚未对齐的是统一持久审计流、刷新后通知卡、publication/restart reconciler，以及 agent-key / cross-thread 的可信已读水位。

## 当前风险与收敛规则

### 风险 1：日常回复过度结构化

原因：运营家规强调证据和 quality-gate，工程类 Agent 容易把任何回复都当成交付报告。

收敛：`GOVERNANCE_OPERATIONAL_DIGEST` 已明确：

```text
日常对话和轻量问答用自然语言短答；
只有任务完成、review、handoff、BLOCKED 等状态迁移才需要结构化报告。
```

### 风险 2：Agent 资产卡与家规冲突

优先级：

```text
用户当前指令
  > 安全/危险操作确认
  > 家规硬边界
  > Agent 资产卡
  > Skill/Pack 建议
```

如果资产卡要求固定模板，但当前只是日常问答，应优先自然短答。

### 风险 3：规则膨胀

`shared-rules.md` 原文只能按 Magic Words 或审计场景读取，不允许重新变成所有 Agent 常驻全文。

## task #179：MEMORY 与提醒唤醒闭环

### 跨会话记忆

Clowder 现在对齐 Slock 的 `MEMORY.md` 思路：每个 Agent 有一份独立持久记忆，位置为：

```text
.cat-cafe/memory/{catId}.md
```

运行时会在 `route-serial` / `route-parallel` 里读取当前 `catId` 的 memory 文件，作为 `Agent Memory（跨会话记忆）` 注入 `buildStaticIdentity()`。这保证：

- 页面刷新、API 重启后仍能读回。
- 不依赖当前 thread 历史。
- 每个 Agent 记忆隔离，避免 Codex/Kimi/Pi 互相污染。

CLI/API：

```bash
clowder memory read --cat gpt52
clowder memory write --cat gpt52 --text "# Codex Memory\n..."
PATCH /api/cats/:catId/memory
```

### 提醒 / 唤醒

Clowder 现在新增本地提醒存储：

```text
.cat-cafe/reminders.json
```

提醒到期后，API scheduler 会做两件事：

1. 在目标 thread 写入一条 `Clowder Reminder` 系统提示消息。
2. 把目标 Agent enqueue 到 invocation queue，并 `tryAutoExecute()` 自动唤醒。

CLI/API：

```bash
clowder reminder schedule --target default --cat gpt52 --time 10m --msg "检查这件事"
clowder reminder list --cat gpt52
clowder reminder cancel --id <reminderId>
POST /api/reminders
```

### 当前边界

- 这是本地 runtime 级能力，不是多设备云端提醒。
- reminder scheduler 随 API 进程运行；API 不运行时不会触发，到期后下次 tick 会补触发。
- memory 写入目前是显式 API/CLI，不做模型自动总结写入，避免未审核记忆污染。
