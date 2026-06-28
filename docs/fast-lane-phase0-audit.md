---
feature_ids: []
topics: [orchestration, fast-lane, audit]
doc_kind: audit
created: 2026-06-28
author: 老者-codex
status: proposed
context: "快车道机制 Phase 0：盘点现有 skill、workflow 与 QueueProcessor 观测能力"
related:
  - docs/exec-fast-lane-mechanism.md
  - docs/ref-muji-ai-creation-debt.md
---

# Phase 0 审计：Clowder 快车道机制

## 结论

Clowder 现在已经有"快车道"的雏形，但还不是一个可运行的快车道系统。

- `skill-to-workflow-freezer`：是 workflow 设计 SOP，用来判断一个 skill 能不能冻结成 workflow，不会直接执行。
- `subagent-dispatch`：是多 Agent 派工 SOP，用来指导人/Agent 如何拆任务，不会自动派生、追踪和汇总子任务。
- `project-init`：是真正可执行的确定性脚本，适合作为第一条 fast lane。
- `QueueProcessor`：已经有执行入口、task event、usage、artifact 这些观测点，可作为 fast lane 接入位置和收益度量基础。
- 当前缺口：没有 `FastLaneRouter`、没有 workflow registry、没有参数 schema、没有执行器、没有 fast lane 专属事件和回退策略。

一句话：**先把 `project-init` 这一条确定性脚本接成白名单快车道，不要一开始做智能分诊。**

## 证据

### 1. `skill-to-workflow-freezer` 是 SOP，不是执行器

位置：`cat-cafe-skills/skill-to-workflow-freezer/SKILL.md`

它要求输出 `Workflow Freeze Plan`，内容包括：

- 是否适合冻结
- 固定步骤
- LLM 判断节点
- 输入输出 Schema
- Checkpoint
- 失败分支
- 验收方式
- 保留的 Skill 文档职责

目录下没有 `scripts/`、registry、executor 或测试样例。它的作用是**把经验整理成 workflow 方案**，不是在运行时绕过 agent loop 执行任务。

### 2. `subagent-dispatch` 是协作 SOP，不是自动 harness

位置：`cat-cafe-skills/subagent-dispatch/SKILL.md`

它解决的是"什么时候应该并行派工、怎么写子任务契约、怎么汇总结果"。实际执行方式仍是：

- 人或当前 Agent 判断任务能否拆分
- 通过 @mention 或任务系统把工作分给不同猫
- 等待结果后人工/主 Agent 汇总

目录下没有自动 spawn 子 Agent、监听完成、聚合结果、处理冲突的 runtime harness。

所以它更接近**派工方法论**，不是 fast lane 的执行引擎。

### 3. `project-init` 是可执行快车道候选

位置：`cat-cafe-skills/project-init/scripts/init-project.mjs`

它已经具备确定性执行能力：

- 校验项目名：`^[a-zA-Z0-9_-]+$`
- 创建 `.cat-cafe/projects/<name>/`
- 从模板写入 `brief.md`、`progress.md`、`handoff-log.md`
- 可选写入 `security.md`
- 目录已存在时拒绝覆盖
- 支持 `--creator`、`--root`、`--security`、`--no-commit`
- 默认可 `git add` / `git commit`

这类任务输入输出边界清楚、可测试、低风险，适合作为第一条 fast lane。

### 4. 现有 Pack workflow 仍偏声明式

位置：

- `packages/shared/src/schemas/pack.ts`
- `packages/api/src/domains/packs/PackExporter.ts`

Pack workflow schema 有固定 action enum：

- `search-knowledge`
- `apply-mask`
- `check-guardrail`
- `notify-user`
- `switch-mode`
- `log-event`

`PackExporter.exportWorkflows()` 目前把 SOP-linked skill 导出为：

```ts
steps: [{ action: 'log-event', params: { skill: id } }]
```

这说明现有 workflow 更像 prompt/pack 层的声明，不是能直接调用脚本或工具的 runtime workflow。

### 5. WorkflowSopStore 是状态告示牌，不控制执行

位置：

- `packages/shared/src/types/workflow-sop.ts`
- `packages/api/src/domains/cats/services/stores/ports/WorkflowSopStore.ts`

它存的是：

- stage
- batonHolder
- nextSkill
- resumeCapsule
- checks

文件注释也明确是"告示牌哲学：存信息，不控制流程"。这对协作恢复有价值，但不能替代 fast lane registry/executor。

### 6. QueueProcessor 有可复用观测点

