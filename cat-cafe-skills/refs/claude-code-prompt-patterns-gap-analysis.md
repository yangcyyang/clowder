---
doc_kind: research-extract
topics: [prompt-engineering, pack-instructions, a2a, subagent-design, skill-authoring]
created: 2026-07-06
source: https://github.com/Piebald-AI/claude-code-system-prompts (clone 于 /Users/cy/.slock/external-clones/claude-code-system-prompts，只读引用，不入 Clowder 代码库)
---

# Claude Code 官方 System Prompt 提取 vs Clowder Pack 指令 · Gap 对照与提案

Epic A（弹药库吸收）A1-A3 交付物。来源仓库是从 Claude Code 编译产物里逆向提取的真实 system prompt 片段（553 个文件），非猜测/非二手转述。四个后台 agent 分别读完 `agent-prompt-*`（64 个，子代理设计）、`system-prompt-*`（130 个，主 prompt 协作/安全/记忆惯例）、`skill-*`（63 个，内置 skill 写法）三类全部原始文件，逐条提炼。本文件只保留和 Clowder 现有 `cat-cafe-skills/refs/shared-rules.md` 及猫 prompt 设计有实际差距的条目；已经被 Clowder 现有规则覆盖的模式不重复列出。

## 一、Gap 对照表

| # | 官方模式 | 来源文件 | Clowder 现状 | Gap |
|---|---|---|---|---|
| 1 | 危险操作按「可逆性 × 影响半径」二维矩阵分级，四类穷举清单（破坏性/难撤销/影响他人可见状态/上传第三方） | `executing-actions-with-care.md` | 安全规则只有粗粒度"危险操作先确认"，无分级矩阵 | 缺精确分级标准 |
| 2 | 批准不跨上下文："approving once ≠ approving forever"，授权只覆盖明确指定范围 | `executing-actions-with-care.md` | 升级铲屎官三个硬条件已有"不可逆操作前确认"，但未限定批准的作用域边界 | 缺"批准范围不能扩大解释"的显式规则 |
| 3 | 用户批准后，coordinator 不能把批准原文转发给同一个 worker 继续执行——没有任何 agent 消息能代表用户对另一个 agent 的同意 | `coordinator-worker-instructions.md` | Clowder A2A 里"猫代传铲屎官批准"没有明确规则 | 缺"批准防伪造/防中继"机制 |
| 4 | Never delegate understanding：派活前必须自己先读懂，把发现浓缩成具体 spec 再转下去，不能只说"根据你的发现去修" | `coordinator-mode-orchestration.md` | 本轮对话里 Opus4.8 反复用这条原则（"我不照单全收，自己 git 核实"），但 shared-rules.md 没有正式写这条 | 已是实践默契，未固化成文字规则 |
| 5 | worker 回复固定拆两段：①具体证据（文件路径+行号）②给上级转述用户的一句话总结 | `coordinator-worker-instructions.md` | A2A 交接六项已要求 What/Why/证据，但没有强制"证据层"与"转述层"分离 | 结构上可以更精确 |
| 6 | 委派本身要接受和普通动作同等的安全治理：spawn 子代理时检查其 prompt 是否指示违规操作，在 spawn 那一刻就拦截 | `agent-prompt-security-monitor-for-autonomous-agent-actions.md` | 工兵/执行猫的权限边界只约束"接活猫做什么"，没有约束"派活猫能不能借委派绕过规则" | 缺委派动作本身的审查 |
| 7 | 委派 worker 时 prompt 必须完全自包含（整体目标+任务原文+已知约定+验证配方），因为 worker 之间互相看不到彼此上下文 | `agent-prompt-batch-slash-command.md` | 实践中常见但未写成规则 | 可固化为 A2A 派工的硬性检查项 |
| 8 | Fork/子 agent 场景："不偷看"（不能在系统通知前读 fork 的 output）+"不竞速"（通知到达前不能编造或预测结果） | `system-prompt-fork-usage-guidelines.md` | Agent 工具的实际行为已隐含此规则（本 harness 层面已执行），Clowder 多猫之间的后台任务通知机制未见对应文字规则 | 值得写进 shared-rules 的"防漏接"章节 |
| 9 | CLAUDE.md 与 memory 冲突时：memory 明显更新且明确纠正 CLAUDE.md，也不能让自动整理流程擅自改 CLAUDE.md，只能标记"contradicts CLAUDE.md — verify which is current"交给用户 | `system-prompt-dream-claudemd-memory-reconciliation.md` | Clowder 有"Config Immutability"铁律（不能 runtime 改 cat-catalog.json 等），精神一致，但没有明确"memory 与 CLAUDE.md/Pack 指令冲突时怎么处理"的细则 | 可以补一条仲裁规则 |
| 10 | Team 共享记忆保守裁剪：不能因为"跟我无关"删队友写的 team memory，只有被最新代码明确否定、或被标记 superseded 才能删；个人记忆晋升 team 记忆必须用户主动操作 | `system-prompt-dream-team-memory-handling.md` | Clowder 的 `.cat-cafe/memory/{catId}.md` 按猫隔离，目前没有"团队共享记忆池"概念，此条暂无直接对应场景 | 观察项，等 Clowder 出现团队共享记忆需求时再引入 |
| 11 | 纠正一个可重复步骤时，除了存 feedback memory，还要把纠正回写进驱动该步骤的 skill 文件本身 | `system-prompt-project-skill-upkeep-for-feedback-memory.md` | Clowder 的 quality-gate/receive-review 闭环里没有"记忆自动反哺 skill 文件"这一环 | 可作为 memory-consolidator 的补充动作 |
| 12 | code-review 类 skill 被拆成可组合的微 skill 片段（找 bug 的角度、验证策略、输出格式三层解耦），按 effort 级别动态拼装 | `skill-code-review-*.md`（10+ 个文件） | Clowder 的 `/code-review` 已经借鉴了 low/medium/high/xhigh/max 分档设计（本次会话开头可见），但未做到"角度/验证/输出"三层文件解耦复用 | 部分已借鉴，可进一步拆分复用 |
| 13 | verify 类 skill 用四态 verdict（PASS/FAIL/BLOCKED/SKIP）+"When in doubt, FAIL"不对称原则 | `skill-verify-skill.md` | Clowder review 用 CONFIRMED/PLAUSIBLE 二态，没有 BLOCKED/SKIP 区分，也没有"存疑判 FAIL"的显式偏置 | 和 Epic B1 的评估方法选型直接呼应，建议合并推进 |
| 14 | skill description 用"用户真实会打出来的动词/短语"列表，而非抽象类别覆盖描述（如直接写"chart, dashboard, sparkline, heatmap"而非"数据可视化相关请求"） | `skill-data-visualization.md`, `skill-run-skill-generator.md` | cat-cafe-skills 的 description 目前混合两种写法，未统一要求"具体动词命中" | 可作为 skill 编写规范的小补丁 |
| 15 | 主动提议要不要设定时任务被限制得极严：只有当本轮工作留下"可逐字引用的、带明确未来日期/条件"的产物时才能提，且整个 session 最多提一次 | `system-prompt-strict-proactive-schedule-offer-gate.md` | `schedule-tasks` skill 没有类似的"何时才该主动提议"量化门槛 | 可用于收紧 schedule-tasks 的主动性 |
| 16 | Advisor/第二意见调用前，先让自己的产出变得 durable（写文件/commit），因为调用耗时、session 可能中断 | `system-prompt-advisor-tool-instructions.md` | Clowder 的 request-review 环节没有明确"先固化产出再喊 review"的顺序要求 | 可补进 request-review skill |
| 17 | 数值置信度（1-10）作为多阶段编排的唯一交接协议，下游只需数值比较不必重新理解语义 | `agent-prompt-code-review-part-3/4/5.md`, `agent-prompt-security-review-slash-command.md` | Clowder review verdict 是文本态，无数值置信度 | 可选优化，非必须 |

