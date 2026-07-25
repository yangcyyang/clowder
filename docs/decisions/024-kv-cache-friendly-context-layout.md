---
feature_ids: [F042, F129, F148, F167]
topics: [context-engineering, kv-cache, prompt-cache, cost, latency, architecture, transport]
doc_kind: decision
created: 2026-07-19
decision_id: ADR-024
---

# ADR-024 v2: KV Cache 友好的上下文布局 — 动态段迁移、缓存边界约定与 Transport 集中化

> **Status**: accepted（v2.1，宪宪架构评审通过；两处精度订正已折入）
> **Deciders**: 铲屎官（拍板）+ 宪宪（架构评审）+ 砚砚（落地）
> **Author**: 墨墨（kimi）
> **灵感来源**: 《深入理解 AI Agent》§2.3「KV Cache 友好的上下文设计」（李博杰）；Maka Terminal-Bench v11 报告
> **修订记录**: v1 方向通过、落地前退回；v2 修订三点——①记忆摘要下放队尾 meta（分界线改为"session 内写不写"）；②"丢弃旧 meta"升级为"meta 永不持久化"不变量；③影响面补 transport 层与全部 provider 适配器，meta 落点集中为单一 transport seam（评审确认的架构叉子）；更正 prompt-digest 模块误认。

## Context

### 原理（书 §2.3 的三条核心结论）

Prompt Cache / KV Cache 按**前缀字节序列**匹配：前缀逐字节稳定则命中，变一个字符则从变动点往后全部重算。三条工程纪律：①系统提示词与工具定义冻结；②动态信息永远**追加到上下文末尾**；③使用标准 API 消息格式。缓存命中与未命中成本差约 10 倍（K3：2 元 vs 20 元/百万输入 token；Anthropic cache read 约 1/10），且直接决定 TTFT。

### Clowder 现状（代码实证，v2 补全）

每条调用的 prompt 由三层产物拼装，**三层都含每轮必变内容**：

```text
┌─ A. system prompt（SystemPromptBuilder.buildSystemPrompt:1245）
│  ├─ buildStaticIdentity:691   角色/家规/名册/治理摘要      ← 逐字节稳定 ✅
│  │   └─ 内含：跨 Session 记忆摘要、project 四件套、lessons  ⚠️ session 内会回写
│  │   └─ shouldInjectProjectContext:826 的"注不注入"条件判断本身也是 cache-breaker ⚠️
│  ├─ buildReviewerSection:1149  半稳定 ✅
│  └─ buildInvocationContext:863 【每轮必变】❌
│       A2A 来源/乒乓球警告/当前模式/Task Gate(msg id)/Skill Router 命中/
│       contextUsageWarning/voiceMode/bootcamp/guide/world/signals…
├─ B. transport 产物（真实字节注入序，route-helpers.ts:3256-3264；
│     注意 :3168 是 token trim 裁剪降级顺序，不是注入顺序，方向几乎相反）
│     coverageMap+threadMemory（每轮重算）→ tombstone → anchors（每轮重算）
│     → evidence（recallEvidence 每轮新 hybrid 搜索）→ burst              ❌ per-turn 产物全坐在真历史 burst 之前
├─ C. 导航/快照（route-helpers.ts:2656/1663）
│     navigationHeader（传球时间/活跃毛线球）+ [Agent Inbox Snapshot]      ❌ 每轮必变
└─ D. 对话历史 burst + 当前消息   历史本应是最长的稳定前缀，被 A/B/C 三处断点切碎 ❌
```

调用侧（v2 补充）：`buildInvocationContext` 在 `route-serial.ts:694` / `route-parallel.ts:444` 调用，且 `contextUsageWarning` 变化时每轮重建整段 2–3 次（`route-serial.ts:857/:929`、`route-parallel.ts:591/:658`）；`route-serial.ts:848–861` 在路由内联拼装 `[invocationContext, catModePrompt, bootstrap, mcpInstructions, contextText, explicitMessage]`——**没有统一的 transport 拼装层**。

CLI 注入路径：Claude 走 `--append-system-prompt`（`ClaudeAgentService.ts:239`）；Kimi 由 `buildKimiPrompt`（`kimi-event-parser.ts:102`）拼成单字符串 blob。另有 ~10 个 provider 适配器（Codex/Grok/Gemini/Pi/Dare/OpenCode/A2A/CatAgent/Antigravity/ACP）各有 transport 契约。

### 问题量化

当前每次调用只有静态 Pack（约 15–20KB）处于稳定前缀；断点之后的动态段（2–5KB）+ transport 产物 + 对话历史（可达 100–200KB）**每轮全量 prefill**。缓存覆盖率约 10–20%，理想布局下可达 95%。

## Decision

### D1：每轮及 session 内可写的内容，统一迁到「队尾 meta 块」

**分界线（v2 修订）：按"session 内写不写"切，不按"每天几次"切。**

