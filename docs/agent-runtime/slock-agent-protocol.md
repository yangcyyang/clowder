---
feature_ids:
  - F193
topics:
  - agent-runtime
  - freshness
  - message-delivery
doc_kind: runtime-protocol
created: 2026-05-27
updated: 2026-07-11
---

# Clowder Slock-like Agent Protocol

## 目标

Clowder 的 Agent 运行要从“收到一条消息就直接触发模型”升级为 Slock-like 的成熟秘书协议：

```text
收件 → 归类 → 合并最新意图 → 判断讨论/任务 → claim → 执行 → 交付 → 验收
```

这份协议是 task #180 / #181 / #182 的上游规则文档：先固定行为边界，再分别落到 inbox、阶段门禁和执行闭环审计。

## 背景问题

Clowder 现有能力已经补齐了很多底座：

- task discipline 提示注入
- Clowder CLI task/message 命令
- thread 归属与回复隔离
- toolPolicy 工具箱分层
- contextBudget 诊断与裁剪
- Agent 可取消与阶段进度展示
- 跨会话 memory 与 reminder

但它仍偏“聊天触发模型”：

- Agent 常只处理触发它的那一条消息。
- 用户连续补充时，Agent 容易按旧消息开始执行。
- 长流程 Agent 容易跳过确认门禁。
- task claim / evidence / in_review 主要靠提示约束，缺少统一审计协议。

Slock 的优势不是模型更强，而是消息协议更稳：每条消息有明确 surface，Agent 有 inbox freshness，任务有 claim/in_review 纪律，thread 不污染主频道。

## 核心概念

### Surface

Surface 是一次对话发生的位置：

- channel
- thread
- DM
- connector thread（微信、飞书等 IM 映射出的 thread）

Agent 只能默认读取当前 surface，不应跨频道扫描历史。

### Inbox Window

Agent 被唤醒时，需要读取当前 surface 中尚未处理的用户消息窗口，而不是只看触发消息。

建议窗口：

- 普通 thread：最近 20 条未处理/相关消息
- 长 thread：最近 20 条 + thread digest
- connector DM：最近 10 条

### Intent Snapshot

Intent Snapshot 是同一 surface 当前最新任务理解。

它不是简单拼接消息，而是要合并用户连续补充，并处理覆盖关系：

- 后发的“先别做”覆盖前面的“开始做”。
- 后发的“换成 HTML”覆盖前面的“导出 PPT”。
- 同一主题补充材料应合并到当前阶段输入。

### Task Gate

当用户消息是行动任务时，Agent 必须进入 task gate：

```text
识别 action intent
  → 绑定/创建 task
  → claim task
  → 执行
  → 写入交付证据
  → 标记 in_review
```

没有 claim，不应写文件、改代码、启动构建或声称完成。

### Stage Gate

长流程 Agent 必须按阶段推进。典型如 PPT Agent：

```text
需求收集
  → 需求确认
  → 大纲生成
  → 大纲确认
  → 策划稿生成
  → 策划稿确认
  → 设计初稿
  → 调整
  → 导出
```

每一阶段的产物采用三件套：

```text
*.md    给人阅读和编辑
*.json  给系统执行，作为真相源
*.html  给用户预览和确认
```

用户未确认当前阶段，不进入下一阶段。

## 运行协议

### 1. 收件

Agent invocation 创建前，后端应解析当前 surface：

```text
threadId / channelId / dmId
triggerMessageId
catId
lastProcessedCursor(catId, surfaceId)
```

然后读取：

```text
newMessages = messages after lastProcessedCursor in same surface
```

如果没有 cursor，回退为最近 N 条消息，但必须限制在当前 surface。

### 2. 归类

对 Inbox Window 内消息做轻量分类：

- discussion：解释、方案、询问、确认
- action：修复、构建、执行、导出、检查、排查、推进
- correction：先别做、等等、换方向、不是这个
- approval：确认、可以、开始做、按这个来
- stage-input：补充资料、补充要求、改大纲、调整策划稿

分类结果进入 Intent Snapshot。

### 3. 合并最新意图

合并规则：

1. 同一 surface 内，后发 correction 优先级最高。
2. approval 只对最近一个待确认阶段生效。
3. action 需要 task gate。
4. stage-input 只更新当前阶段缓冲区，不自动越级执行。
5. 多个独立 action 应拆成多个 task，而不是塞进一次 invocation。

输出结构建议：

```json
{
  "surfaceId": "thread-123",
  "triggerMessageId": "msg-456",
  "intentType": "action | discussion | correction | approval | stage-input",
  "latestInstruction": "用户当前最新指令",
  "supersededMessageIds": ["msg-old"],
  "requiresTask": true,
  "requiresUserConfirmation": false,
  "stage": "outline_review",
  "toolPolicyHint": "minimal | standard | full"
}
```