位置：`packages/api/src/domains/cats/services/agents/invocation/QueueProcessor.ts`

可复用点：

- `executeEntry(entry)`：当前所有 agent loop 的统一入口，适合在最前面插 `FastLaneRouter`。
- `appendUsageTaskEvents()`：已把 provider/model/token/cost 写入 task event。
- `appendArtifactTaskEvent()`：已把 git artifact delta 写入 task event。
- `collectGitArtifacts()`：能对比执行前后文件变化。

这意味着 fast lane 不需要从零做观测；第一版可以沿用 task event ledger，把 fast lane 的命中、结果和证据写进去。

## 缺口清单

### P0 缺口：执行链路

1. `FastLaneRouter`
   - 插在 `executeEntry()` 最前面。
   - 输入 `QueueEntry`，输出 `fast` 或 `slow`。
   - 默认 feature flag 关闭。
   - 不确定时必须回退 slow lane。

2. `FastLaneWorkflowRegistry`
   - 统一注册可执行 workflow。
   - 每条 workflow 至少包含 `id`、`version`、`match()`、`inputSchema`、`execute()`、`evidence()`。

3. `FastLaneExecutor`
   - 负责运行脚本或内部动作。
   - 捕获 stdout/stderr、exitCode、durationMs、artifact delta。
   - 支持 timeout。

4. 参数 schema 与安全策略
   - project root 必须显式。
   - 写入路径必须白名单。
   - 参数缺失时不猜，回退 slow lane 或 ask-user。
   - 脚本失败前无副作用可回退；已有部分副作用时要 fail-closed 并输出证据。

### P1 缺口：观测与治理

1. 新增 task event 类型或 data 约定
   - `fast_lane_decision`
   - `fast_lane_started`
   - `fast_lane_completed`
   - `fast_lane_failed`

2. 新增收益字段
   - `workflowId`
   - `workflowVersion`
   - `durationMs`
   - `estimatedTokensSaved`
   - `artifactCount`
   - `fallbackReason`

3. 新增候选识别字段
   - `normalizedIntent`
   - `toolSequenceHash`
   - `commandsHash`
   - `resultStatus`

4. 新增回退策略
   - feature flag off：完全走旧逻辑。
   - router 未命中：走 slow lane。
   - match 低置信：走 slow lane。
   - execute 前失败：走 slow lane。
   - execute 后失败：写失败事件，交给人工复核，不静默重跑。

## 第一条快车道建议

### 选择：`project-init`

原因：

- 已经是脚本，不需要先把 SOP 改造成代码。
- 输入输出清楚，容易写自动化测试。
- 写入范围可控，主要是 `.cat-cafe/projects/<id>/`。
- 失败模式清楚：项目名非法、目录已存在、模板缺失、git commit 失败。
- 用户价值明确：初始化项目不需要完整 agent loop。

### 不建议首选的候选

- `git 三连`：看似确定，但涉及用户是否真的要提交、提交范围是否包含无关脏改，风险高于 `project-init`。
- `task 状态操作`：动作确定，但触碰协作状态，误判会影响任务流。
- `跑测试 + 汇报`：需要判断包管理器、测试命令、超时策略和环境状态，首条链路偏复杂。

## Phase 1 最小方案

先不要做智能分类。只做白名单 + feature flag。

```text
QueueProcessor.executeEntry(entry)
  ├── CAT_CAFE_FAST_LANE off → 原 slow lane
  ├── FastLaneRouter.match(entry)
  │     ├── 未命中 → 原 slow lane
  │     └── 命中 project-init → FastLaneExecutor
  ├── 写 fast_lane_* task events
  ├── 写 artifact event
  └── 返回 succeeded / failed
```

第一版验收边界：

- flag 关闭时现有测试和行为 100% 不变。
- flag 开启但未命中时仍走 slow lane。
- `project-init` 命中时不调用 `router.routeExecution()`。
- 在临时 repo 里能生成项目档案。
- 目录已存在时拒绝覆盖，并写清楚失败原因。
- task event 能看到 workflowId、durationMs、artifact files。

## 最终判断

快车道要先做成**工程机制**，不要做成"模型觉得可以就快跑"。

正确顺序是：

```text
确定脚本 → 白名单分诊 → 结构化证据 → 收益度量 → 再沉淀更多 workflow
```

`project-init` 是最稳的第一颗钉子。它打通后，再把 `skill-to-workflow-freezer` 用来生产第二批候选，而不是直接拿它当执行器。
