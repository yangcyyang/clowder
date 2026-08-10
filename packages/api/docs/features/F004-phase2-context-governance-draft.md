---
feature_ids: [F004]
related_features: [F003]
topics: [token, context, prompt, governance, cost, raft]
doc_kind: spec
created: 2026-07-13
---

# F004 二期：Context 治理草案

> Status: draft | Priority: P1 | Owner: kimi
> 材料来源：RAFT 官方文档（公开资料线）+ Pi 抓包报告 + RAFT 运行态 agent 自述

## 执行摘要

RAFT 的上下文策略不是全面更省，而是**把 token 浪费最大的两根水管关掉——默认不重放频道历史，以及忙时把 N 条消息合并成一次调用**。它的真实策略可归纳为四段式：

1. **跨唤醒不重放**：agent 只收到新消息信封，历史不自动进上下文；需要时自己拉取。
2. **会话内照样累积**：同一次会话内仍线性增长，到顶触发压缩摘要。
3. **固定注入并不小**：系统提示 8–12k token + 记忆 + 技能清单，与 Clowder 同量级。
4. **忙时批量合并投递**：agent 忙碌或间隙期，N 条短消息不逐条唤醒，攒成一个批次一次投递，批内各消息带独立信封头。

Clowder 当前最大的两个出血点恰好是 RAFT 省掉的部分：**每次 invocation 都把 thread 历史全量塞进 prompt**，导致 historyBudgetRatio 动辄 174–436%；**每条消息都触发一次完整调用**，连发 4 条补充说明就付 4 次全价。二期应围绕四个可抄设计展开：

- **thread 历史从"默认注入"改"新消息投递 + 按需拉取"**
- **content-free 未读通知**
- **压缩摘要 + memory 恢复闭环**
- **消息批量合并投递（与 F001 mention 补投合并设计）**

## 设计一：Thread 历史不再默认全量注入

### RAFT 的做法

- **客户端只传增量**：`POST /api/messages` 上行 payload 仅 934 字节，只有新消息文本 + channelId + 可选 @mention，不含历史、不含 System Prompt。
- **服务端组装上下文**：agent 被 @ 时，服务端从数据库取历史，通过 `/api/messages/context/{msgId}` 返回有界窗口（7–16 条 + `hasOlder`/`hasNewer`/`historyLimited` 标记）。
- **按需拉取**：agent 输入里只有"投递给我的新消息"，要看历史必须主动调用 `raft message read`。

### Clowder 现状

- `ContextAssembler.ts` 每次 invocation 从 `MessageStore` 取最近 N 条消息，拼接成 `[对话历史 - 最近 X 条]` 块，prepend 到 prompt。
- 当前默认 `maxMessages=20`、`maxTotalTokens=2000`，但长 session resume 时历史观测全量计算（`estimateFullHistoryTokens`），导致 `historyBudgetRatio` 174–436%。
- Agent 没有"只收到新消息"的概念，每一轮都背着一个历史包。

### 改动建议

| 层级 | 改动 | 文件/入口 |
|------|------|-----------|
| ContextAssembler | 新增 `deliveryOnly` 模式：只返回触发本轮调用的消息（A2A 触发消息或用户消息），不拼接历史窗口 | `domains/cats/services/context/ContextAssembler.ts` |
| SystemPromptBuilder | 在工具查询指南中强化"thread 历史只给最近窗口；需要更多时用 `cat_cafe_get_thread_context`" | `domains/cats/services/context/SystemPromptBuilder.ts` |
| Route Helpers | `getEffectiveRuntimeContextBudget('minimal')` 已把 `maxMessages=0`；二期将 `standard` 的默认历史窗口从 20 条降到 10 条（与当前 `STANDARD_CONTEXT_BUDGET_CAP` 对齐），并默认启用 hierarchical context | `domains/cats/services/agents/routing/route-helpers.ts` |
| 调用入口 | 在 `invoke-single-cat.ts` 中，对非 serial/parallel 的独立调用默认走 `deliveryOnly`；serial/parallel 仍保留必要窗口 | `domains/cats/services/agents/invocation/invoke-single-cat.ts` |

### 风险与缓解

| 风险 | 缓解 |
|------|------|
| 模型不习惯主动拉历史，导致漏看上下文 | SystemPrompt 中强制写明"缺历史用 `get_thread_context`，缺证据用 `search_evidence`"；harness 层面保留最近 2–3 条锚点消息 |
| A2A 派工场景需要更多上下文 | A2A 触发消息仍完整注入，并保留 `a2aTriggerContent` 360 字摘要 |
| Serial/Parallel 链式调用依赖前文 | serial 模式保留最近窗口；parallel 模式本来就不要历史 |