### 4. 判断讨论还是任务

如果是 discussion，Agent 直接回复，不 claim。

如果是 action，必须走 task gate。

触发 action 的关键词包括但不限于：

- 修复
- 推进
- 执行
- 构建
- 导出
- 检查
- 排查
- 改造
- 写入
- 备份
- push
- 你来做

### 5. 执行与交付

执行任务时，Agent 输出必须包含验收证据：

- 代码类：commit、文件、测试命令、测试结果
- 文档类：文档路径、关键内容、决策摘要
- PPT 类：MD / JSON / HTML / PPTX 产物路径
- 调研类：来源、结论、风险

如果不能执行，必须明确 BLOCKED，并说明缺什么。

### 6. Cursor 更新

一次 invocation 完成后，应更新：

```text
lastProcessedCursor(catId, surfaceId) = max processed message seq
```

如果任务被取消，不应把未处理消息全部吞掉。取消时只标记当前 invocation 消费到的 cursor。

## F193：Freshness Hold 出口协议

Inbox freshness 保证 Agent 开始时看到新意图；Freshness Hold 保证 Agent 结束时不会把基于旧上下文的稿件发出。它是一道发布闸门，不是内容相似度判断。

### 保护范围与身份边界

首版保护：

- serial / parallel 路由生成的最终 stdout，包括纯文本与 rich-block-only 回复。
- 带 invocation 凭证、且发往本 invocation 原 thread 的 callback `post-message`。
- Web 直接执行、`QueueProcessor` 和 `ConnectorInvokeTrigger` 消费上述结果时的 history、WebSocket、rich block、TTS、push、A2A 和 connector outbound 出口。
- `QueueProcessor` fast-lane 成功结果：工作流执行前捕获 baseline，只有 Gate 返回 `published` 后才可把完成正文或原始执行结果放入 history、agent WebSocket 和 task completion 可见内容；被 Hold 时 task event 只保留安全元数据。
- callback 发布工具的 `tool_use` / `tool_result` 也是稿件出口：受保护路由先私有缓冲，只有工具结果确认 `published` 才释放；`held` / `discarded` 不得把 `toolInput.content` 送入 WebSocket 或前端 tool detail。
- 有 freshness baseline 的 invocation 在 verdict 前不得写原始 transcript 或 agent memory。当前采用 fail-closed 策略：即使最终 published 也不自动补写这两个持久 sink，避免旧稿经 transcript search/import 回到 history。

明确的 legacy 边界：

- `agent-key` 身份没有可信的“本轮已读水位”，仍走旧发布路径。
- invocation 使用 callback 跨 thread 发布时，原 thread 的 baseline 不能证明它已读目标 thread，仍走旧路径。
- 只有 `same-thread + invocation-auth + 已持久化 freshnessBaseline` 的 callback 可标记为 protected。不得把 legacy 成功响应解读为经过 Freshness Hold。

### 结构分类：什么会推进水位

Freshness 只看受信任结构字段，不根据正文猜测“这是不是进度”。

- `messageClass: substantive`：实质消息，受发布保护并推进可见水位。为了向后兼容，未标注 `messageClass` 的普通消息也按 substantive 处理。
- `messageClass: status`：受信任运行时产生的进度/存活提示，不推进水位，也不能自己卡住自己。LLM callback schema 只允许 substantive，不能自报 status 绕过闸门。
- 受信任 system 消息、`origin: briefing`、`a2a_routing` 和 `progress_heartbeat` 是结构性豁免。已删除、tombstone 或 `deliveryStatus: canceled` 的消息不再参与 freshness。

Delivery 生命周期的规则：

- `queued` 在 append 时立即取得序号并推进水位，避免另一只猫跨过正在排队的新意图；但它在 delivered 前不进 history，不触发 `onAppend`。
- `markDelivered` 只改变可见性和交付时间，不再分配新水位。
- `markCanceled` 会从 freshness 索引移除该消息。

Audience 与可见性一致：public 消息对 thread 内所有猫推进水位；未 reveal 的 whisper 只对 `whisperTo` 收件猫推进，reveal 后才转为 public 影响。

### Per-thread watermark 契约

MessageStore 给每个 thread 维护一个单调递增序列，每条 freshness-relevant append 只分配一次 `appendWatermark`。水位是不透明的十进制字符串；MessageStore 以外的代码只能原样传回，禁止转成 JavaScript `number` 或自行比较。

```text
读取上下文前 captureFreshnessWatermark(thread, cat)
  → 将 baseline 持久到 InvocationRecord
  → Agent 在私有缓冲区生成完整稿件
  → appendIfFresh(draft, baseline, audience)
      ├── 无独立新 append：同一线性化点 append，返回 published
      └── 存在独立新 append：零正式发布，返回 stale 并创建/重放 hold
```

