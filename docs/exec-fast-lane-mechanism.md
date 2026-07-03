---
feature_ids: []
topics: [orchestration, performance, execution-plan]
doc_kind: spec
created: 2026-06-28
author: 专家-Claude
status: proposed
context: "改造 1 — execute 分层 / fast-exec 短路 + 快车道沉淀机制的落地执行方案"
---

# 执行方案：快车道机制（fast-exec 短路 + 沉淀循环）

> **目标**：让确定性任务绕过完整 agent loop，走"快车道"直接执行；并建立一套机制，让快车道从真实高频任务里**自动长出来**。
> **对应**：改造 1（最高优先），参考 `docs/ref-muji-ai-creation-debt.md`。
> **执行者**：@老者-codex。**验收**：@专家-Claude。

## 0. 一句话定义

> 在 agent 调用前加一个"分诊器"：任务确定且链路明确 → 走固化 workflow（fast lane），不进 loop；否则才进完整 agent loop（slow lane）。同时建立 observe→freeze→wire→measure 循环，把高频确定任务持续沉淀成快车道。

## 1. 现状与落点（先读代码再动手）

- **执行入口**：`packages/api/src/domains/cats/services/agents/invocation/QueueProcessor.ts`
  - `executeEntry(entry)`（约 line 1141）是 agent 调用的总入口，所有任务都从这里进完整 loop。
  - **分诊器就插在 `executeEntry` 的最前面。**
- **完整 loop 实现**：`invoke-single-cat.ts`（2242 行）。
- **现成的固化工具**：`cat-cafe-skills/skill-to-workflow-freezer/`、`cat-cafe-skills/subagent-dispatch/`。
- **现成的快车道范例**：`cat-cafe-skills/project-init/scripts/init-project.mjs`（纯确定性脚本，零 loop）。
- **已有埋点**：QueueProcessor 已 track token usage + task events（`appendUsageTaskEvents` / `appendArtifactTaskEvent`），可复用做"重复链路识别"。

**硬约束**：分诊器必须默认安全 fail-open —— 任何不确定都回退 slow lane。绝不能因为分诊误判把复杂任务塞进快车道导致改错。

## 2. 分阶段实施

### Phase 0：评估（不写业务代码，先出结论）
- @老者-codex 阅读 `skill-to-workflow-freezer` 和 `subagent-dispatch` 现有实现，回答：
  1. 它们目前是"生成 workflow 描述"还是"真能执行 workflow"？
  2. 要做到"绕过 agent loop 直接执行固化 workflow"，缺哪些零件？
- 产出：一页评估结论 + 缺口清单。**先评估通过再进 Phase 1。**

**Phase 0 激活清单**

1. 盘点现有可复用入口：
   - `cat-cafe-skills/skill-to-workflow-freezer/`
   - `cat-cafe-skills/subagent-dispatch/`
   - `cat-cafe-skills/project-init/scripts/init-project.mjs`
   - `QueueProcessor` 已有 task events / usage / artifacts 写入点
2. 输出 `docs/fast-lane-phase0-audit.md`：
   - 现有 skill 是否只是 SOP 描述，还是能直接执行？
   - 要绕过 agent loop，缺 workflow registry、参数 schema、执行器、观测字段里的哪几项？
   - 第一条快车道建议选哪条，为什么？
3. 只做只读审计，不改 `QueueProcessor`。

### Phase 1：分诊器骨架（FastLaneRouter）
- 新增 `FastLaneRouter`：输入一个 QueueEntry，输出 `{ lane: 'fast' | 'slow', workflowId? }`。
- 第一版只识别**白名单**里的确定任务类型（不做智能判断），命中 → fast，未命中 → slow。
- 在 `executeEntry` 最前面调用；slow lane 行为与现状 100% 一致（零回归）。
- 加 feature flag `CAT_CAFE_FAST_LANE`（默认 off），灰度开关。

**Phase 1 最小接口草案**

```ts
type FastLaneDecision =
  | { lane: 'slow'; reason: string }
  | { lane: 'fast'; workflowId: string; reason: string; confidence: 'high' };

type FastLaneWorkflow = {
  id: string;
  title: string;
  match(entry: QueueEntry): boolean;
  execute(entry: QueueEntry, ctx: FastLaneExecutionContext): Promise<FastLaneResult>;
};
```