---

## 设计二：Content-Free 未读通知

### RAFT 的做法

- agent 被唤醒前收到的是 **content-free 收件箱通知**：只有"几条未读、谁、哪个频道"，不含正文。
- agent 自主决定拉哪些消息：`raft message check/read`。
- 配合 `MEMORY.md` 恢复长期状态，形成"通知 → 拉取 → 恢复"三层补齐。

### Clowder 现状

- 当前没有独立的未读通知层。每次 invocation 直接把完整消息内容塞进 prompt。
- `get_pending_mentions` 工具存在，但它返回的是 mention 列表，不是 content-free 通知；agent 也不靠它来决定是否拉历史。

### 改动建议

| 层级 | 改动 | 文件/入口 |
|------|------|-----------|
| 新工具 | 新增 `cat_cafe_check_inbox`：返回未读消息数量、发送者、threadId、消息 ID，不含正文 | MCP 工具注册表 |
| 调用入口 | agent 被唤醒时，先注入一个轻量 `inbox` 块（<50 tokens），列出未读；正文不注入 | `domains/cats/services/agents/invocation/invoke-single-cat.ts` |
| 模型引导 | SystemPrompt 增加："如果你被唤醒但只看到 inbox 摘要，用 `get_thread_context` 按需拉回正文" | `SystemPromptBuilder.ts` |
| 通知水位 | `DeliveryCursorStore` 已维护 per-session cursor，可复用它计算未读数 | `domains/cats/services/stores/ports/DeliveryCursorStore.ts` |

### 风险与缓解

| 风险 | 缓解 |
|------|------|
| 模型漏读重要消息 | inbox 保留消息 ID 和发送者；A2A 触发消息仍完整注入 |
| 多 thread 同时唤醒 | inbox 按 thread 分组，只列出当前 thread 和 DM 的未读 |
| 与现有 `@mention` 路由冲突 | content-free 通知不改变路由逻辑，只在 prompt 层减少正文注入 |

---

## 设计三：压缩摘要 + Memory 恢复闭环

### RAFT 的做法

- **会话内线性增长到顶压缩**：同一会话内每轮 = 完整对话历史 + 新消息，直到逼近窗口触发 compaction。
- **压缩摘要结构固定**：`Primary Request / Key Concepts / Files / Errors / User messages` 等固定章节。
- **跨会话恢复**：旧会话被 compact 后，下轮用摘要 + `MEMORY.md` 恢复状态。
- **显式 reset 阀**：`session reset` 清除对话上下文但保留 workspace；`full reset` 全清。

### Clowder 现状

- 已有 `historyMode: 'observe' | 'shadow-summary' | 'summary-active'` 类型和阈值配置。
- 当前默认 `CAT_CAFE_HISTORY_GOVERNANCE` 未启用或处于 `observe`，全部历史仍进 prompt。
- `shadow-summary` 已立案但未启用；`formatThreadHistorySummary` 已能把老消息压缩成 segment 摘要。
- `contextUsageWarning` 已存在，提示模型回写 `.cat-cafe/memory/{catId}.md`，但缺少"到顶自动压缩"的一等机制。
- `CollaborationContinuityCapsule` 已支持 `compact_boundary` 续接原因。

### 改动建议

| 层级 | 改动 | 文件/入口 |
|------|------|-----------|
| 启用 shadow-summary | 将 `CAT_CAFE_HISTORY_GOVERNANCE=shadow-summary` 作为 standard/full 猫的默认，minimal 猫保持 delivery-only | 环境变量 + `route-helpers.ts` |
| 摘要质量门 | 复用 `validateThreadHistorySummaryQuality`，先 shadow 跑 100 次，确认无 `empty_summary` / `summary_overlaps_recent_window` 等问题 | `route-helpers.ts` |
| 自动压缩触发 | 当 `historyBudgetRatio >= criticalRatio(0.9)` 时，自动触发 session seal 并生成 continuity capsule，下一 invocation 用摘要 + memory 恢复 | `SessionSealer.ts` + `CollaborationContinuityCapsule.ts` |
| 记忆回写强化 | `contextUsageWarning` 升级到"必须执行"：critical 级别强制要求模型在回复中写 memory；harness 在调用结束后把 memory 写回 `.cat-cafe/memory/{catId}.md` | `SystemPromptBuilder.ts` + 调用后处理 |
| 用户显式 reset | 新增 `/reset-context` 或类似命令，允许铲屎官手动触发 session reset（清上下文、留 workspace） | 新路由 |

