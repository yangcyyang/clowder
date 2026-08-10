---
feature_ids: []
topics: [subagent, harness, orchestration, runtime, clowder]
doc_kind: design
created: 2026-05-27
status: draft
---

# Codex-style Subagent Harness 提取稿

> 目标：把 Codex UI 里“主 agent 调度子智能体”的可见结构抽象出来，
> 映射到 Clowder 现有运行时，作为后续实现 `spawn / wait / send / close`
> 子智能体能力的设计底稿。

## 0. 边界声明

这份稿只基于当前可见 harness 契约和 Clowder 代码结构提取，不声称掌握
Codex 后端私有实现。

可以确认的可见契约：

- 子智能体是独立 agent session，不只是函数调用。
- 主 agent 可以创建、等待、发送输入、恢复和关闭子智能体。
- 子智能体有 role/type，例如 `explorer`、`worker`、`default`。
- 子智能体可继承或 fork 当前上下文。
- 子智能体可以独立运行工具，并在完成后返回摘要或改动清单。

不可确认的内部细节：

- 是否对应独立 OS 进程、线程、容器或服务端 job。
- 上下文 fork 的具体存储格式。
- workspace fork / patch upload 的实际隔离策略。

因此，Clowder 复刻时应复刻“平台契约”，不要复刻猜测出的底层进程模型。

## 1. Codex 可见结构

```text
[Parent Agent]
  ├── spawn_agent(role, task, context_policy)
  │     └── returns SubAgentHandle(id, nickname)
  ├── wait_agent(ids, timeout)
  │     └── returns first completed / status snapshot
  ├── send_input(id, message, interrupt?)
  │     └── queues or interrupts input
  ├── resume_agent(id)
  │     └── reopens a closed handle
  └── close_agent(id)
        └── shuts down target and descendants
```
核心不是“多模型聊天”，而是多了一个显式控制面：

- **数据面**：子智能体执行任务、产出消息、调用工具。
- **控制面**：主智能体管理子智能体生命周期。
- **汇总面**：主智能体整合结果，而不是让子智能体直接决定全局方向。

## 2. 角色契约

### `explorer`

用途：只读探索。

适合：

- 查代码路径
- 读文档和测试
- 回答局部问题
- 给主 agent 返回证据、风险和建议

约束：

- 默认不改文件。
- 问题必须具体、可独立回答。
- 返回格式应短而结构化。

### `worker`

用途：执行生产工作。

适合：

- 实现一个边界清晰的功能片段
- 修一组不冲突的测试
- 在明确 write set 内改文件

约束：

- 必须声明文件/模块 ownership。
- 不得回滚他人改动。
- 并行 worker 的 write set 必须不重叠。
- 返回已改文件、验证方式和未完成项。

### `default`

用途：没有专门 role 时的普通子智能体。

建议 Clowder 初版只实现 `explorer` 和 `worker`，`default` 作为兼容别名。

## 3. 生命周期状态机

```text
created
  ↓
queued
  ↓
running ───────→ waiting_input
  │                  ↓
  │              running
  │
  ├────→ completed
  ├────→ failed
  ├────→ canceled
  └────→ closed
```

建议状态定义：

```ts
export type SubAgentStatus =
  | 'created'
  | 'queued'
  | 'running'
  | 'waiting_input'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'closed';
```

状态语义：

- `created`：记录已建立，但尚未进入执行队列。
- `queued`：等待可用执行槽。
- `running`：底层 AgentService 正在执行。
- `waiting_input`：交互型子智能体等待主 agent 或用户输入。
- `completed`：正常结束，结果可读取。
- `failed`：异常结束，保留错误和最后事件。
- `canceled`：被主 agent 或用户取消。
- `closed`：控制面关闭，不再主动占资源。

## 4. Clowder 现有可复用底座

Clowder 不需要从零开始。现有结构已经有多块可以直接承接。

