---
feature_ids: []
topics: [context-governance, history-compaction, summary, continuity, cost-control]
doc_kind: spec
created: 2026-07-03
status: proposed
owner: 老者-codex
reviewer: 专家-Claude
---

# Phase 3：历史膨胀治理方案

> 一句话：长 thread 不再每轮背完整聊天记录；旧历史变成可追溯摘要，最近上下文保留原文，身份/任务/决策等高风险信息永远从真相源注入。

## 1. 目标与非目标

### 目标

- 控制长 thread 的 input/cache read 增长，避免单轮 token 随历史无限膨胀。
- 用已有 `summary_segments` / `summary_state` 做可审计摘要，而不是新建平行记忆系统。
- 保留最近对话、当前任务、用户最新指令和关键决策的原文，降低“失忆”和错接任务风险。
- 复用 `contextBudget` / `sourceBreakdown` 做灰度观测，先证明有效再默认启用。

### 非目标

- 本票不改代码，只固化阈值、摘要、风险防护和灰度方案。
- 不把 provider 内置 compaction 当作唯一治理手段；它只是最后保险。
- 不让摘要替代项目事实源、家规、权限边界、任务状态、Run Ledger。

## 2. 现有资产

Clowder 已有足够底座，Phase 3 应复用而不是重造：

- `model_context_window` / `model_auto_compact_token_limit`：每只猫的上下文窗口和自动压缩阈值。
- `contextBudget`：已有 `historyMessages`、`usesFullHistory`、`maxPromptTokens`、`maxContextTokens`。
- `sourceBreakdown`：usage 里已有提示词来源拆分，可继续补充 history/summary token 观测。
- `summary_segments`：append-only 摘要 ledger，包含 `from_message_id`、`to_message_id`、`message_count`、`summary`、`boundary_reason`、`model_id`、`prompt_version`。
- `summary_state`：thread 级摘要水位线，包含 `last_summarized_message_id`、pending 消息数/token 数和 `abstractive_token_count`。
- `CollaborationContinuityCapsule`：已有 `compact_boundary` 续跑语义，可作为 provider compact 后的接班提示。

## 3. 阈值策略

### 3.1 有效预算

每轮先算一个保守预算：

```text
effectiveContextBudget =
  min(model_context_window, model_auto_compact_token_limit || model_context_window)

promptBudget = effectiveContextBudget * 0.75
outputReserve = effectiveContextBudget * 0.20
safetyReserve = effectiveContextBudget * 0.05
```

原因：模型不是只吃 prompt，还要留输出、工具调用和 provider 内部开销。历史治理必须按 `promptBudget` 规划，不按满窗口规划。

### 3.2 四档模式

```text
L0 legacy
  默认行为，不替换历史。用于 flag off / 回退。

L1 observe
  只记录 historyFullTokens / historyMessages / budgetRatio，不改变上下文。

L2 shadow-summary
  生成或读取摘要，但仍发送完整历史；用于比较摘要质量和 token 节省。

L3 summary-active
  超阈值后，用“历史摘要 + 最近原文窗口”替代旧历史。
```

### 3.3 触发阈值

建议初始阈值：

- `budgetRatio >= 0.60`：进入 L1 观测告警，记录“历史开始偏重”。
- `budgetRatio >= 0.70` 或旧历史 `estimatedTokens >= 60k`：进入 L2，准备摘要。
- `budgetRatio >= 0.80`：进入 L3，启用摘要替换旧历史。
- `budgetRatio >= 0.90`：硬保护，缩短最近原文窗口，但不低于 12 条消息。

`budgetRatio` 计算口径：

```text
budgetRatio = estimatedPromptTokens / promptBudget
```

其中 `estimatedPromptTokens` 必须包含 system prompt、当前用户消息、最近历史、项目上下文、skill、MCP/工具说明。

### 3.4 最近原文窗口

默认保留最近 24 条 delivered messages 原文。

边界规则：

- 最少 12 条，防止硬压缩导致上下文断裂。
- 当前用户消息永远原文注入。
- 当前任务源消息、当前 thread 原消息、最近一次人工明确指令永远原文注入。
- queued/canceled/filtered 消息不进入摘要和原文窗口，避免旧噪声污染。
- 摘要水位线之后的新消息全部原文注入，直到下一次摘要生成。