### 风险与缓解

| 风险 | 缓解 |
|------|------|
| 摘要丢失关键文件路径/命令 | 摘要保留固定章节；模型需要精确证据时用 `fetch_thread_history` 拉原文 |
| 自动 seal 打断长流 | criticalRatio 0.9 才触发；触发前 high 级别已给模型机会主动收尾 |
| memory 写回失败导致状态丢失 | 每次压缩前把 continuity capsule 持久化；memory 写回失败时回退到 capsule |

---

## 设计四：消息批量合并投递

### RAFT 的做法

- **忙时/间隙攒批**：当 agent 正在处理任务或处于短暂间隙时，用户连续发送的 N 条短消息不会逐条唤醒 agent，而是合并成一个批次一次性投递。
- **批内独立信封**：合并后的批次里，每条消息仍保留自己的 `target/msg/time` 信封头，agent 能区分各条消息的发送时间和内容，但只触发一次 invocation。
- **会话内增量**：批次进入后，agent 的上下文 = 之前所有轮次 + 本批次新消息，线性累积；不是每轮重传频道全史。

> 实证：铲屎官连续发的 4 条"继续/收到"短消息 + 1 条 @agent 消息，在 11 秒内被合并为 1 个批次，只触发 1 次调用。

### Clowder 现状

- 当前 **每条消息独立触发一次完整 invocation**，每次都要背一次 8–15k token 的固定注入（系统提示 + 规则 + 花名册等）。
- 用户快速连发补充说明、追加要求时，Clowder 会付 N 次全价，而 RAFT 只付 1 次。
- 已立案的 BACKLOG F001（mention 忙时补投）本质也是"忙时攒批、空闲一次投递"，但当前与 context 治理没有合并设计。

### 改动建议

| 层级 | 改动 | 文件/入口 |
|------|------|-----------|
| 队列去抖 | 在 `InvocationQueue` 或 `QueueProcessor` 入队处加 5–10 秒合并窗口：同 thread + 同目标 cat + 非 A2A 紧急派工的消息，合并为一个 `BatchedMessageInvocation` | `domains/cats/services/agents/invocation/InvocationQueue.ts` |
| 批次格式 | 批次内消息列表按时间序排列，每条保留原始 `messageId`、`senderType`、`content`、`mentions`；注入 prompt 时格式化为 `[批量投递 - N 条]` 块 | `domains/cats/services/context/ContextAssembler.ts` |
| 与 F001 合并 | 将 F001 的"mention 忙时补投"与二期的"消息合并投递"统一为同一机制：忙时攒批 + 空闲/窗口到期一次投递；A2A 派工和 @mention 保留高优先级可立即打断合并 | BACKLOG F001 + 二期设计文档 |
| 实时性兜底 | 用户显式 @某猫并要求立即响应时，跳过合并窗口；窗口期内收到 A2A 派工，立即 flush 当前批次 | 路由/队列层 |

### 风险与缓解

| 风险 | 缓解 |
|------|------|
| 合并窗口降低实时性 | 默认 5 秒窗口；用户显式 @ 或 A2A 派工立即 flush；可 per-thread 配置 |
| 批内消息顺序错乱 | 批次内严格按 `timestamp` 排序；每条消息保留独立 envelope，模型可区分 |
| 重复处理或幂等问题 | 批次以 invocation 为单位消费；批内各消息 ID 写入 invocation 元数据，便于审计与去重 |
| 与现有 F001 补投逻辑冲突 | 统一设计后废弃 F001 独立实现，避免两套攒批逻辑并存 |

### 补遗：Mention 送达与唤醒解耦

RAFT 的 mention 哲学是：**"发起方发完即免责，送达责任归平台"**。这与 Clowder 当前"目标忙就提示发起方稍后重试"的体验形成鲜明对比。四个值得补进案卷的细节：

#### 1. 忙时"带内报数"（重点）

- 当目标 agent 正在执行任务时，RAFT 不打断它，而是往它**正在跑的回合里注入一条无正文提醒**："你有 N 条未读，来自谁、哪个频道，做完当前任务后必须处理"。
- 这是 content-free 通知的更强形态：不是等下一 invocation 才给 inbox，而是**当前回合就轻量提示**，既避免漏接，又不塞正文 token。

#### 2. 自然断点自取