```text
AgentRegistry
  └── catId → AgentService

AgentService.invoke()
  └── provider-specific CLI / remote runtime

InvocationTracker
  └── threadId + catId 多槽并发锁

InvocationQueue
  └── per-thread / per-user 排队

InvocationRecordStore
  └── queued → running → succeeded / failed / canceled

InvocationRegistry
  └── callback token / MCP 回传鉴权

AgentRouter / A2A routing
  └── @mention、routeSerial、routeParallel、callback post_message
```

建议新增的不是另一套路由系统，而是在这些组件上方加一层
`SubAgentHarness`。

## 5. 推荐目标架构

```text
[Clowder Thread]
  │
  ├── AgentRouter                     现有用户消息路由
  │
  └── SubAgentHarness                 新增控制面
        ├── SubAgentStore             子智能体 session 元数据
        ├── SubAgentScheduler         并发度、队列、role policy
        ├── ContextForker             上下文裁剪 / fork
        ├── SubAgentRunner            AgentService.invoke() facade
        ├── ResultCollector           final summary / patch manifest
        └── SubAgentSupervisor        cancel / timeout / liveness
```

### 5.1 `SubAgentStore`

负责保存可恢复状态。

```ts
export interface SubAgentSession {
  id: string;
  parentThreadId: string;
  parentInvocationId?: string;
  parentAgentId: string;
  assignedAgentId: string;
  role: 'explorer' | 'worker' | 'default';
  nickname?: string;
  status: SubAgentStatus;
  task: SubAgentTaskSpec;
  contextPolicy: SubAgentContextPolicy;
  writeScope?: SubAgentWriteScope;
  result?: SubAgentResult;
  error?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
}
```

### 5.2 `SubAgentTaskSpec`

任务契约要强制结构化，避免“派一个模糊问题出去”。

```ts
export interface SubAgentTaskSpec {
  name: string;
  definition: string;
  actions: string[];
  expectedOutput: string;
  constraints: string[];
}
```

对应主 agent 下发格式：

```text
代理名称：search_explorer
任务定义：调查 Clowder 中 InvocationTracker 如何表达并发槽位。
执行动作：
1. 只读相关源码和文档。
2. 不修改文件。
3. 返回关键类型、状态机和可复用点。
预期结果：
用 bullet 返回结论，附文件路径，指出不确定项。
```

### 5.3 `ContextForker`

Codex 的 `fork_context` 可映射为 Clowder 的上下文策略。

```ts
export type SubAgentContextPolicy =
  | { kind: 'none' }
  | { kind: 'parent_summary'; summary: string }
  | { kind: 'selected_messages'; messageIds: string[] }
  | { kind: 'full_thread_snapshot'; maxTokens: number }
  | { kind: 'workspace_pack'; files: string[]; instructions: string };
```

推荐默认：

- `explorer`：`parent_summary + selected_files`
- `worker`：`parent_summary + selected_messages + write_scope`
- 不建议默认传完整 thread，避免成本和污染。

### 5.4 `SubAgentRunner`

第一版可以复用 `AgentService.invoke()`：

```ts
export interface SubAgentRunner {
  spawn(input: SpawnSubAgentInput): Promise<SubAgentHandle>;
  sendInput(id: string, input: SubAgentInput, opts?: { interrupt?: boolean }): Promise<void>;
  wait(ids: string[], timeoutMs: number): Promise<SubAgentWaitResult>;
  close(id: string): Promise<SubAgentStatus>;
  resume(id: string): Promise<SubAgentHandle>;
}
```

内部执行流：

```text
spawn()
  → validate role / write scope / concurrency
  → create SubAgentSession
  → build prompt from task contract + context fork
  → create InvocationRecord
  → InvocationTracker.tryStartThreadAll(...)
  → AgentService.invoke(...)
  → stream events into SubAgentStore
  → collect final result
```

## 6. 和现有 A2A 的关系

现有 A2A 更像“群聊里 @另一个 agent 接话”：

```text
message / callback post_message
  → @mention detection
  → InvocationQueue
  → target agent runs in same thread
```

Subagent harness 更像“主 agent 开一个旁路任务”：

```text
parent agent
  → spawn subagent with bounded task
  → subagent works independently
  → parent waits / polls / receives result
  → parent integrates
```