## 二、提案清单（按优先级）

以下是建议真正落地的条目，已按"改动小、价值高"排序：

1. **把"Never delegate understanding"写进 shared-rules.md**（对应 Gap #4）。这条本来就是 Opus4.8 今天在这个 thread 里反复实践的原则（每次不照单全收、自己 git/代码核实再表态），只是没有固化成文字。建议加进"操作规则"章节：*"派活前必须自己先理解现状，把发现浓缩成具体 spec 再转下去；不能只说'根据你的发现去修'，把理解责任推给接活猫。"*

2. **危险操作分级矩阵替换现有粗粒度规则**（对应 Gap #1、#2）。把"安全规则"章节的"危险操作先确认"细化成：可逆性 × 影响半径两维度 + 四类穷举（破坏性/难撤销/影响他人可见状态/上传第三方），并加一句"批准不跨上下文，范围不能扩大解释"。这条直接提升"升级铲屎官三个硬条件"的判断精度。

3. **A2A 派工自包含检查项**（对应 Gap #7）。给"操作规则 §1 A2A 交接六项"加一条硬性检查：接活猫看不到派活猫的会话上下文，派工消息必须自包含（目标+任务原文+已知约定+验证配方），不能假设对方能推断缺失信息。

4. **worker 回复两段式结构**（对应 Gap #5）。给"交付任务"规则补充：证据层（文件路径/行号/commit）与转述层（给上级一句话总结）分开写，而不是混在一段里——这对 Opus4.8 这种"验收但不看聊天记录、只 git 核实"的角色尤其有用。

