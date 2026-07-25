---
feature_ids: [F102, F163, F186, F152]
topics: [memory, profile, knowledge, runtime-state, architecture-absorption, mem0, memobase, zep, letta, kv-cache]
doc_kind: research
created: 2026-07-25
---

# Agent Memory 四层模型 × Clowder 吸收清单

> 来源：铲屎官调研框架 `~/Downloads/Agent-Memory-架构调研.md`（四层模型：Profile/Memory/Knowledge/Runtime State）+ 对 Clowder 仓库（`~/.slock/worktrees/clowder-ai-slock-like-webui`）四层现状的只读核实 + Mem0/Memobase/Zep/Letta/User-as-Code 的公开文档与论文调研。打法同 `docs/research/maka-absorption.md`：拆别人的成熟件 → 映射到 Clowder 升级路线，全部结论附 file:line。
>
> **纪律**：下文每条标注来源类型——「实测」= 本次读代码/查文件核实；「文档来源」= 外部公开文档/论文转述（非逐字引用，见各处 URL）；「推断」= 无直接证据、基于架构判断。

## 0. 先说三处推翻/修正任务预设的发现

1. **"Memory 层"语义错位**：四层模型的 Memory = "用户经历了什么"（Mem0 语境下是**关于用户**的事实/偏好/事件）。但 Clowder 现有 `.cat-cafe/memory/{catId}.md` 记的是**猫自己的操作状态**（当前状态/已关闭决策/环境 gotcha），更接近 Letta 的 Core/Recall Memory（agent 自身工作记忆），只有其中 `feedback`/`user` 两类 frontmatter 才对应 Mem0 意义上的"用户记忆"。真正对应"用户经历"的其实是 **USER.md（Profile 层）+ 四分类里的 user/feedback 条目**。四层图不能照搬，Clowder 的 Memory 层要拆成"猫自身经验"和"关于用户的事实"两个子域分别对标。
2. **Zep 失效时间戳不是要"新引入"，是要"扩展"**：F163（`docs/features/F163-memory-entropy-reduction.md:63-78`，Status: done）已经给 docs/知识载体（LL/ADR/feedback/shared-rules）造了 `invalid_at` + `replaced_by` + `contradicts[]` 冲突图谱，且比 Zep 更谨慎——**冲突触发而非时间触发**（"时间是陪审员不是法官"，同文件:171）。真正的差距不是"没有这个机制"，而是这个机制**没有覆盖到 Memory 层（notes/ 四分类 frontmatter）和 Profile 层（USER.md）**。
3. **"检索打分"任务预设有误**：调研发现 Mem0 论文和文档**都没有公开相关性/新近性/重要性的显式加权公式**——它的检索是"向量 top-s + LLM 推理决定 ADD/UPDATE/DELETE/NOOP"，打分逻辑在 LLM 头脑里，不是可抄的公式。反而 Clowder 自己的 F163 已经写了一个可抄的显式加权函数：`salience()`（`packages/api/src/domains/memory/f163-types.ts:88-126`，activeFeature 命中 +0.4/truthSourceRef 命中 +0.25/近期产物命中 +0.15/authority 加成 +0.05），只是目前只用于 Knowledge 层检索排序，没用到 notes/ 召回。可抄清单第 2 条已按这个更准确的起点重写。

---

## 1. 四层模型 × Clowder 现状映射表

