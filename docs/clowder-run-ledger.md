---
feature_ids: [F188]
related_features: [F039, F048, F117, F130, F153, F175]
topics: [run-ledger, invocation, observability, task-event, trace, agent-runtime]
doc_kind: spec
created: 2026-07-03
---

# F188: Run Ledger — Agent 运行流水账

> **Status**: design | **Owner**: Ragdoll + Codex | **Priority**: P1

## Why

Clowder 已经有很多运行时观测点：

- `InvocationRecord`：知道一次调用是 queued / running / succeeded / failed
- `TaskEvent`：知道 task 里发生过 claim / usage / artifact / handoff
- `StoredMessage.extra.stream`：知道某条 assistant 消息来自哪个 invocation
- `StoredMessage.toolEvents`：知道 agent 调过哪些工具
- `StoredMessage.extra.tracing`：知道消息和 OTel trace 的关联
- F153 telemetry：知道 span / metrics / health
- F048 startup recovery：知道重启后哪些 invocation 被恢复或失败

但这些信息分散在不同地方。用户问“这只猫现在到底卡在哪一步？”时，系统还不能给出一张统一的流水账。

Run Ledger 的目标是把一次 agent 运行从“黑盒调用”变成“可回放的执行时间线”。

## One-Sentence Definition

Run Ledger 是按 `invocationId` 聚合的一条只读执行流水账：从用户消息、入队、上下文构建、runtime 启动、首 token、工具调用、产物变化、用量成本、最终消息到失败恢复，串成一条可查询、可展示、可审计的时间线。

## Non-Goals

首版不做：

- 不替换 OTel trace，Run Ledger 是产品视图，Trace 是工程诊断视图
- 不替换 TaskEvent，TaskEvent 是 task 活动账，Run Ledger 是 invocation 运行账
- 不新增自动决策或评分，先只回答“发生了什么”
- 不存 prompt 明文，不扩大凭据、正文和工具参数的暴露面
- 不先做复杂 UI，先稳定数据契约和只读 API

## Current Pain

### Pain 1: 卡住难定位

现在用户看到“agent 正在运行”，但不知道卡在：

- 队列里还没开始
- 构建上下文
- CLI 启动
- 等首 token
- 工具调用
- 写入消息
- 进程挂死
- API 重启恢复

### Pain 2: 证据分散

同一次运行的证据散落在：

- Redis invocation record
- messages / drafts
- task events
- telemetry traces
- PM2 / API logs
- git diff artifact

排查时需要人工拼时间线。

### Pain 3: 主会话不应承载后厨日志

Clowder 已经在收敛主气泡噪音。Run Ledger 要把后厨日志放到专门视图里，让主会话只放结论，执行过程进 ledger。

## Concept Model

```text
User Message
  └── InvocationRecord
        ├── Run Ledger Entry
        │     ├── lifecycle events
        │     ├── context budget snapshot
        │     ├── tool events
        │     ├── usage/cost
        │     ├── artifact delta
        │     ├── final message
        │     └── recovery/failure evidence
        └── Task / Message / Trace pointers
```

## Ledger Scope

一条 Run Ledger 以 `invocationId` 为主键。

必须能反查：

- `threadId`
- `userMessageId`
- `assistantMessageId`
- `targetCats`
- `taskId` / `sourceMessageId`，如果本次运行绑定 task
- `traceId`，如果有 tracing pointer
- `queueEntryId`，如果来自队列

## Event Contract

### Event Envelope

```ts
interface RunLedgerEvent {
  id: string;
  invocationId: string;
  ts: number;
  seq: number;
  type: RunLedgerEventType;
  actor: 'system' | 'user' | CatId;
  severity: 'info' | 'warning' | 'error';
  data: Record<string, unknown>;
}
```

### Event Types

首版事件类型建议：

- `created`：InvocationRecord 创建
- `queued`：进入队列
- `dequeued`：开始执行
- `context_started`：开始构建上下文
- `context_ready`：上下文完成，记录估算 token 和 source breakdown
- `runtime_starting`：开始启动 CLI / SDK runtime
- `runtime_ready`：runtime 可接收输入
- `first_token`：首次收到模型输出
- `tool_started`：工具调用开始
- `tool_completed`：工具调用结束
- `tool_failed`：工具调用失败
- `artifact_delta`：文件/产物变化
- `usage_recorded`：token、cache、duration、cost 落账
- `message_persisted`：最终 assistant 消息写入
- `succeeded`：终态成功
- `failed`：终态失败
- `canceled`：用户取消或系统取消
- `recovered`：重启后恢复/重放

