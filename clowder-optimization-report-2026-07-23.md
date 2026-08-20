# Clowder 优化空间分析报告

> 日期：2026-07-23
> 输入材料：`clowder-architecture-context-audit.md`（荧荧·探火 07-22 架构审计）、`raft_context_shared_state_handoff_discussion.md`（Shared State 方案讨论稿）、`raft-shared-state-验证报告-研究生kimi.md`（Raft 平台第一手交叉验证）
> 补充方法：对本机 Clowder worktree 的后端与前端源码做只读核实（含本地 `.env` 与 `.cat-cafe/projects` 实际数据，下文不写具体路径或项目 id）
> 范围：只读分析，未改代码、未改数据

---

## 0. 执行摘要

1. **定位结论：在 Session 治理这条线上，Clowder 已经领先 Raft。** kimi 第一手验证确认 Raft 缺失的能力——agent 可查的 context metrics、理智线、thread 自动摘要、task 数据层 CAS、Shared State——Clowder 中 contextHealth、sanity 绿黄红、ThreadMemory、freshness-hold expectedVersion、claim CAS 均已存在。双方共同的空白只有一个：**Shared State（Current Truth 层）**。这不是补课，是差异化机会。

2. **新发现一个审计未覆盖的 P0 级 bug：handoff-index 注入截断方向反了。** 索引文件尾部追加（`appendFile`），注入时却保留头部（`slice(0, maxChars)`），导致每轮 prompt 注入的是最旧的交接条目，最新交接被整段切掉。详见 §3。

3. **代码核实修正了审计报告的三个印象**：sanity seal 默认是开的；生产实际只跑一条 legacy+incremental 路径（ContextLayerRouter、content-free、deliveryOnly 全部未启用）；前端已有 ContextHealthBar/SessionChainPanel，但 **sanity 状态（绿黄红）没有透出到前端任何一处**。

4. **前端主要优化空间在渲染性能与状态可视化**：消息列表无虚拟化、`ChatMessage`/`MarkdownContent` 无 memo、`ChatContainer` 存在整库订阅；`useAgentMessages` 单文件 4560 行、`chatStore` 2881 行是维护性风险。设计层面建议围绕已有的 slock 改造规范收敛信息架构，并把 session/sanity 状态做成一等 UI 公民。

---

## 1. 三份文档交叉后的定位：Clowder vs Raft

kimi 报告的价值在于把讨论稿里的"Raft 能力清单（推断）"落实为第一手事实，与 07-22 审计叠加后，能力对照被显著修正：

| 能力 | Clowder（审计+代码核实） | Raft（kimi 第一手） | 修正后的结论 |
|------|------|------|------|
| Context metrics | ✅ contextHealth（usedTokens/window/fillRatio）+ lastUsage | ❌ "agent 根本看不到自己的 token 占用"，无 `raft context` 类命令 | **Clowder 领先**；缺的是分项与展示，不是数据 |
| 理智线 | ✅ 绿黄红 + sanity seal（默认开，见 §2） | ❌ 无任何内建理智线，仅错误退避 | **Clowder 领先** |
| Thread 摘要 | ⚠️ ThreadMemory + summary segments（canary） | ❌ 无 thread 自动摘要 | Clowder 基础设施在，需毕业 |
| Task 并发 | ⚠️ claim CAS 有，status 更新无 version | ⚠️ 同样 last-write-wins | 持平；都缺通用 CAS |
| 乐观锁思想 | ✅ freshness-hold expectedVersion（消息层） | ✅ held draft（仅消息层） | 持平；**双方都没推广到状态层** |
| Inbox pull 模型 | ⚠️ content-free inbox 已实现但未启用 | ✅ 生产默认（content-free notice + 主动 read） | Raft 领先（Clowder 有代码没开） |
| Shared State | ❌ 文档拼盘，无 state_version | ❌ "Channel=Event Log 做到位，Current Truth 一半是空的" | **共同空白 = 差异化机会** |

kimi 报告另有两处对方案本身的修正，建议直接采纳进 Clowder 配置：

- **红线阈值设 70% 而非 75–85%**——compaction 一旦发生质量已受损，等到 85% 太晚；
- **Handoff 定位为"state 的临时补丁"而非独立 artifact**——Shared State 维护得好，handoff 只剩"上一班没来得及沉淀进 state 的半成品"，SessionBootstrap digest 可随之瘦身。

kimi 设计的组合冒烟实验（500 条消息 + 3 个决策冲突点对，A 全量 / B 摘要 / C STATE.md+检索三组对照）成本一周内可控，建议作为 Shared State v1 的验收实验直接排期。其中最有价值的预测是：**B 组（纯摘要）token 平台化但现状题仍答错——纯摘要救不了"当前事实"**。若实测 B≈C，Shared State 方案降级为"滚动摘要+决策 pinned 区"即可，同样是有效结论。