| 层 | Clowder 现状（file:line，实测） | 别人的成熟件 | 差距 |
|---|---|---|---|
| **Profile**（用户是谁） | `UserProfileStore.ts:20-25` 固定三节（偏好/硬约束/账号级事实）自由文本，全猫共享只读注入；`SystemPromptBuilder.ts:742-760` v2 meta 槽注入，预算 ≤1k tokens；写入走 `UserProfilePromotionGate.ts:1-25` **恒为 enforce 档**（无 env 可绕过），候选队列 `.cat-cafe/memory/candidates/USER.jsonl`（`AgentMemoryPromotionGate.ts:265-272` 复用），`UserProfileWriteQueue.ts:8-26` 单写者 FIFO 串行化。**实测确认候选队列无审阅 UI/路由**（`packages/web/src`、`packages/api/src/routes` 均无 `listUserProfileCandidates` 调用点）。 | Memobase：固定 Schema（`basic_info/interest/career` 等 topic/sub_topic 树，`docs.memobase.io/features/profile/profile`，文档来源），有 SDK/API 直接查询字段。 | 三节是自由文本 bullet list，无字段级 schema，查询只能整段读；人审队列有数据无界面，候选永远堆积。 |
| **Memory — 猫自身经验**（Letta 语境的 Core/Recall） | `AgentMemoryStore.ts:6-20` 两层化：索引层 `.cat-cafe/memory/{catId}.md`（全文注入 v2 meta 槽，预算 4000 tokens = `AGENT_MEMORY_INDEX_MAX_TOKENS`，`SystemPromptBuilder.ts:712-713`）+ notes 层 `.cat-cafe/memory/notes/{catId}/`（按需读取，无专门读取机制，`AgentMemoryStore.ts:46-54`）。`AgentMemoryAutoWriter.ts:239-328` 每次 invocation 完成后自动回写，`MEMORY_AUTO_WRITE_MIN_INTERVAL_MS=60_000`（:16）限流。 | Letta：Core（system prompt 内可编辑块）/ Recall（会话历史检索）/ Archival（长期库），agent 通过 `memory_insert/memory_replace/memory_rethink/memory_finish_edits` 等工具**自己**编辑（文档来源，vectorize.io/sureprompts.com 转述）。 | Clowder 是"系统在猫说完话后自动回写"，猫没有显式记忆写入工具；notes/ 层召回**零排序**（无 salience/向量 rerank，全靠猫自己记得文件名去读）。 |
| **Memory — 关于用户的事实**（Mem0 语境） | 落在 `AgentMemoryPromotionGate.ts:138-145` 四分类 frontmatter 的 `user`/`feedback` 类型，和/或落在 USER.md（见 Profile 行）；`evaluateMemoryPromotion`（:453-548）是一个确定性正则规则表：session-temp→skip、去重→skip、closed-decision 冲突→hold、user-stated→promote(fast-track)、port/brevity 冲突→hold、低置信度→skip、否则→candidate。**没有 UPDATE 动作**——冲突只会 hold 给人审，从不自动合并/覆盖；也**没有 DELETE 动作**——旧记忆从不会因新事实自动失效。 | Mem0：ADD/UPDATE/DELETE/NOOP 四动作，LLM 判定"新事实与旧记忆重叠但表述不同→UPDATE 合并同 ID"、"新事实与旧记忆矛盾→DELETE"（文档来源，`docs.mem0.ai` + `github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py`）。 | Clowder 的四动作是"promote/candidate/hold/skip"——服务的是**审核流程状态**（要不要人看），Mem0 的四动作服务的是**记忆内容本身怎么变**（合并/覆盖）。两者维度不同，Clowder 缺的是后者：conflict 之后除了 hold 给人，没有语义合并/退休路径。 |
| **Knowledge**（AI 知道什么） | F102 项目内证据库（`evidence.sqlite`，FTS+可选向量）→ F186 多域联邦（`docs/features/F186-library-memory-architecture.md`，`Collection = truth_source+owner+scanner+authority_ceiling+review_policy+index_policy`）→ `KnowledgeResolver.ts:37-53` 按 `dimension` 路由（project/global/library/collection），`rrfFusion`/`rrfFusionN`（:151-207，RRF k=60）做多路融合；`SemanticReranker.ts:6-30` 用预算好的向量距离对 FTS 候选重排（不替代词法召回，只重排）；F163 `salience()`（见上）做 authority×activation×status 三轴加权。铲屎官 Obsidian 知识库（400知识库，10,158 篇）**已挂载为只读证据集**（`obsidian-readonly-collections.ts:11-59` 解析 `OBSIDIAN_READONLY_ROOTS` env，`indexPolicy.autoRebuild=false` 硬编码于:49；`factory.ts:~204-210` 注册进 catalog+`SqliteEvidenceStore`）。**主会话实测 2026-07-25**：`evidence_docs` 9,921 条、FTS 可用（"记忆"检索命中真实文档）、猫侧入口 `cat_cafe_search_evidence`（`packages/mcp-server/src/tools/evidence-tools.ts:235`）。刚发现的缺口：`autoRebuild=false` 且无定时任务补齐，索引停在 7-14 导致 1,166 篇（11%）过期，已手动 rebuild（indexed 1332/skipped 8821）；`embedding_meta`/`VectorStore`（`schema.ts:103`、`VectorStore.ts:33-62`）基础设施存在但**未确认此 collection 是否启用语义检索**；237 篇（9,921/10,158 缺口）未进索引，原因未查；重建时秘密扫描命中 vault 内 API key 残留（quarantine 机制生效中）。 | Zep：时间感知知识图谱，每条 fact 带 `valid_at/invalid_at`，冲突时闭合旧边开新边而非覆盖（文档来源，`getzep.com/ai-agents/temporal-knowledge-graph`）；Memobase：Schema 化 profile + event 时间线。 | Clowder 在"多源联邦+权威分级+RRF融合"这条线上已经比 Mem0/Memobase 单机版更成熟（F186 的联邦抽象、F163 的三轴元数据），真正的差距不是缺机制，是**新挂的 Obsidian 域缺运维闭环**（自动重建、语义检索确认、内容质量巡检）——这是运维债，不是架构债。 |
| **Runtime State**（当前在做什么） | `SystemPromptBuilder.ts:1321-1355` `buildAgentStatusBarLines`：时间/模式/上下文水位/任务门/收件箱五要素，`[Agent Status]` 渲染在 `buildTurnMetaBlock`（:1366-1381）最前，ADR-024 v2 meta 槽首位。 | 四层模型原图把 Status Bar 列为独立第四层（"AI 仪表盘"）。 | 四层里**这层最成熟**，唯一的缺口是预算行占位未接（`SystemPromptBuilder.ts:1351-1352` 注释：等 cache-read 遥测接入后再渲染），非本次调研重点。 |