普通 append 与条件 append 在 Redis 中共用同一 Lua 线性化点，不存在 `check → append` 的 TOCTOU 窗口。并行路由中同一 parent invocation group 的 sibling 输出不互相卡住；任何用户或独立 invocation 的新 append 仍会触发 hold。

Delta 默认最多返回 50 条。如果 `truncated: true`，`observedWatermark` 只能前进到本页最后一条已物化消息，不能跳过 Agent 尚未看见的消息。

### Hold / review 状态机

```text
held --claimReview(version CAS)--> reviewing
  |                                  ├── appendIfFresh 成功 → released → delivered
  |                                  └── 再次 stale → held
  └── discard -------------------------------> discarded

held/reviewing --30 分钟截止或第 2 次复核仍冲突--> needs_attention
```

- `held`：完整稿件、baseline、observed watermark 和 delta message IDs 已持久化，正文尚未发布。
- `reviewing`：某一个 reviewer 已通过 version CAS 获得处理权；该状态也是可恢复的崩溃中间态。
- `released`：HoldStore 已记录唯一 `releasedMessageId` 与 committed watermark；闸门随后将该 queued 消息标记 delivered。终态 CAS 同时擦除私有 draft 与 delta，只保留幂等恢复 tombstone。
- `discarded`：稿件明确放弃，重试不得复活它；终态 CAS 同样擦除私有 draft 与 delta。
- `needs_attention`：超时或连续两轮 review 仍冲突的 fail-closed 终态。稿件持久保留、不设自动删除 TTL，且绝不自动发送。

30 分钟从首次 hold 创建时起算，re-hold 不重置截止时间。运行时启动时立即执行一次 `expireDue()`，之后默认每 60 秒扫描一次；因此超时状态按轮询粒度收敛，而不是精确到截止时刻。claim/release/re-hold 仍会在迁移时再次检查 deadline 并 fail closed。

### 两条 review 回路

Callback 仍在活跃 invocation 内时：

1. `cat_cafe_post_message` 收到 `freshness_held`，同一 tool result 携带 `holdId`、最新 version 和 `newMessages`。
2. Agent 读完 delta 后调用 `cat_cafe_review_held_message`，选择 `replace` / `send_draft` / `discard`。
3. review endpoint 必须使用创建 hold 的同一 invocation 凭证与最新 `expectedVersion`；发送或改写前会再做一次原子 freshness 检查。

Stdout 已结束、无法把 tool result 回填原调用时，运行时使用独立 `freshness_review` continuation。可见 QueueEntry 只携带安全占位文本、hold 所有权五元组和 CAS version；完整稿件与 delta 保留在 QueueProcessor 的私有内存中，delta 在 dispatch 前再按 message IDs 从 MessageStore hydrate。后继 invocation 只需输出一个完整 replacement。

`freshness_review` 是 urgent / pinned / autoExecute 控制项，与 session-seal continuation 独立。去重键为 `freshness-review:<holdId>:<expectedVersion>`；`discarded` / `needs_attention` / reviewCount 达 2 时不再续排。该队列与私有 payload 是进程内状态，API 重启会丢失自动 review 调度；Redis hold 仍保留且任何后续复核仍会按 deadline fail closed，但当前没有重启 reconciler 自动重建 continuation。

### Verdict 是所有出口的唯一凭据

| Gate 结果 | 允许的副作用 |
|---|---|
| `published` | 正式 history append/deliver，然后才可释放 WebSocket 文本、rich block、TTS、push、A2A 和 connector outbound |
| `held` | 只允许发送无稿件正文的 hold 提示、更新外部 placeholder 为“重新审阅”、调度有界 review |
| `needs_attention` | 在消费层按 held 处理；只允许人工介入提示，不再自动 review 或发送 |
| `discarded` | 不发布任何稿件内容，不产生“空成功”替代文本 |

路由层将 per-cat verdict 写入 `PersistenceContext.egressByCat`，HTTP、队列和 connector 只能消费该 verdict，不得根据“有没有 stdout”二次猜测。私有 draft 不得被 GET history、重启恢复、流式 chunk、tool detail、task event、transcript、agent memory 或 connector 占位符泄漏。Rich block 也按 per-cat verdict 过滤；混合多猫结果只交付 published 的猫。

### 幂等与崩溃恢复