---

## 2. 源码核实结果（对审计报告的更新）

| # | 核实点 | 结果 | 证据 |
|---|--------|------|------|
| 1 | sanity seal 默认状态 | **默认开启**（仅显式设 `0`/`false` 才关） | `SessionSanityMonitor.ts:53` |
| 2 | ContextLayerRouter | **默认关**（`CAT_CAFE_CONTEXT_LAYERS` 未设 → legacy，每轮注入 L2 project context） | `ContextLayerRouter.ts:33`、`.env` |
| 3 | content-free inbox / deliveryOnly | per-thread allowlist 环境变量，`.env` 未配置 → **全关** | `env-registry.ts:1565,1573`、`.env` |
| 4 | incremental 模式 | 有 `deliveryCursorStore` 即启用，是事实上的主路径 | `route-serial.ts:380`、`route-parallel.ts:239` |
| 5 | TaskStore version | **确认无 version 字段**，非 claim 更新为 last-write-wins | `ports/TaskStore.ts` 全文无 version |
| 6 | Shared State v1 | **完全未起步**：`.cat-cafe/projects/` 下无任何 state.json / current-state | 文件系统核实 |
| 7 | 项目上下文注入配置 | 本地 `.env` 注入了两个项目，但它们**只有 handoff-index.md（各约数十 KB），无 brief/progress/decisions** | `.cat-cafe/projects/` 核实 |
| 8 | 前端 session 可视化 | ContextHealthBar（F24）+ SessionChainPanel + CatTokenUsage 已有；**sanity 全字（绿黄红）在 `packages/web/src` 零命中** | grep 核实 |

审计报告的"Context 路径分叉过多"（P1）在生产上的真实形态是：**分叉都没开，但代码都在养着**。问题从"排障困难"变为"canary 长期不毕业的机会成本"。

---

## 3. 新发现 P0 bug：handoff-index 截断方向与写入方向相反

**现象链条**（全部在 `packages/api/src/domains/cats/services/agents/memory/ProjectProgressStore.ts`）：

1. 交接条目由 `writeContextHandoffForPromptProjects` 通过 `appendFile` 追加——**最新条目在文件末尾**（L352–398）；
2. 注入时 `readProjectFile` 用 `raw.slice(0, maxChars)` 截断——**保留文件开头**（L73–77，`PROJECT_HANDOFF_INDEX_MAX_CHARS = 6000`）；
3. 本地注入的两个项目的 handoff-index 已长到数十 KB。

**组合效果**：每轮 prompt 注入的"交接索引"是最旧的条目（实测 session-handoff 项目注入的是 2026-07-08 的条目）加一句"内容过长已截断"，而**最近两周的全部交接被切掉**。这不是审计 P1 说的"索引膨胀噪音"，而是**注入了错误的旧事实**——恰好是讨论稿 §4.2 预言的"Agent 拿到错误版本"，正在自家 prompt 管线里每天发生。

**修复建议**（按成本排序）：

1. 立即：截断改为保留尾部（`raw.slice(-maxChars)`），一行修复；
2. 短期：索引改为"最新在前 + 只保留最近 N 条"，旧条目归档到 `handoff-archive.md`；
3. 顺手：清理 `CAT_CAFE_PROJECT_CONTEXT_IDS`——当前两个项目连 brief 都没有，注入内容是纯 token 负资产；要么补齐四件套，要么移除。

---

## 4. 后端优化优先级

### P0（本周就值得做）

**P0-1 handoff-index 修复与治理**：见 §3。

**P0-2 Shared State v1**：`projects/{id}/state.json`，含 mission / current_phase / decisions（带 supersedes）/ blockers / next_actions / `state_version`。更新走 Patch + `base_version` CAS（讨论稿方案 A；kimi 建议事件溯源等冲突真实出现再升级为方案 B）。Clowder 的 freshness-hold 乐观锁代码可直接推广。Prompt 只注入 current-state 摘要，细节按需读。验收用 kimi 的组合冒烟实验（§1）。

**P0-3 把 contextHealth/sanity 透出给猫和 UI**：kimi 报告最有力的一句话——"agent 只能靠行为劣化事后发现——太晚了"。Clowder 数据都在 Redis，缺的只是：① prompt 里注入一行"你当前 fill 72%、sanity 黄、seq 3"；② 前端 sanity chip（见 §5）。这是所有改进里投入产出比最高的一项。

### P1

**P1-1 Task 全字段 version CAS**：把 `claimIfUnowned` 的 CAS 思想推广到 status/字段更新，加 `expectedVersion`。

**P1-2 Context Policy 收敛**：ContextLayerRouter、content-free、deliveryOnly 三个 canary 要么毕业默认开、要么删除。判断依据：先做 P1-3 的分项计量，用数据决定去留。