---

## 2. 可抄清单（按优先级）

| 序 | 抄什么 | 落到 Clowder 哪里 | 成本 | 风险 |
|---|---|---|---|---|
| 1 | **Mem0 ADD/UPDATE/DELETE/NOOP 的"内容级"合并语义**——不是抄提示词原文（未公开逐字版本，`mem0/configs/prompts.py` 现存 `FACT_RETRIEVAL_PROMPT`/`DEFAULT_UPDATE_MEMORY_PROMPT`/`USER_MEMORY_EXTRACTION`/`AGENT_MEMORY_EXTRACTION` 等多版本，794 行，文档来源转述），是抄"重叠信息→同 ID 合并成更丰富记忆"和"矛盾信息→标记旧记忆失效"这两个动作类型 | 给 `AgentMemoryPromotionGate.ts` 的 hold 分支加两个子动作：`hold-mergeable`（topicSimilarity 高但不矛盾→建议合并文案，人审时一键接受）、`hold-supersede`（矛盾→建议给旧行设 `invalid_at`，见第 4 条 schema）。`evaluateMemoryPromotion`（:453-548）7 步判定表不动，只在 hold 分支细分 | 3-4 天（复用现有正则冲突检测器 `findClosedDecisionConflict`/`findPortConflict`/`findBrevityConflict`:385-427，只加输出分支，不换算法） | 合并算法目前是字符串相似度（Jaccard bigram, `topicSimilarity:340-349`），语义层面的"表述不同但说的是一件事"识别弱于 Mem0 的 LLM 判定；先 shadow 模式观察合并建议准确率，不要一步到 enforce |
| 2 | **F163 `salience()` 加权公式，扩展到 notes/ 召回**（不是抄 Mem0——其检索打分未公开公式，见 §0.3） | notes/ 目前"零机制"（`AgentMemoryStore.ts:46-54` 只给路径约定，猫用文件读取工具自己翻）。给 notes/ 文件补 frontmatter（复用 `MemoryFrontmatter` 类型 `AgentMemoryPromotionGate.ts:140-145`）+ 轻量索引（文件名/frontmatter type/最后验证时间），套 `salience()` 同款加权：当前任务 feature_id 命中、最近产物命中、最近验证时间新近性 | 4-5 天（新增一个 notes 索引器 + 复用 salience 公式，不新建检索引擎） | notes/ 数量目前小（每猫几个文件），过度设计的风险高于收益——先只加"最近验证时间"排序，命中判断和向量化先不做 |
| 3 | **Memobase topic/sub_topic 可扩展 slot schema** → USER.md 结构化 + 候选队列 UI 的数据结构基础（Memobase 配置里 `additional_user_profiles` 允许加自定义 topic+sub_topic，如 `topic: "Gaming", sub_topics: ["FPS","LOL"]`，`docs.memobase.io` 文档来源转述） | `UserProfileStore.ts` 的三个固定 section（`USER_PROFILE_SECTIONS:25`）升级为"三个固定顶层 topic + 每个 topic 下可扩展 sub_topic 数组"，`classifyUserProfileSection`（:125-129）正则升级为按 sub_topic 关键词分类；同时给 `listUserProfileCandidates`（`UserProfilePromotionGate.ts:141-145`）补一个人审路由+简单列表 UI（当前完全没有，实测确认） | Schema 迁移 2-3 天 + 候选队列 UI（读列表+批准/驳回两个动作）2-3 天 = 5-6 天 | 现有 USER.md 存量数据是自由文本 bullet，迁移到 sub_topic 需要一次性分类跑批，误分类需要人工复核一遍；候选队列 UI 是全新前端面，需要占前端 sprint 排期 |
| 4 | **F163 的 `invalid_at`/`replaced_by`/`contradicts[]` schema，扩展到 Memory 层和 Profile 层**（不是抄 Zep——F163 已经是自研的、比 Zep 更保守的同款机制，见 §0.2） | 给 notes/ frontmatter（`MemoryFrontmatter`，`AgentMemoryPromotionGate.ts:140-145`）和 USER.md 的 bullet 行加同款字段：`valid_from`/`invalid_at`/`superseded_by`；`findClosedDecisionConflict`/`findPortConflict`（:385-414）检测到冲突时，除了 hold，顺带把旧行标记 `invalid_at`（走人审确认，不自动生效，遵循 F163 "冲突触发不是自动触发"的纪律） | 2-3 天（复用 F163 已验证的字段设计，只是接线到 memory/profile 两处 parser，不用重新设计 schema） | 需要保证与 F163 现有 `f163-contradiction-detector.ts` 不产生两套平行冲突检测逻辑——落地前应先读一遍该文件确认复用还是分叉（本次调研未展开读取，留给实现前置调研） |
| 5 | **Letta 的 self-editing 工具调用模式**（`memory_insert`/`memory_replace`/`memory_rethink` 等，文档来源转述） | 新增一个 MCP 工具（如 `cat_cafe_write_memory`），包一层 `evaluateMemoryPromotion` + 四分类 frontmatter 分类，让猫在对话中**主动**调用而不是只靠 `AgentMemoryAutoWriter.ts` 事后自动回写；工具内部仍强制走 promotion gate，不允许绕过 off/shadow/enforce 档位 | 3-4 天（工具 schema 设计 + gate 接线，复用现有 `proposeUserProfileWrite` 模式 `UserProfilePromotionGate.ts:84-138` 作为参考实现） | 最大风险是"给了工具但没收紧 gate"——必须保证新工具与 auto-writer 共享同一个 `evaluateMemoryPromotion` 决策逻辑，否则出现两条路径两套标准，之前 P1-4 治理的"自动回写零审核"问题会从工具入口复活 |