- 批量拉取发生在 agent 自己任务的**自然间隙/完成后**，不是平台强插中断。
- 与 Clowder 的"强行入队被闸门拦"不同，RAFT 让目标在合适时机自己消费队列。

#### 3. Pending mention 带 TTL（重点）

- RAFT 连"@ 不在频道的人"都不会丢：返回一个 `pending mention action`，带 **7 天有效期**。
- 目标回来后仍可补投。
- Clowder 当前补投契约未定义 TTL，应给 pending mention 队列加明确过期策略（建议 7 天，与 RAFT 对齐或按业务调整）。

#### 4. 提醒卡片语义升级（UX 改动建议）

- Clowder 当前 busy mention 提示是"请稍后手动重试"——把重试责任推给发起方/铲屎官。
- RAFT 的逻辑是"已排队，目标空了自动接"——只是给人报信，不派活。
- 二期应把 busy mention 的提示卡片从"手动重试"改为"已入队，目标当前任务结束后自动唤醒"，并提供"立即唤醒"手动 override。

---

## 一期与二期的边界

| 维度 | 一期 P0（进行中） | 二期 P1（本草案） |
|------|------------------|------------------|
| 目标 | 减少固定注入体积 | 减少历史重放体积 + 减少调用次数 |
| 手段 | SystemPrompt 按猫/任务分级 | 历史默认不重放、按需拉取、摘要恢复、消息合并投递 |
| 代码改动面 | `SystemPromptBuilder`、`cat-budgets`、`invoke-single-cat` | `ContextAssembler`、`MessageStore`、`route-helpers`、`SessionSealer`、`InvocationQueue` |
| 是否改调用协议 | 否 | 是（新增 inbox 工具、context API 分页、批次 invocation、pending mention TTL） |
| 启用方式 | shadow 后逐步启用 | 先 canary thread，再全局 |

二期不依赖一期完成，但建议一期 shadow 通过后再启动二期代码改动，避免同时变两个变量导致归因困难。

## 验收标准（草案）

- [ ] AC-1：独立调用（非 serial/parallel）的 prompt 中不再包含 `[对话历史 - 最近 X 条]` 全量块，只保留触发消息 + 最多 3 条锚点。
- [ ] AC-2：`cat_cafe_check_inbox` 工具可用，返回内容 <50 tokens，且能正确列出未读消息 ID。
- [ ] AC-3：`shadow-summary` 模式下，historySummaryTokens 比 historyFullTokens 减少 80% 以上（目标：从数十万 token 降到几千 token）。
- [ ] AC-4：criticalRatio 触发自动压缩后，下一 invocation 能通过 continuity capsule + memory 正确续接，不丢失当前任务。
- [ ] AC-5：canary 运行 7 天，任务完成率、路由准确率、A2A 交接成功率相对 baseline 无回归。
- [ ] AC-6：提供一键回滚到 `observe` 模式的开关。
- [ ] AC-7：消息批量合并投递启用后，同 thread 同目标 10 秒内连发 N 条短消息只触发 1 次 invocation，固定注入只付 1 次。
- [ ] AC-8：目标 agent 忙碌时，@mention 不丢失、不立即打断，而是进入 pending mention 队列并带 7 天 TTL；目标当前任务结束后自动触发补投。
- [ ] AC-9：busy mention 的提示卡片语义从"请稍后手动重试"升级为"已排队，目标空闲后自动唤醒"，并提供铲屎官手动 override 入口。

## 依赖与阻塞

- **依赖**：一期 P0 的 `minimal`/`standard`/`full` 分级稳定运行；`DeliveryCursorStore` 已存在可复用。
- **阻塞**：需要铲屎官确认是否接受"模型必须主动拉历史"的行为改变；需要至少 1 个 canary thread 试点。
- **不需要等待**：RAFT 服务端黑盒参数（窗口/压缩阈值）已在本地 agent 自述中确认不在本地文件里，无法从外部继续深挖。

## 下一步建议

1. 宪宪/铲屎官 review 本草案，确认四个设计的优先级和接受度。
2. 选择 1 个 canary thread（例如当前 F004 讨论 thread）试点 `deliveryOnly` + `shadow-summary` + `消息合并投递`。
3. 由 gpt52 或宪宪输出二期详细技术设计，拆分 `ContextAssembler`、`route-helpers`、`SessionSealer`、`InvocationQueue` 改动任务。
4. 把 BACKLOG F001（mention 忙时补投）并入二期"消息合并投递"统一设计，避免两套攒批逻辑。
5. 二期开发前必须完成一期 P0 shadow 观测，避免同时变多个变量导致归因困难。