- **session 内不动的**（名册、家规、治理摘要、routing policy、reviewer 段、Skill Router 通用说明、A2A 稳定规则文本）→ **留在 Pack 冻结**；
- **session 内会写的**——无论频率高低——**全部下放队尾 meta 块**。包括：跨 Session 记忆摘要（工作单元完成即回写，活跃猫一个 session 写数次）、project progress、lessons 注入、`shouldInjectProjectContext` 的条件产物，以及 v1 已列的 Task Gate / Skill Router 命中 / 导航 / Inbox Snapshot / 模式提示 / voiceMode / bootcamp / guide / world / signals / A2A 来源 / 乒乓球警告 / contextUsageWarning。

理由：缓存失效的传播方向是"从变动点往后全废"。记忆摘要留在 Pack 尾 = 每次 memory 回写炸掉其后整条历史缓存，正好抵消 D1 的收益；`epoch` 标注救不了它，**位置才是杠杆**。注意力角度反向支持下放：队尾 meta 紧邻当前消息，回忆精度最高（书 §2.3 位置偏好），salience 不降反升。

迁移后布局：

```text
[STATIC SYSTEM]  静态 Pack + reviewer（同一猫 session 内逐字节稳定）
[HISTORY]        对话历史（稳定前缀，可缓存）
[META BLOCK]     当轮动态产物（见上清单），每轮重算、随算随弃
[CURRENT MSG]    当前用户消息
```

**Identity 行例外**：F042 防身份坍缩要求钉住，且其内容（catId/model）config 级稳定，保留在 system。

### D2：meta 落点集中为单一 transport seam（评审确认的架构叉子）

**不逐 adapter 改。** 在 transport 层定义唯一四槽拼装 seam：

```ts
assembleTransportPayload({ system, history, meta, userMsg }): TransportPayload
```

- `route-serial` / `route-parallel` 不再内联拼 parts，改为产出四槽、调用该 seam；
- 每个 provider adapter 只负责**四槽 → 自己 CLI 契约的映射**：
  - Claude 系：`system → --append-system-prompt`；`-p` 内容严格按 **history → meta → userMsg** 排列（meta 夹在历史与当前消息之间，不得置于 userMsg 之后）；
  - Kimi / Pi 系：单 blob 内按 `system → history → meta → userMsg` 顺序拼接（blob 顺序即缓存边界）；
  - Codex / Grok / Gemini / OpenCode / Dare / A2A / CatAgent / Antigravity / ACP：各自 transport 按同一四槽映射；
- adapter 内**禁止**各自实现 meta 逻辑——没有这层集中，D4 的跨调用字节对齐无法保证，且 10 个适配器必然漂移漏改。

### D3：meta 永不持久化（不变量，非清理步骤）

meta 块是**当轮易失产物**：每轮由当前状态重新计算，不写入 ThreadStore / 消息存储，不进入 transcript、摘要、thread memory、session seal。压缩链路（**AutoSummarizer / SessionSealer / TranscriptWriter / buildThreadMemory**——v2 更正：v1 误认 prompt-digest 为压缩器，实为 52 行审计 SHA-hash 工具）必须在摄入侧显式排除 meta 块，而非事后清理。

不变量测试：①transcript/seal 产物中不得出现 meta 块标记（`[META]` 头）；②同一 cat 相邻两次组装的 diff 仅存在于 meta 块与当前消息；③摘要/记忆生成的输入快照不含 meta 内容。

### D4：transport 产物（B 层）同步治理

`route-helpers.ts:3256-3264` 真实注入序中的 per-turn 产物同样不能留在"历史段"（落地 targeting 对准 3256 这个 seam，勿用 :3168 裁剪顺序）：

- **evidence（recallEvidence）**：每轮新 hybrid 搜索结果 → 移入 meta 块；
- **coverageMap / threadMemory / anchors**：每轮重算 → 两条路：优先做成**确定性 append-only**（内容仅由已投递消息决定，同状态同字节），做不到的移入 meta 块；
- **tombstone / burst**：burst 是真历史，保留原位；tombstone 若为确定性文本可留，否则入 meta。

这一层的杠杆不小于 Task Gate 迁移——不治理，95% 命中率的账落不了地。

### D5：缓存边界类型约定（cacheClass）

每个 prompt section 声明缓存级别，新加 section 必须归类，CI 强制：

| cacheClass | 语义 | 位置规则 |
|---|---|---|
| `static` | session 内不写的冻结段 | system prompt |
| `volatile` | session 内会写（任何频率） | **禁止进 system**，只进队尾 meta 块 |
| `deterministic` | 仅由已投递消息决定、同状态同字节 | 可留在 history 段（append-only） |

（v2 说明：v1 的 `epoch` 类取消——"低频"不是免死牌，session 内会写就下放。）