---

## 3. Session 撑爆治理专节

**背景**（任务描述转述，本地未找到直接文件/日志证据，标记「未证实」）：grok 猫的 CLI 原生 session 文件积累至 25MB，唤醒时加载全历史导致 1 小时超时。**实测确认的相关结构性事实**：

- Clowder **自己的** ThreadStore/session 有成熟节流机制：`SessionSealer.ts` 状态机（active→sealing→sealed）+ `SUMMARY_CONFIG`（`packages/api/src/domains/memory/summary-config.ts:6-27`：`pendingMessageThreshold=20`、`pendingTokenThreshold=1500`、`cooldownHours=2`、`schedulerIntervalMs=30分钟`）自动做 L1 摘要压缩；`buildThreadMemory.ts:66-69` 对 decisions/openQuestions/artifacts/ledger 各有硬 cap（8/5/8/20 条）。
- 但这套机制治理的是 **Clowder 的 ThreadStore**，不是 **CLI provider 自己的原生 session 文件**（grok/codex/gemini 等 adapter 各自维护的 `--continue`/`--resume` 历史）。本次调研未在仓库内找到针对 CLI 原生 session 文件体积的上限/轮转机制（`CliRawArchive.ts` 只是按天分文件归档原始 payload，供审计用，不参与唤醒时的历史加载）。**这是一个实测确认的真实缺口**，不依赖那条未证实的具体事故复述也成立。