设计原则：
- `match()` 第一版只做白名单和显式 marker，不做 LLM 判断。
- `execute()` 必须产出结构化结果、证据和失败原因。
- 任何异常都回退 slow lane，不能吞错。

### Phase 2：第一条快车道（端到端打通一条）
- 选最确定、最低风险的一条先做。**候选首推 init-project**（已经是脚本，最容易），或"git 三连"。
- 把它注册成一个可执行 workflow，分诊器命中后直接执行，不进 invoke-single-cat。
- 验收：同样任务，fast lane vs slow lane，结果一致、耗时显著下降、token 大幅减少。

**第一条建议：project-init 快车道**

原因：
- 已有确定性脚本 `init-project.mjs`。
- 输入输出边界清楚：项目名、目录、模板文件。
- 风险低：主要写 `.cat-cafe/projects/<id>/` 和 README，可在临时目录测试。
- 用户价值明确：新项目初始化不需要完整 agent loop。

验收样例：

```text
输入：初始化一个项目 wechat-cli
fast lane：直接运行 project-init workflow
输出：brief.md / progress.md / decisions.md / handoff-index.md / handoff-log.md
证据：文件存在、git diff 可读、必要字段完整
回退：参数缺失或目录不安全时走 slow lane 或 ask-user
```

### Phase 3：沉淀循环（observe → freeze → wire → measure）
- **observe**：基于已有 task events，加"重复 toolSteps 识别"——同序列出现 ≥ N 次标记为候选。
- **freeze**：候选用 skill-to-workflow-freezer 固化成确定性 workflow。
- **wire**：固化后注册进 FastLaneRouter 白名单。
- **measure**：记录每条快车道的命中次数、省下的耗时/token、出错率；出错率超阈值自动退回 slow lane。
- 产出：一个最小的"快车道看板"（命中/收益/淘汰）。

**重复链路识别字段**

第一版不需要复杂算法，只记录这些字段：

```text
taskId
threadId
catId
normalizedIntent
toolSequenceHash
commandsHash
durationMs
inputTokens/outputTokens/costUsd
resultStatus
artifactCount
```

当 `toolSequenceHash + commandsHash` 在 7 天内重复出现 ≥ 3 次，进入候选池。
候选池只提示，不自动上线。

### Phase 4（可选）：智能分诊
- 在白名单基础上，引入轻量分类器判断"任务是否确定"。
- **这一步谨慎做**，宁可漏判（回退 slow）也不能误判（错走 fast）。

## 3. 候选快车道清单（按风险从低到高）

| 优先级 | 快车道 | 确定性 | 风险 |
|---|---|---|---|
| 1 | init-project 脚手架 | 极高（已是脚本） | 低 |
| 2 | git 三连（add/commit/状态） | 高 | 低 |
| 3 | 拉 diff 给人审 | 高 | 低 |
| 4 | 任务状态操作（claim/update） | 高 | 低 |
| 5 | 跑测试 + 回报结果 | 高 | 中 |
| 6 | review 三件套链路 | 中 | 中 |
| 7 | 生产线固定段（ppt 导出验证等） | 中 | 中 |

## 4. 验收标准（每个 Phase 单独验收）

- **零回归**：fast lane 关闭时，所有行为与现状一致（跑通现有测试）。
- **结果一致**：同一任务 fast vs slow 产出等价。
- **收益可量化**：至少一条快车道有耗时 + token 的前后对比数据。
- **安全回退**：分诊不确定时回退 slow；快车道出错率超阈值自动下线。
- **diff 验收**：每个 Phase 完成后拉 git diff，由 @专家-Claude 审过再进下一阶段。

## 5. 不做什么（防止范围蔓延）

- 不在 Phase 1-2 做智能分类，先白名单。
- 不一次接入所有候选快车道，一次一条端到端打通。
- 不动 slow lane 的现有逻辑（invoke-single-cat 保持不变）。
- 改造 2/3/4（ask-user / 变更上下文串联 / 沙箱）排在本方案完成之后，不并行。

---

## 后续路线图（本方案完成后）

- **改造 2**：ask-user 模式产品化
- **改造 3**：变更上下文串联（A2A 五元组 + PR → handoff-log）
- **改造 4**：非技术同学安全沙箱（预览-diff-回滚-审计）