## Data Sources

### Already Available

| Source | Current Data | Ledger Use |
| --- | --- | --- |
| `InvocationRecord` | status / phase / targetCats / usageByCat | 生命周期骨架 |
| `MessageStore` | user/assistant message、toolEvents、extra.stream | 输入/输出/工具事件 |
| `TaskStore.events` | usage / artifact / handoff / fast-lane events | task 维度证据 |
| `LocalTraceStore` | spans / trace tree | 工程诊断链接 |
| `QueueProcessor` | phase、usage、artifact baseline | 运行过程关键节点 |
| `StartupReconciler` | restart recovery | failed/recovered 事件 |

### Missing

首版缺口：

- 没有统一的 `RunLedgerStore`
- phase 变化不是 append-only event，只是 record 上的当前值
- tool events 多数只有落盘后的结果，没有 started/completed 明确边界
- context budget source breakdown 只在部分 usage 路径可见
- 失败原因缺少结构化 `failureClass`

## Storage Strategy

### Phase A: Read-Only Aggregator

先不新增写入路径。

通过现有数据合成 ledger：

```text
InvocationRecord
  + messages by extra.stream.invocationId
  + task events by sourceMessageId / threadId / invocationId pointer if present
  + trace store by traceId / invocationId
  → RunLedgerView
```

优点：

- 改动小
- 不影响运行链路
- 能快速验证 UI/排查价值

缺点：

- 只能看到已存在的数据
- phase 变化无法完整回放
- 重启后内存 trace 丢失时，ledger 会退化

### Phase B: Append-Only RunLedgerStore

当 Phase A 验证有价值后，再新增独立 store。

建议 Redis 结构：

```text
runledger:{invocationId}          → Hash(summary)
runledger:{invocationId}:events   → Sorted Set(score=seq, member=eventJson)
runledger:thread:{threadId}       → Sorted Set(score=createdAt, member=invocationId)
runledger:task:{taskId}           → Sorted Set(score=createdAt, member=invocationId)
```

TTL：

- 默认 30 天
- 绑定未完成 task 的 ledger 不过期
- done task 可按项目策略归档

## Summary Shape

```ts
interface RunLedgerSummary {
  invocationId: string;
  threadId: string;
  userMessageId: string | null;
  assistantMessageId?: string;
  taskId?: string;
  targetCats: CatId[];
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
  phase: InvocationPhase;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  failureClass?: TaskFailureClass | 'process_restart' | 'runtime_hung';
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreateTokens?: number;
    costUsd?: number;
  };
  artifactCount?: number;
  toolCallCount?: number;
  traceId?: string;
}
```

## UI Placement

### P1: Task Thread Right Panel

在 task thread 右侧或 task 卡详情里增加：

```text
Run Ledger
├── 18:23:01 queued
├── 18:23:02 context ready · 4.2k tokens
├── 18:23:03 runtime starting · codex
├── 18:23:07 first token
├── 18:23:20 tool · apply_patch
├── 18:24:10 artifact · 3 files changed
├── 18:24:25 usage · $0.12 / 8.1k tokens
└── 18:24:29 succeeded · message persisted
```

### P2: Message Hover / More Menu

assistant 消息 More 菜单增加：

- `查看运行流水`
- 跳到该消息 `extra.stream.invocationId` 对应 ledger

### P3: Ops / Debug

运维监控页增加按条件搜索：

- threadId
- taskId
- catId
- status
- failureClass
- 时间范围

## API Design

### Phase A API

```http
GET /api/run-ledger/:invocationId
GET /api/run-ledger?threadId=<id>&limit=20
GET /api/tasks/:taskId/run-ledgers
```

返回：

```ts
interface RunLedgerResponse {
  summary: RunLedgerSummary;
  events: RunLedgerEvent[];
  sources: {
    invocationRecord: boolean;
    messages: number;
    taskEvents: number;
    trace: boolean;
  };
  degraded?: {
    reason: string;
    missingSources: string[];
  };
}
```

### Privacy / Redaction

API 默认不返回：

- prompt 明文
- credential-shaped strings
- raw env
- raw MCP headers
- 完整工具参数

可返回：

- 工具名
- duration
- exit code
- redacted error message
- 文件路径和 git diff summary
- token / cost / source breakdown

## Relationship With Existing Systems