**治理方案**（须兼容 ADR-024 布局，`docs/decisions/024-kv-cache-friendly-context-layout.md`）：

1. **加一道 CLI 原生 session 体积/轮次上限**（新增，仿 `SUMMARY_CONFIG` 的阈值风格）：每个 provider adapter 的原生 session 文件超过 N MB 或 N 轮，触发强制轮转（类比 Mem0"提炼入库，按需检索"：不是留着全历史等下次爆炸，是**摘要沉淀 + 轻量续接**）。
2. **轮转前必须先跑一次 `autoUpdateAgentMemory`**（`AgentMemoryAutoWriter.ts:239`）distillation pass，把本 session 的关键状态压进 `.cat-cafe/memory/{catId}.md` 索引层（4k token 预算内）+ 专题细节下沉 notes/，而不是让 CLI provider 自己的 `--continue` 机制把整份原始记录焊死在下一次唤醒的 prompt 里。
3. **新 session 启动时只注入索引层摘要，不重放原始 CLI 历史**——这正是两层记忆的设计初衷（`AgentMemoryStore.ts:6-20` 的注释已经写明"存量迁移：现有单文件记忆自动视为索引"），只是目前这个设计只覆盖 Clowder 自己回写的 `.cat-cafe/memory/{catId}.md`，没有覆盖 CLI provider 原生 session 的轮转触发点——**需要把"体积上限触发轮转"这一根线接到已有的两层记忆机制上，而不是另起一套**。
4. **ADR-024 兼容性检查**：轮转事件本身（"检测到超限→即将新开 session"）是每轮易变的判定产物，必须走 D1 分类为 `volatile`，只能出现在队尾 meta 块（`buildTurnMetaBlock`），不能进 system 静态前缀；轮转后写入的记忆摘要走 `buildAgentMemoryIndexLines`（`SystemPromptBuilder.ts:720-735`）已有的 v2 索引全文注入路径，不需要新建注入通道，符合 D3"meta 永不持久化，但记忆摘要在 meta 之外单独走已有的两层索引注入"的既定分工。

---

## 4. 升级路线（分批）

### 批次 1：先立评测尺（不改行为，只加度量）

Clowder 已有两个可直接扩展的评测基础设施，不必照抄 LOCOMO 从零建：
- F102 的 `memory_eval_corpus.yaml`（`packages/api/test/memory/memory_eval_corpus.yaml`）：Recall@5 gold set，目前只覆盖 Knowledge 层文档检索。
- F163 的 `f163-eval-utils.ts`（NDCG@k/MRR 计算 + gold set runner），目前也只服务 Knowledge 层的 `search_evidence`。

**批次 1 项目**：
1. 扩展 gold set 覆盖 notes/ 召回（清单第 2 条依赖此）和 USER.md 候选队列准确率（清单第 3 条依赖此）——用真实猫历史对话回放（类比 LOCOMO 的"长对话+多跳/时间推理/开放域问题"分类，但用 Clowder 自己的 thread 历史，不需要造假数据）。
2. 给 Session 撑爆治理（§3）加一个可观测指标：CLI 原生 session 文件体积分布 + 唤醒耗时分布，作为后续轮转阈值调参的基线。
3. **依赖**：无。**验收标准**：gold set ≥30 条 query（覆盖 notes/ 召回、USER.md 分类准确率、CLI session 体积/耗时基线），baseline 数字记录在案。

### 批次 2：Memory 层冲突消解升级（清单 1、4）

1. `evaluateMemoryPromotion` hold 分支拆出 `hold-mergeable`/`hold-supersede` 子状态（清单 1）。
2. notes/ frontmatter + USER.md bullet 加 `valid_from`/`invalid_at`/`superseded_by` 字段，接线到现有冲突检测器（清单 4）。
3. **依赖**：批次 1 的 gold set（用于衡量合并/失效建议的准确率，避免 shadow 模式空转无度量）。**验收标准**：shadow 模式跑 1-2 周，合并/失效建议的人工采纳率 ≥ 某阈值（用批次 1 gold set 现场定阈值）才能进 enforce。

### 批次 3：Profile 层结构化 + Session 撑爆治理落地（清单 3、5，§3 方案）