**P1-3 prompt 分项 token 落库**：每轮记录 system / history / bootstrap / project / memory / tools 各段 tokens + `history_mode`。没有这个，P0-1 修完也无法验证效果，P1-2 也没有决策依据。`runtimeContextBudget` 快照已有雏形（route-serial/route-parallel），差落库与展示。

**P1-4 CLI session 膨胀的黄区前置动作**：sanity seal 已默认在线，但生产可见长 session 的累计 input 可达数百万、fill 接近红线才触发 threshold seal。建议黄区（0.55–0.70）即禁止接新任务、完成最小可验收单元、预生成 handoff draft——讨论稿 §7.2 的黄区动作清单可直接落为 session-strategy 的 hook。

### P2

thread 摘要毕业（summary-active 成为长 thread 默认）、workspace file lease、Channel 术语统一（或引入 Channel 容器，与 slock 改造的 IA 对齐，见 §5）。

---

## 5. 前端源码分析与设计优化建议

### 5.1 现状概览

- 规模：`packages/web/src` 约 9.3 万行（不含测试），189 个组件；Next.js App Router + Tailwind 3 + zustand + Socket.IO。
- 主题系统：`theme-tokens.css` 803 个 CSS 变量，支持 dark mode（`data-theme`）+ 5 套视觉主题（default/claude/slockv1/slock/kami）。
- 本 worktree 即"slock-like WebUI 改造"工作区，`docs/design/slock-like-webui-spec.md` 已定义目标信息架构（Activity Rail / Space List / Message Timeline / Context Panel 四栏）与两阶段边界。
- 历史加载：50 条/页分页（`useChatHistory.ts`），导出上限 10000。

### 5.2 性能：三个叠加的重渲染问题（建议一起修）

这是前端最大的优化空间，三个问题相乘而非相加：

1. **消息列表无虚拟化**：`ChatContainer.tsx:1338/1525` 直接 `messages.map(renderSingleMessage)`。分页缓解了首屏，但用户向上翻页后 DOM 无上限增长；生产 thread 最长 2500+ 条。
2. **消息组件无 memo**：`ChatMessage.tsx`（893 行）、`MarkdownContent.tsx`（921 行）、`MessageActions.tsx` 均为普通函数组件，无 `React.memo`/`useMemo`。任何一次 store 更新都会让**所有已渲染消息重新执行 markdown 解析**。
3. **整库订阅**：`ChatContainer.tsx:210-217` 用 `useChatStore()` 无 selector 解构，store 任意字段变化（包括流式输出的每次 patch）都触发整容器重渲染。代码注释显示 F173 Phase C 正在做 thread-scoped selector 迁移，但这个入口还没迁完。

**建议动作**（一天量级）：① `ChatMessage` 套 `React.memo`，props 收敛为原始值/稳定引用；② `MarkdownContent` 对 `content` 做 memo（内容不变不重新解析）；③ `ChatContainer` 顶部整库解构改 selector；④ 中期上 `react-virtuoso`（对倒序聊天列表支持好），或先做"DOM 中最多保留 N 条 + 顶部哨兵释放"的轻量方案。修完后流式输出期间的 CPU 占用应有数量级改善——这直接影响 3003 端口日常使用手感。

### 5.3 可维护性：两个"上帝文件"

- `useAgentMessages.ts` **4560 行**：bubble/invocation 生命周期全在一个 hook 里（含 ledger、replaced-invocations、timeout 诊断等）。
- `chatStore.ts` **2881 行** + `chat-types.ts` 750 行：单一 zustand store 承载全部聊天域状态。

不建议大重构（slock 改造期间动它风险高），但建议：新功能不再往这两个文件加代码，按 F173 的 thread-scoped 方向拆 slice；给 `useAgentMessages` 补充状态机图文档，作为后续拆分的依据。

### 5.4 设计建议一：把 Session/Sanity 做成一等 UI 公民

这是前端与后端 P0-3 的同一件事的两面，也是对审计 P2"Session 状态对终端用户不够显眼"的具体化：

1. **sanity 绿黄红目前完全没有透出**（`packages/web/src` 全文无 sanity）。建议在 thread header 的猫头像旁加 session chip：`#seq · fill% · 绿/黄/红点`，红色即引导用户/猫换班。数据后端都有，是纯前端接线工作。
2. **前端阈值与后端理智线打通**：`ContextHealthBar` 硬编码 warn 0.70 / danger 0.85，与后端 sanityLine 独立两套尺子。建议阈值从 API 下发，且按 kimi 修正把红线校到 0.70 附近——UI 显示的"红"应该等于系统真的要动作的"红"。
3. **"本轮上下文来源"面板**：审计 Phase 1 的 per-turn source panel 落在 `RightStatusPanel`——展示本轮 prompt 的 system/history/bootstrap/project/memory 分项 tokens（依赖后端 P1-3）。这会把"猫为什么这么答"从玄学变成可排障。

