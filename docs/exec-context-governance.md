---
feature_ids: []
topics: [context-governance, performance, cost, first-principles, execution-plan]
doc_kind: spec
created: 2026-06-30
author: 专家-Claude
status: proposed
context: "Clowder 减法路线·上下文治理层 — 第一性原理出发，按需注入，治慢/贵/重"
---

# 执行方案：Clowder 上下文治理层（减法路线）

> **一句话**：让 Clowder 每轮只注入"这一轮真正需要的上下文"，治掉慢/贵/重；先可观测，再分层按需注入，最后控历史膨胀。
> **执行者**：@老者-codex。**验收**：@专家-Claude。
> **定位**：这不是新增一套文档体系（那会增熵），而是减法路线的**上下文治理层**。

## 0. 第一性原理再审视

Clowder 的引擎是 LLM，受四条不可违背的定律约束。其中最硬的一条：
> **每轮 token 是有成本、有上限、决定速度的。注入越多，越慢越贵越容易撞墙。**

实测依据（@老者-codex 抓 Redis，n=978）：opus-45 输入 p50≈329k token、耗时 p50≈59s，单轮成本可达 $1.9+。**重上下文是常态。**

**但要诚实——Clowder 已经做对了一部分，不能全盘否定**（避免今天那种"凭印象判断"的错）：
- shared-rules **不是全量注入**：已编译成 `GOVERNANCE_CORE_DIGEST` / `GOVERNANCE_OPERATIONAL_DIGEST`，完整原文仅在 magic word 触发时才注入（`SystemPromptBuilder.ts`）。
- skill **不是全量塞**：`SkillRouter` 已按消息 `scoreSkillMatch` / `matchExplicitCommand` 选择性注入。

**所以真正还重的是这几块（治理重点）**：
1. **会话历史**：`claude --resume` 每轮回放历史，长 thread 越滚越大（cache read 大头来自这里）。
2. **项目上下文**：brief/progress/decisions/handoff-index/handoff-log 仍偏重，尤其需要避免全文交接日志默认注入。
3. **缺分层**：现有选择性注入是零散的（digest + skill router），没有统一的"L1 默认 / L2-L3 按需升级"框架。
4. **看不见**：没有每轮 token/成本面板，无法判断"哪一轮为什么重"。

**第一性原理结论**：不是推倒重建，而是**把已有的零散按需逻辑，升级成统一的分层治理 + 先做可观测**。

## 1. 落点（先读代码）

- `context/SystemPromptBuilder.ts`（1217行）：上下文总装配，含 governance digest 逻辑。
- `context/SkillRouter.ts`（276行）：已有 skill 选择性注入（matchSkills/scoreSkillMatch）。
- `context/ContextAssembler.ts`：上下文拼装。
- `agents/memory/ProjectProgressStore.ts`：brief/progress/decisions/handoff-index 读取注入，handoff-log 通过索引按需打开。
- `agents/invocation/QueueProcessor.ts`：`appendUsageTaskEvents()` 已记录 provider/model/token/cost → 可观测的现成数据源。
- cat 上下文窗口配置：`model_context_window` / `model_auto_compact_token_limit`（已有 compaction 钩子）。

## 2. 分阶段实施（先可观测 → 再分层 → 再控历史）

### Phase 1：可观测——每轮 token/成本面板（最高优先，先做）
对应第一性原理"失败/成本可读"。**不先可观测，后面减哪里全是猜。**
- 数据源已有：`appendUsageTaskEvents` 里有 input/cacheRead/cacheCreate/output/cost/duration。
- 做一个面板/视图：每轮调用显示 `input / cacheRead / cacheCreate / output / duration / cost`，并能按 cat/thread 看分布。
- **验收**：能看到任意一轮的 token 构成和成本；能看出"哪几轮最重、重在历史还是项目上下文"。

### Phase 2：统一分层注入框架 L1 / L2 / L3（核心，借鉴 ai-project-workflow-skill）
把现有零散的选择性注入，收拢成一个清晰的分层规则。**默认只给 L1，按需升级。**
```text
L1（默认，每轮都给）：身份/角色 + governance digest + 当前任务 + 最小必要历史
L2（按需）：项目上下文（brief/progress/decisions/handoff-index）+ 代码情报产物 —— 仅当任务涉及该项目/系统理解时
L3（按需）：完整 shared-rules 原文 + review/评审机制 —— 仅当 magic word / 评审任务触发
```
- 落点：在 `SkillRouter` / `SystemPromptBuilder` 之上加一层"注入分级决策"，判断这轮该给哪几层。
- 复用现有：digest（已是 L1）、full shared-rules on-trigger（已是 L3）、skill 匹配（已是按需）。**新增的是 L2 项目上下文的按需化**（现在是全量给）。
- **验收**：日常对话/轻任务只注入 L1，token 明显下降；涉及项目的任务才加载 L2；flag 控制、可灰度、零回归。

### Phase 3：历史膨胀治理（治 cache read 大头）
长 thread 的历史是 input token 的主要来源。
- 具体方案见 [`context-history-governance-phase3.md`](./context-history-governance-phase3.md)。
- 复用已有 `model_auto_compact_token_limit`、`contextBudget`、`summary_segments`、`summary_state` 和 `compact_boundary`，不新建平行记忆系统。
- 超过阈值后采用"历史摘要 + 最近原文窗口"替代旧历史；当前用户消息、任务状态、身份/家规、项目决策等高风险信息永远从真相源注入。
- 先 observe-only，再 shadow summary，再 canary summary-active，最后只对长 thread 默认启用。
- **验收**：长 thread 的单轮 input token 不随对话无限增长；有摘要兜底。

### Phase 4（可选，later）：版本边界 + 代码情报产物
借鉴 ai-project-workflow-skill，但**改造成多猫共享事实源**（不是每猫各写）：
- 版本边界：`.cat-cafe/projects/<name>/` 下加版本 scope/acceptance/封版门禁锚点。
- 代码情报产物：`system-map / module-map / api-index` 沉淀，agent 读产物不重啃源码（省 token）。
- 这些作为 L2 的内容来源，按需加载。

## 3. 推进顺序与依赖
```text
Phase 1 可观测（独立，先做，立刻有用）
  → Phase 2 L1/L2/L3 分层注入（核心，依赖 Phase 1 的数据判断减哪里）
  → Phase 3 历史膨胀治理（依赖面板确认历史确实是大头）
  → Phase 4 版本边界/代码情报（可选增强，作为 L2 内容）
```

## 4. 通用验收原则
- **零回归**：每层注入逻辑加 flag，off 时行为不变。
- **可量化**：每个 Phase 用 Phase 1 的面板证明 token/成本真的降了（不靠感觉）。
- **不增熵**：不新建平行文档体系；复用现有 .cat-cafe/projects、handoff-log、Task Event Ledger、SkillRouter。
- **diff 验收**：每个 Phase 完成拉 git diff，@专家-Claude 审。

## 5. 不做什么
- 不推倒现有 digest / skill router 逻辑（它们已经是对的，只是要收拢）。
- 不一次性改全部注入；先面板，再一层层收。
- 不照搬 ai-project-workflow-skill 的单仓库单 agent 假设；要适配多猫协作。
- Phase 4 不阻塞 1-3。

---

**核心思想**：Clowder 不缺功能，缺的是"对齐自己的 token 定律"。这份方案就是把"按需注入"从零散做法，变成**可观测、分层、可验证**的上下文治理层。