5. **委派动作本身纳入安全治理**（对应 Gap #6）。给"权限边界"章节加一句：派活给别的猫时，如果接活猫的职责有权限边界（比如工兵不能做删除/密钥操作），派活猫本身也要在派工那一刻检查，不能靠"委派给别人做"绕过限制。

6. **verify 四态 + "存疑判 FAIL"**（对应 Gap #13，和 Epic B1 合并推进）。建议 quality-gate/receive-review 引入 PASS/FAIL/BLOCKED/SKIP 四态，且不确定时默认判 FAIL 而非 PLAUSIBLE，配合 Epic B1 的"二元化"建议一起落地成评分卡设计的一部分。

7. **CLAUDE.md/Pack 指令冲突仲裁规则**（对应 Gap #9）。给"Config Immutability"铁律补一句：memory 或猫的判断如果和 CLAUDE.md/Pack 指令冲突，不能擅自当场改配置文件，只能标记冲突、交给铲屎官决定，即使 memory 明显更新。

8. **Fork/后台任务"不偷看不竞速"写进防漏接章节**（对应 Gap #8）。这是本 harness 已经在执行的规则，但没写进 Clowder 自己的 shared-rules——建议明确一句："等后台任务/agent 通知到达前，不能编造或预测其结果，哪怕铲屎官追问也只能如实说'还在跑'。"

## 三、A4 试点建议（尚未执行，等方案决策角色拍板）

A4 要求"选一只猫改 prompt，跑真实任务出前后对比"。建议试点对象和改法：

- **候选猫**：`checklist-worker`（清单工兵）——它的职责边界本来就窄（不做裁决、不碰高风险配置），最适合验证"提案 #3 A2A 自包含检查项"和"提案 #6 四态 verdict"这两条改动的效果，风险最低、最容易观测前后差异。
- **改法**：给它的 role/personality 补一句"如果任务描述缺派工方该给的上下文（目标/验证配方/已知约定），先在 thread 里指出缺口，不要猜测执行"；输出态从"清单+建议"扩展成四态标注（每条 PASS/FAIL/BLOCKED/SKIP）。
- **验证方式**：找一张最近工兵做过的真实核查任务，对比"改动前工兵怎么处理缺上下文的情况"vs"改动后"，或者派一个新的核查任务分别用改前/改后 prompt 各跑一次，看输出结构和缺口识别能力的差异。
- 这一步涉及改动实际猫配置（`personality`/`roleDescription`），按 Clowder 配置铁律需要走 Owner 走 `/api/cats` PATCH 或成员配置 UI，不是我能直接改的运行态操作——需要方案决策角色或铲屎官拍板要不要做、由谁落地这个改动。

## 附：三段抽取（A1 摘要，未逐文件贴全文，完整原文见 clone 仓库）

- **主 prompt（system-prompt-*，130 个文件）**：覆盖沟通风格、coordinator-worker 协作、安全谨慎、记忆/任务管理四大类，是本次 gap 对照的主要来源。
- **子代理 prompt（agent-prompt-*，64 个文件）**：覆盖 sub-agent 结构范式（角色定位+边界清单）、多阶段编排（effort 分档、并行 fan-out 防互相压制）、委派判断标准（信心不足触发、上下文卫生、防重复 spawn、递归深度硬上限）。
- **内置 skill（skill-*，63 个文件）**：覆盖 description 触发词写法、正文决策表结构、Common Mistakes/Red flags 章节写法、skill 间引用与依赖协议。