### 3.5 防抖

不能每轮在 full history 和 summary 之间来回切。

策略：

- 一旦 thread 进入 L3，对该 thread 保持 summary-active，直到摘要水位线更新。
- 如果摘要生成失败，本轮回退 L0 legacy，并记录 `historyGovernance.degraded=true`。
- 摘要更新成功后，下一轮再切换，不在同一轮边生成边替换。

## 4. 摘要生成方式

### 4.1 生成时机

摘要生成不应阻塞用户当前请求，优先后台完成：

```text
消息写入
  → summary_state pending 增量
  → 达到 quiet window / token 阈值
  → 后台生成 summary_segment
  → 下一轮 ContextAssembler 可使用
```

如果 L3 需要摘要但没有可用摘要：

- 首选旧摘要 + 最近原文窗口。
- 没有旧摘要时，本轮回退完整历史。
- 不在用户当前请求里同步长摘要，避免慢上加慢。
- 摘要模型必须可配置，默认使用便宜模型；当前运行时使用 `CAT_CAFE_SUMMARY_MODEL`（默认 `claude-3-5-haiku-latest`）和 `CAT_CAFE_SUMMARY_MAX_TOKENS` 控制。

### 4.2 摘要输入

每个摘要 segment 的输入范围：

- `from_message_id` 到 `to_message_id` 的 delivered 消息原文。
- 上一个相关 segment 的短 carry-over。
- 当前 thread 的任务状态、关键决策、未解决问题。
- 必要时引用 Run Ledger 里的运行结果，但不把整段工具日志塞进摘要。

### 4.3 摘要输出结构

模型可以输出自然语言，但程序侧必须解析/存储为可消费结构：

```text
历史摘要（thread scoped）

范围：
- threadId
- from_message_id
- to_message_id
- message_count
- generated_at
- model_id / prompt_version

稳定事实：
- 用户长期偏好
- 当前项目/任务事实
- 已确认决策
- 约束和禁止事项

当前状态：
- 正在推进什么
- 已完成什么
- 下一步是什么
- 谁在等谁

风险：
- 摘要不确定点
- 可能需要回看原文的锚点

证据锚点：
- 关键消息 id / range
```

落库仍使用现有 `summary_segments.summary` 作为正文，`from_message_id` / `to_message_id` 做 provenance。后续如果需要结构化字段，再在 read model 层派生，不先改 schema。

### 4.4 注入格式

ContextAssembler 注入时应清楚告诉模型这是摘要，不是完整原文：

```text
[Thread History Summary]
Scope: thread_xxx, messages A..B, generated_at=...
This is a compressed, provenance-backed summary of older delivered messages.
If a precise quote, file path, command output, or decision evidence is needed, call `cat_cafe_fetch_thread_history` with a narrow segment range/query instead of guessing.

...

[Recent Messages]
最近 24 条 delivered messages 原文
```

## 5. 失忆风险防护

### 5.1 永远不靠摘要承载的信息

这些信息必须从真相源/当前输入注入，不能被摘要替代：

- Agent 身份、角色、权限边界、家规 digest、dangerous operation rules。
- 当前用户消息和本轮 task/route 决策。
- 当前 task 状态、assignee、验收要求。
- Project brief/progress/decisions/handoff-index。
- Run Ledger 的当前 invocation 状态。
- 文件路径、命令输出、测试结果、credential 相关内容。

### 5.2 摘要质量闸门

启用 L3 前做轻量检查：

- summary 覆盖的 `to_message_id` 必须早于最近原文窗口起点。
- summary 不能为空，长度不能低于最低阈值。
- summary 必须包含范围、当前状态、决策/约束、下一步、风险锚点。
- `abstractive_token_count` 异常膨胀时不启用，避免摘要比历史还重。
- 发现 secret-like 内容时不注入摘要，走 redaction 或回退。

### 5.3 失忆 smoke

灰度线程每次进入 summary-active 后跑 4 个检查问题：

```text
1. 你是谁？当前身份/边界是什么？
2. 当前任务是什么？验收标准是什么？
3. 最近一个已确认决策是什么？
4. 下一步应该做什么？有什么风险？
```

如果回答缺关键事实，判定为 `summary_recall_failed`，该 thread 回退 L0，并把失败写入观测日志。

### 5.4 按需原文拉取工具