### D6：工具定义顺序冻结 + 子调用字节对齐

MCP 工具列表相邻调用间字节稳定（现状：SkillRouter 按字母序 `localeCompare`，已合规），加回归测试防退化。同猫同配置的并发/批量调用复用同一 system 字符串字节，provider 侧缓存可跨调用共享。

## 影响面（v2 补全）

| 模块 | 改动 |
|---|---|
| `SystemPromptBuilder.ts` | 拆分 `buildInvocationContext`：static 保留段 + `buildTurnMetaBlock()`；记忆摘要/lessons/project 四件套/`shouldInjectProjectContext` 移出 `buildStaticIdentity`；section 注册加 cacheClass |
| **transport seam（新增）** | `assembleTransportPayload` 四槽定义与单一落点 |
| `route-serial.ts` / `route-parallel.ts` | 改为产出四槽调 seam；contextUsageWarning 入 meta（消除每轮 2–3 次整段重建） |
| `route-helpers.ts` | evidence/coverageMap/anchors 确定性化或入 meta；导航/Inbox Snapshot 入 meta |
| `context-transport.ts` + `ContextAssembler.ts`（F148 智能窗口） | 配合 D4：窗口驱逐策略保前缀（按块驱逐/anchor 钉住/摘要不原位替换）；token 裁剪不破坏四槽结构 |
| 全部 provider 适配器（Claude/Kimi/Pi/Codex/Grok/Gemini/OpenCode/Dare/A2A/CatAgent/Antigravity/ACP） | 只做四槽 → CLI 契约映射，无各自 meta 逻辑 |
| `AutoSummarizer` / `SessionSealer` / `TranscriptWriter` / `buildThreadMemory` | 摄入侧排除 meta 块（D3 不变量） |
| `prompt-source-breakdown.ts` | 遥测 section 分类同步 |
| 测试 | cacheClass CI、字节稳定性、meta 非持久化不变量、工具顺序、F042/F167/A2A/压缩回归 |

## 落地设计项（带给实现侧，非阻塞）

1. **分槽预算**：现有 graduated-degradation trim 按 evidence+burst 合并预算裁剪；拆四槽后须在落地规格中明确「分槽预算 + 保前缀驱逐」（挂开放问题 #3/#4）。
2. **四槽必须保持结构化边界**：`TransportPayload` 保留 system/history/meta/userMsg 四个独立字段，**禁止预 join 成字符串**——否则"adapter 只做映射"的契约立不住。

## 验证计划

1. **字节稳定性 harness**（CI）：同一 cat 相邻两次组装，`[STATIC SYSTEM]` 与工具定义字节一致；diff 仅出现在 meta 块与当前消息。
2. **缓存命中率实测**：金丝雀猫（kimi）灰度 24–48h，对比 provider usage（Anthropic `cache_read_input_tokens` / Kimi 等价字段）与 TTFT。验收：长会话（>50 轮）cache-read 占比 <20% → >70%。
3. **meta 非持久化不变量测试**：见 D3。
4. **行为回归**：F042 身份防坍缩、A2A 行首路由、乒乓球熔断、压缩接续、bootcamp/guide/world 模式既有测试集。
5. **回滚**：env flag `CONTEXT_CACHE_LAYOUT=v1|v2` 一键切回。

## 风险与开放问题

1. **CLI 内部组装的不可控性**：各 CLI 在注入内容之外还有自己的前缀与缓存断点管理，精确命中边界需实测（验证计划 2）。但「volatile 不进 system」在任何 CLI 行为下弱占优。
2. **meta 块位置 vs 模型注意力**：队尾紧邻当前消息，位置偏好上回忆最好，理论有行为收益；风险是个别猫把 meta 误当用户消息回复，金丝雀期观察。
3. **滑动窗口与缓存前缀的冲突**：`ContextAssembler` 的 `slice(-maxMessages)` 与 token 裁剪是保新弃旧的滑动窗口——窗口前缘每轮前移，D1 落地后长 thread 的 history leading edge 仍会断。需「保前缀驱逐策略」（按块驱逐/anchor 钉住/摘要异地替换），与 D4 合并设计。
4. **deterministic 类的判定边界**：coverageMap/anchors 能否做到同状态同字节，需要逐个核查其输入是否含时间戳/随机排序；做不到的降级入 meta。
5. **预期收益锚点**：Maka v11 提示 harness 差异在同模型下可达 ±10pp 成功率；本 ADR 只主张成本/延迟收益，不主张成功率收益（无消融证据）。

## 不做的事（Non-goals）

- 不改任何规则文本内容（只动位置、组装与持久化语义）；
- 不引入语义压缩 / tool-result prune（独立后续立项）；
- 不调整 contextBudget 数值（kimi 240k→1M 另由铲屎官拍板）；
- 不在本 ADR 内实现逐 adapter 的深度定制（只做四槽映射）。