- 初次提交以 `(invocationId, submissionKey)` 去重。重试在任何 append 前先重放已有 hold 或终态，不会因水位回落复活旧稿。MCP `post_message` 每次工具调用会生成 `clientMessageId`，同一传输重试复用该 ID；主动再次调用时应显式复用 ID。Stdout 使用确定性 submission key。
- review 用 version CAS 保证只有一个 reviewer 赢得迁移；待发稿用 `freshness-hold:<holdId>` 作为消息幂等键。
- 发布顺序是 `reviewing → queued append → released CAS → delivered`。queued 阶段不进 history；即使 API 在中间崩溃，也优先“多保留一条私有稿”而不是重复发布。
- 在 queued append 后、released CAS 前崩溃，同一 review 重试可从 `reviewing` 恢复并取回同一条幂等消息；released 后、delivered 前崩溃，重放 released 会补做 `markDelivered`。并发败者不得取消已被胜者引用的消息。
- 当前没有独立 publication outbox/reconciler。如果崩溃后永远没有后续重试，`reviewing + queued` 或 `released + queued` 可能长期保持私有；终态引用丢失会报错而不会重复发布。这是已知 fail-closed 运维边界。

## 与现有模块的关系

### toolPolicy

本协议不替代 `toolPolicy`。二者关系是：

```text
Intent Snapshot 决定要做什么
  → toolPolicy 决定背多少上下文和工具
```

默认建议：

- discussion / short answer：minimal
- coding / debugging：standard
- PPT / UI / design / research-heavy：full

用户显式说“轻度工具箱 / 标准工具箱 / 重度工具箱”时，以用户覆盖为准。

### contextBudget

`contextBudget` 用于展示和限制本次调用背了多少内容。

本协议要求：Inbox Window 和 Intent Snapshot 必须计入 contextBudget，方便用户知道 Agent 是否背了过多历史。

### memory / reminder

memory 是长期偏好，不应替代当前 surface 的 inbox。

reminder 是未来唤醒，不应跳过 inbox freshness。提醒触发后仍要读取当前 surface 最新消息，避免基于过期状态行动。

### task board

task board 是行动任务的状态源。

任何 action intent 都应该绑定 task，且 task 线程是任务交付证据的主要承载位置。

## 分阶段落地计划

### Phase A：协议文档

对应 task #183。

交付：

- `docs/agent-runtime/slock-agent-protocol.md`
- 明确 inbox、intent snapshot、task gate、stage gate、cursor、验收证据规则

验收：

- 后续 task #180/#181/#182 能直接引用此文档执行。

### Phase B：Agent Inbox + 最新意图合并

对应 task #180。

建议实现：

- 新增 `AgentInboxService`
- 维护 per-cat per-surface cursor
- invocation 前生成 `IntentSnapshot`
- 将 snapshot 注入 Agent system/user context

验收：

```text
用户连续发：
1. 开始做
2. 等等，先别做
3. 先给方案

Agent 最终只给方案，不执行代码。
```

### Phase C：长流程阶段门禁

对应 task #181。

建议实现：

- 新增 thread-level `stageState`
- 支持 `stageBuffer`
- approval 才推进 stage
- PPT Agent 先接入三件套产物协议

验收：

- 未确认大纲不能生成策划稿。
- 未确认策划稿不能生成设计稿。
- 用户补充资料只更新当前阶段输入。

### Phase D：执行闭环审计

对应 task #182。

建议实现：

- 检查 action intent 是否绑定 task
- 检查 task 是否被 claim
- 检查 in_review 是否有 evidence
- 对违规 Agent 生成审计告警

验收：

- Agent 只说“我正在做”但没有证据时，不能进入 in_review。
- 代码任务没有 commit/test 结果时，提示缺交付证据。

## 非目标

本轮不做：

- 重写全部 routing。
- 让所有 channel 自动广播给所有 Agent。
- 把 Slock daemon 原样搬进 Clowder。
- 取消现有 toolPolicy / contextBudget / memory 机制。

本轮只补“成熟秘书协议”：先收件、合并、确认，再执行。

## 风险与约束

### 风险 1：过度自动合并导致误判

缓解：Intent Snapshot 必须可见，可在运行详情里展示“本次理解”。

### 风险 2：task 自动创建过多

缓解：action intent 才绑定 task；discussion 不创建 task。

### 风险 3：长流程卡在确认门禁

缓解：UI 明确显示“等待用户确认”，并提供确认按钮。

### 风险 4：cursor 吃掉未处理消息

缓解：只有成功生成 Intent Snapshot 并完成/明确取消后才推进 cursor。

## 成功标准

Clowder 达到以下行为，即认为本协议第一版成功：

1. 用户连续补充时，Agent 能合并最新意图。
2. 用户撤销/修正时，Agent 不继续执行旧指令。
3. 行动任务必须 claim 后执行。
4. 长流程必须等用户确认再推进。
5. 所有执行任务有可验收证据。
6. thread 内消息不污染主频道。
7. 重启/取消后不会丢掉未处理用户消息。