模型遇到摘要不确定时，不再只输出“请人工回看”。必须优先使用只读 MCP 工具按需拉取原文：

```text
cat_cafe_fetch_thread_history({
  threadId: "thread_xxx",
  fromMessageId: "from_message_id",
  toMessageId: "to_message_id",
  limit: 24,
  maxTokens: 8000
})
```

使用规则：

- 摘要 segment 提供 `from_message_id..to_message_id` 时，优先按范围拉取。
- 不知道范围但知道关键词时，使用 `query` 窄查，不允许整条 thread 拉满。
- 单次返回必须受消息数和 token 上限约束，默认 24 条 / 8000 tokens，可通过 `CAT_CAFE_HISTORY_FETCH_MAX_MESSAGES`、`CAT_CAFE_HISTORY_FETCH_MAX_TOKENS` 调整。
- 工具返回的原文 token 也算入本轮上下文预算；连续多次拉取要记录频率和 token 量。
- prompt 必须明确：摘要缺细节就用工具取，不能猜。

## 6. 与 provider auto compact 的关系

`model_auto_compact_token_limit` 不是 Phase 3 的主机制，只是最后保险。

治理顺序：

```text
Clowder history governance
  → 控制送进 provider 的 prompt
  → 若仍触达 provider compact boundary
  → 使用 compact_boundary continuity capsule 接班
  → 下一轮重新注入身份/任务/最近状态
```

验收重点：

- 确认 Codex CLI 确实收到 `model_context_window` 和 `model_auto_compact_token_limit`。
- 记录 compact boundary 到 Run Ledger / debug event。
- compact 后必须重新注入 system prompt、当前任务和 thread memory，不能依赖 provider 内部记忆。

## 7. 灰度步骤

### Phase 3A：observe-only

- 默认开启观测，不改变上下文。
- 在 `contextBudget` 增加：
  - `historyMode=legacy|observe|shadow-summary|summary-active`
  - `historyFullTokens`
  - `historySummaryTokens`
  - `historyBudgetRatio`
  - `summarySegmentId`
  - `historyGovernanceDegraded`
- 验收：能在一次 invocation 里看出历史占比。

### Phase 3B：shadow summary

- 对长 thread 后台生成摘要，但仍发送完整历史。
- 对比摘要覆盖范围、token 节省、关键事实是否保留。
- 验收：摘要可用率和失败原因可见。

### Phase 3C：canary summary-active

- 只给 1-2 个指定 cat/thread 开启摘要替换。
- 保留 `CAT_CAFE_HISTORY_GOVERNANCE=0` 一键回退。
- 验收：长 thread input token 不再线性增长，smoke 不失忆，按需工具调用频率/取回 token 量可观测且不过量。

### Phase 3D：默认长 thread 启用

- 只对超过阈值的长 thread 自动启用。
- 短 thread 继续完整历史，避免过早压缩增加复杂度。
- 验收：p95 input/cache read 降低，用户主观体验不退化。

## 8. 实现切片建议

后续代码票不要一口吃完，建议拆成 4 刀：

1. **观测字段**：补 `historyMode` / `historyFullTokens` / `historyBudgetRatio`。
2. **摘要读取与 formatter**：只读已有 `summary_segments`，拼出 `[Thread History Summary]`。
3. **阈值切换**：在 route context assembly 中按阈值决定 full history 或 summary + recent。
4. **质量闸门与回退**：补 degrade flag、secret redaction、smoke 和 kill switch。

## 9. 验收标准

- flag off 时行为完全不变。
- observe-only 能显示历史 token 占比。
- summary-active 后，长 thread 的 history token 不再随总消息数线性增长。
- 当前用户消息、最近原文窗口、任务状态和项目决策不丢。
- 摘要缺精确信息时，agent 能用 `cat_cafe_fetch_thread_history` 按需拉取原文范围，而不是编造。
- provider compact boundary 出现时，有 continuity capsule 接班，并在下一轮重新注入身份和任务。

## 10. 费曼版

长对话像背一本越来越厚的会议纪要。Phase 3 不是让 agent 忘掉旧内容，而是把旧会议纪要压成带页码的摘要；最近几页仍看原文，公司制度、当前任务和最终决定另放在白板上，每次都直接看白板。摘要不确定时，用工具回到原页码查原文。