### 5.5 设计建议二：沿 slock 规范收敛信息架构

slock spec 的方向（弱化游戏感、复杂运行状态收进右侧 Context Panel、Channel→Message→Thread Reply 心智）是对的，落地时三个具体建议：

1. **Hub 的 20+ 个 Tab 是最大的 IA 债**（`Hub*Tab.tsx` 组件 20 余个：Accounts/Capability/Commands/ConnectorConfig/EnvFiles/Governance/Leaderboard/Memory/Observability/Permissions/QuotaBoard/RoutingPolicy/Skills/ToolUsage…）。建议按 spec 的心智重新分组为 3–4 个顶层入口（团队与权限 / 运行与观测 / 记忆与技能 / 系统配置），低频页面收进"设置"，不要平铺。
2. **右侧 Context Panel 优先承载"当前事实"**：Shared State v1 落地后，Context Panel 的第一屏应该是 project current-state（mission/phase/blockers/next），Tasks/Evidence/Files 退居 tab——这正好把后端 P0-2 变成用户可感知的产品能力，也是和 Slack/Raft 拉开差距的展示面。
3. **术语统一在 UI 层先行**：后端 Channel 实体可以不引入（审计 P2），但 UI 文案先按 spec 统一为 Channel/Thread Reply 心智，避免"频道/Thread/毛线球"混用增加新用户认知成本。

### 5.6 设计建议三：主题与样式系统治理

1. **色值逃逸 token 系统**：`ContextHealthBar.tsx` 里 `gpt52: '#66BB6A'`、`sonnet: '#B39DDB'` 等 per-cat 色值硬编码在组件里，warn/danger 色也是字面量。建议全部收进 `theme-tokens.css`（已有 `--color-{cat}-primary` 惯例，补齐 variant 即可），否则 5 套主题 × 硬编码色值会持续产生对比度/暗色模式缺陷。
2. **主题数量收敛**：803 个 token、5 套视觉主题的维护成本随组件数线性增长。slock 改造期间建议冻结为 2 套（slock 亮/暗），claude/kami 等转为社区/彩蛋级，不进回归范围。
3. **样式双轨制收敛**：Tailwind + 2900 行手写 CSS（console-shell 1523 行）并存。改造期间新组件统一走 Tailwind + token，`console-shell.css` 只减不增。

---

## 6. 建议路线图（合并前后端）

| 阶段 | 内容 | 依赖 |
|------|------|------|
| 本周 | §3 截断修复 + PROJECT_CONTEXT_IDS 清理；ChatMessage/MarkdownContent memo + selector 修复 | 无 |
| Phase 1 可观测 | prompt 分项 token 落库；sanity chip + ContextHealthBar 阈值统一；per-turn 来源面板 | 后端 P1-3 |
| Phase 2 Shared State | state.json + version CAS + Context Panel 第一屏；kimi 冒烟实验验收 | P0-2 |
| Phase 3 收敛 | canary 毕业/删除决策；Task version CAS；黄区前置动作；Hub IA 重组 | Phase 1 数据 |
| Phase 4 打磨 | 消息列表虚拟化；thread 摘要毕业；主题收敛；workspace lease | — |

---

## 7. 证据索引

**文档**：`clowder-architecture-context-audit.md`（仓库根目录）；本机 Downloads 下的 Raft Shared State 讨论稿与交叉验证报告（不入库）

**后端代码**（`packages/api/src`）：
`domains/cats/services/agents/memory/ProjectProgressStore.ts`（L7-11 截断上限、L73-77 slice 方向、L352+ appendFile 写入）；`domains/cats/services/session/SessionSanityMonitor.ts:53`；`domains/cats/services/context/ContextLayerRouter.ts:33`；`domains/cats/services/agents/routing/route-serial.ts:380`；`config/env-registry.ts:1565,1573`；`domains/cats/services/stores/ports/TaskStore.ts`

**前端代码**（`packages/web/src`）：
`components/ChatContainer.tsx`（L210-217 整库订阅、L1338/1525 无虚拟化 map）；`components/ChatMessage.tsx`、`components/MarkdownContent.tsx`、`components/MessageActions.tsx`（无 memo）；`components/ContextHealthBar.tsx`（硬编码阈值与色值）；`components/SessionChainPanel.tsx`；`hooks/useAgentMessages.ts`（4560 行）；`stores/chatStore.ts`（2881 行）；`hooks/useChatHistory.ts`（50/页分页）；`app/theme-tokens.css`（803 tokens / 5 主题）

**数据核实**：本地 `.env` 注入了两个只有 handoff-index、没有 brief/progress/decisions 的项目；索引各约数十 KB，截断后注入的是最旧条目。

*报告结束。*