二者不冲突：

- A2A 是协作沟通层。
- Subagent 是任务调度层。
- Worker 子智能体可以最终通过 A2A 把结果贴回主 thread。
- Explorer 子智能体可以只把结构化结果交给 parent，不污染主 thread。

## 7. API 草案

### `POST /api/subagents`

创建子智能体。

```json
{
  "parentThreadId": "thread_123",
  "parentInvocationId": "inv_123",
  "parentAgentId": "codex",
  "assignedAgentId": "codex",
  "role": "explorer",
  "nickname": "routing_explorer",
  "task": {
    "name": "routing_explorer",
    "definition": "调查 A2A routing 的当前入口和风险点。",
    "actions": ["读取相关文件", "不修改文件", "返回证据"],
    "expectedOutput": "短列表 + 文件路径",
    "constraints": ["read-only"]
  },
  "contextPolicy": {
    "kind": "parent_summary",
    "summary": "当前任务是复刻 Codex-style subagent harness。"
  }
}
```

### `POST /api/subagents/:id/input`

继续给子智能体发输入。

```json
{
  "message": "补充看一下 InvocationQueue 和 callback post_message 的关系。",
  "interrupt": false
}
```

### `POST /api/subagents/wait`

等待一个或多个子智能体。

```json
{
  "ids": ["sub_1", "sub_2"],
  "timeoutMs": 30000,
  "mode": "first_completed"
}
```

### `POST /api/subagents/:id/close`

关闭子智能体，必要时级联取消 descendants。

## 8. UI 映射

右侧状态面板可新增一个“子智能体”区块：

```text
子智能体
├── routing_explorer   running
├── store_explorer     completed
└── worker_api         failed
```

每个条目显示：

- nickname
- role
- assigned agent
- status
- startedAt / duration
- read-only / write scope
- stop / close 按钮

点击条目可展开：

- 任务定义
- 实时日志摘要
- 最终结果
- 改动文件清单
- 错误信息

## 9. 并发和安全策略

初版建议：

- 单轮最多 5 个子智能体。
- 同一 parent invocation 的 worker write scope 不得重叠。
- `explorer` 默认只读。
- `worker` 必须声明 ownership。
- 子智能体默认不能再 spawn 子智能体，除非显式开启 `allowDescendants`。
- `close(parent)` 应关闭 descendants。
- 运行超时走 `SubAgentSupervisor`，不要只依赖 CLI timeout。

Worker write scope：

```ts
export interface SubAgentWriteScope {
  mode: 'read_only' | 'paths';
  paths?: string[];
  conflictPolicy: 'reject_overlap' | 'queue_on_overlap';
}
```

## 10. 实施阶段

### Phase 1：类型和 Store

交付：

- `SubAgentSession` 类型
- `SubAgentStore` 内存实现
- 状态机校验
- 单元测试

### Phase 2：Harness facade

交付：

- `spawn / wait / sendInput / close / resume`
- 初版只支持 `explorer`
- 复用 `AgentService.invoke()`
- 不做 worker 写文件隔离

### Phase 3：API 和 UI

交付：

- REST API
- 右侧状态面板“子智能体”列表
- completed / failed 结果查看

### Phase 4：Worker 隔离

交付：

- write scope 校验
- 文件锁 / worktree lease
- 改动清单收集
- worker 结果集成提示

### Phase 5：持久化和恢复

交付：

- Redis store
- resume closed/running session
- crash recovery
- liveness / timeout telemetry

## 11. 关键设计判断

建议：

- 先做控制面，不急着重写 provider。
- 先支持 read-only explorer，验证 UI 和生命周期。
- worker 必须等 write scope 和冲突策略设计好再开放。
- A2A 继续保留为可见消息协作，不要和 subagent harness 混成一条路由。
- `AgentService.invoke()` 仍是底层北向 facade，和 F143 Hostable Agent Runtime 方向兼容。

一句话总结：

```text
Codex-style subagent = Parent-controlled AgentService invocation
                     + isolated context fork
                     + explicit lifecycle control
                     + structured result collection
```