1. USER.md topic/sub_topic schema 迁移 + 候选队列审阅 UI（清单 3）。
2. `cat_cafe_write_memory` self-editing 工具（清单 5），复用批次 2 已经升级过的 gate 逻辑。
3. CLI 原生 session 体积上限 + 强制轮转 + 轮转前 distillation pass（§3）。
4. **依赖**：批次 2（工具和 UI 都要接到升级后的 gate，不是旧的四动作）。**验收标准**：候选队列 UI 可用 + 一次真实存量 USER.md 迁移无数据丢失；CLI session 轮转在金丝雀猫（如 grok）灰度验证唤醒耗时回归到分钟级。

### 批次 0（并行，不占前三批排期）：Knowledge 层运维债

不算"吸收"，是主会话实测发现的既有系统运维缺口，可独立排期：Obsidian collection 接定时 rebuild scheduler、确认/补齐语义检索是否对该 collection 启用、排查 237 篇未索引原因。与批次 1-3 无依赖，谁有空谁先做。

---

## 5. 明确不建议做的

- **不整库引入 Mem0 或 Memobase**：两者都是"单机记忆 SaaS/库"，核心价值（自动抽取+冲突消解、固定 schema 画像）Clowder 已经用自己的四分类 frontmatter/promotion gate/F163 元数据体系实现了同等或更谨慎的版本（尤其是 gate 的 off/shadow/enforce 灰度纪律，比 Mem0 直接 LLM 判定后自动写入更保守）。引入整库等于并行维护第二套记忆语义，且两者都不原生支持 ADR-024 的 KV-cache 布局约束（Mem0/Memobase 都假设"记忆是每次请求前置拼进 prompt"，没有"volatile 内容必须下沉队尾"这个概念），接入成本 > 收益。
- **Engram（"用户记忆写入模型附近专用记忆区域"）现阶段不碰**：这依赖模型层面的参数化记忆机制（类似给每个用户训一小块可插拔的记忆权重），Clowder 是多 CLI provider 编排架构（Claude/Kimi/Grok/Codex/Gemini 等各自闭源模型），完全没有能力也没有必要在模型参数层面做记忆注入——这条路线的前提（自己训练/微调基座模型）与 Clowder 的架构假设直接矛盾。
- **多模态参数记忆（视觉 embedding 记忆库）现阶段不碰**：Clowder 当前的记忆载体全部是文本（markdown frontmatter），产品形态里没有"需要区分两个长相相似的人"这类视觉记忆场景；引入视觉 embedding 记忆库是为了解决一个 Clowder 不存在的问题。
- **LOCOMO 原版评测协议照搬**（10 段对话、35 session、约 200 QA/段，五分类问题）：原版是为评估**通用长对话 QA 能力**设计的学术基准，Clowder 的记忆系统服务的是"猫的操作连续性"而非"回答关于用户的问题"，直接照搬协议和数据规模不匹配我们的使用场景；批次 1 里"用真实猫历史对话回放"是借鉴其方法论（分类问题类型、长对话切片评估）而非照搬协议本身。

---

## 附：外部调研来源（均为文档来源转述，非逐字引用）

- Mem0 四动作/graph memory：`docs.mem0.ai/open-source/features/custom-update-memory-prompt`、`github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py`、`docs.mem0.ai/platform/features/graph-memory`
- Mem0 论文（LOCOMO 数字、token 效率）：`arxiv.org/html/2504.19413v1`——注意 Zep 对该论文的 LOCOMO 评测方法论提出过公开质疑（`github.com/getzep/zep-papers/issues/5`：Zep 声称的 84% 经二次评测应为 58.44%），基准数字本身存在争议，不作为唯一可信来源。
- Memobase：`github.com/memodb-io/memobase`、`docs.memobase.io/features/profile/profile`
- Zep 时间感知知识图谱：`getzep.com/ai-agents/temporal-knowledge-graph`、`help.getzep.com/graph-overview`
- Letta/MemGPT：`vectorize.io/articles/mem0-vs-letta`、`sureprompts.com/blog/letta-memgpt-walkthrough`
- User as Code：`arxiv.org/html/2606.16707v1`
- LoCoMo 原始基准：`huggingface.co/papers/2402.17753`（Maharana et al.）
- LangMem（简要参考，未展开吸收）：`langchain-ai.github.io/langmem`（hot-path 工具 vs 后台 cron 巩固两种模式）