### vs TaskEvent

TaskEvent 是“任务账”：

- 谁认领
- 状态怎么变
- 交付了什么证据
- usage/artifact 与 task 的关系

Run Ledger 是“运行账”：

- 一次 invocation 从开始到结束发生了什么
- 卡在哪一步
- 哪个 runtime / tool / phase 失败

二者通过 `taskId` / `sourceMessageId` / `invocationId` 互链。

### vs OTel Trace

Trace 是工程诊断：

- span 树
- parent/child
- metrics
- exporter

Run Ledger 是产品诊断：

- 人能读懂的时间线
- 关联 task/message/artifact
- 可以给用户解释“为什么这只猫看起来卡住了”

Run Ledger 可以链接 trace，但不替代 trace。

### vs Main Chat

主聊天只显示用户真正需要读的结果。

Run Ledger 承载：

- 中间状态
- 后厨日志
- 工具调用
- 构建结果
- 用量和成本

## Failure Classes

建议统一失败分类：

- `runtime_spawn_failed`：CLI/SDK 启动失败
- `runtime_hung`：长时间无 token 或无 phase 进展
- `tool_failed`：工具调用失败
- `budget_exhausted`：token / cost / timeout 预算耗尽
- `process_restart`：API/runtime 重启打断
- `message_persist_failed`：最终消息写入失败
- `user_canceled`：用户取消
- `unknown`：无法分类

这些分类后续可映射到 Task `failureClass`，但不要求首版一次打通。

## Implementation Phases

### Phase A: Spec + Read-Only Aggregator

- [ ] 新增 `RunLedgerAssembler`
- [ ] 从 `InvocationRecordStore` 读取基础状态
- [ ] 从 `MessageStore` 反查 `extra.stream.invocationId`
- [ ] 从 `TaskStore.events` 合成 usage/artifact/handoff
- [ ] 可选读取 `LocalTraceStore`
- [ ] 提供 `GET /api/run-ledger/:invocationId`
- [ ] 单测覆盖缺 source 的 degraded response

### Phase B: UI Read Path

- [ ] assistant message More 菜单增加“查看运行流水”
- [ ] task detail / thread panel 展示 Run Ledger timeline
- [ ] 卡住态高亮当前 phase
- [ ] failed/recovered 用 warning/error chip

### Phase C: Append-Only Store

- [ ] 新增 `RunLedgerStore`
- [ ] QueueProcessor 在 phase transition 时 append event
- [ ] tool started/completed/failed 产生明确 event
- [ ] StartupReconciler 写 recovered/failed event
- [ ] 与 TaskEvent 互写 pointer，不复制大 payload

### Phase D: Governance

- [ ] 超时 watchdog 基于 ledger 判断“无进展”
- [ ] task in_review 前自动检查是否有 terminal ledger event
- [ ] 可导出某次运行的 evidence pack

## Acceptance Criteria

### Design Acceptance

- [ ] 文档明确 Run Ledger 与 TaskEvent / OTel Trace / 主聊天的边界
- [ ] 文档明确 Phase A 不新增写入路径，只做只读聚合
- [ ] 文档明确隐私脱敏规则，不返回 prompt 明文和凭据
- [ ] 文档明确卡住、失败、恢复的用户可解释口径

### Phase A Acceptance

- [ ] 给定一个 succeeded invocation，API 返回 created → running → message_persisted → succeeded 的时间线
- [ ] 给定一个 failed invocation，API 返回 failureClass、error 摘要和 missing source 信息
- [ ] 给定一个 task 绑定 invocation，task detail 能查到关联 ledger
- [ ] 没有 trace 数据时 API 返回 degraded，但不失败
- [ ] 不泄漏 prompt/env/header/credential-shaped strings

## Open Questions

1. `TaskEvent` 里是否需要补 `invocationId` 标准字段，还是只放在 `data` 里？
2. tool started/completed 的边界应该从 provider 层捕获，还是 MCP callback 层捕获？
3. Run Ledger TTL 是否跟 task 生命周期绑定，还是统一 30 天？
4. 对多猫并行 invocation，是一条 ledger 下多个 cat lane，还是每只 cat 一条 child ledger？

## Recommended Next Step

先做 Phase A：只读聚合 API。

原因：

- 能快速验证“排查卡住”价值
- 不影响运行链路
- 不引入新的写入一致性问题
- 后续 UI 和 append-only store 都可以基于同一 response contract 演进
