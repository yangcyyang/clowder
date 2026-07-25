---
feature_ids: [F102, F163, F186, F152]
topics: [memory, profile, knowledge, session-governance, eval, baseline]
doc_kind: research
created: 2026-07-25
---

# 记忆系统升级批次 1（F-A 评测尺）—— Baseline 数字落档

> 依据：docs/prd/PRD-memory-upgrade.md F-A（评测尺）+ docs/research/memory-absorption.md
> §4 批次 1（"先立评测尺（不改行为，只加度量）"）。
>
> **铁律**：本批次不改任何生产行为，只新增测试/脚本/文档三类文件；
> `AgentMemoryPromotionGate.ts` / `UserProfilePromotionGate.ts` / `AgentMemoryStore.ts`
> 等生产文件一行未改，全部只 import 复用。

## 0. 结论摘要

- **KR1 验收标准（gold set ≥30 条查询）已达成**：三套评测件合计 **44 条**（Knowledge 层 17 条 + notes/ 层 15 条 + USER.md 分类 12 条 —— 三者相加超出 17+15+12=44 的原因见下表按"查询条数"口径，USER.md 12 条按分类用例计入总数同样满足"覆盖记忆召回/画像分类/会话体积"的验收要求）。
- 三项新指标全部首次落档：**notes/ 层召回**（此前"零机制"）、**USER.md 晋级分类准确率**（规则表本身首次跑金测）、**CLI 原生 session 体积 + 唤醒耗时分布**（此前"未证实"的生产事故，本次扫描找到了它对应的真实文件）。
- **意外发现（有实证价值）**：docs/research/memory-absorption.md §3 标注为"未证实"的 25MB 事故 session，本次只读扫描在 `~/.grok/sessions/.../019f5c15-f262-7040-ba3e-82f4524c544b` 找到了完全吻合的真实文件（24.4MB，与 grok 自己 `.cat-cafe/memory/grok.md` 记录的"整包 25MB"一致）——该事故现在是**实测确认**，不再是"未证实"。
- 唤醒耗时抽样也发现了新的、比这个已知事故更大的异常：grok 猫在 Clowder 自己的 worktree 项目下还有一个 **76.4MB** 的 session 目录（比已知事故大 3 倍），以及 pm2 日志里多只猫（gpt52/claude-sonnet5/kimi/grok）都存在数十万毫秒级的唤醒延迟离群值。

---

## 1. 评测件清单（新增两套 + 复用一套）

| 评测件 | 文件 | 条数 | 状态 |
|---|---|---|---|
| Knowledge 层文档检索（F102，复用不动） | `packages/api/test/memory/memory_eval_corpus.yaml` | 17 条查询（15 条 recall + 2 条 precision） | 已有，本次只重跑取数，未修改 |
| notes/ 层召回（新增） | `packages/api/test/memory/notes_recall_gold.yaml` | 15 条 notes + 15 条 query | 新增 |
| USER.md 晋级分类（新增） | `packages/api/test/memory/user_profile_classification_gold.yaml` | 12 条用例 | 新增 |
| **合计** | | **44 条**（17 + 15 + 12） | 超过 KR1 要求的 ≥30 条 |

Runner 测试文件（`node --test` 可直接跑）：

- `packages/api/test/memory/eval-runner.test.js`（已有，未改动）
- `packages/api/test/memory/notes-recall-eval.test.js`（新增）
- `packages/api/test/memory/user-profile-classification-eval.test.js`（新增）

只读测量脚本：

- `packages/api/scripts/memory-session-baseline.mjs`（新增，扫描 CLI 原生 session 体积 + 从 pm2 日志抽样唤醒耗时；零写入副作用，见脚本头注释）

---

## 2. Baseline 数字表

| # | 指标 | 数值 | 日期 | 评测件版本 |
|---|---|---|---|---|
| 1 | Knowledge 层 Recall@5（F102） | **80.0%**（12/15） | 2026-07-25 | `memory_eval_corpus.yaml`（既有，未改动；仓库 HEAD `963dc7ff`） |
| 2 | Knowledge 层 Precision（无 archive/mailbox 污染） | 通过（0 违规） | 2026-07-25 | 同上 |
| 3 | notes/ 层 Recall@5（朴素 topicSimilarity 基线） | **100.0%**（15/15） | 2026-07-25 | `notes_recall_gold.yaml` v1（本次新增） |
| 4 | notes/ 层 meanNDCG@5 | **0.9754** | 2026-07-25 | 同上 |
| 5 | notes/ 层 meanMRR | **0.9667** | 2026-07-25 | 同上 |
| 6 | USER.md 晋级分类准确率（`evaluateMemoryPromotion`） | **100.0%**（12/12） | 2026-07-25 | `user_profile_classification_gold.yaml` v1（本次新增） |
| 7 | CLI session 体积：grok 全量 | 129.5 MB / 34 个 session 单元 | 2026-07-25 | `memory-session-baseline.mjs`（本次新增） |
| 8 | CLI session 体积：grok（Clowder 相关子集） | 85.5 MB / 15 个 session 单元 | 2026-07-25 | 同上 |
| 9 | CLI session 体积：kimi 全量 | 99.0 MB / 145 个 session 单元 | 2026-07-25 | 同上 |
| 10 | CLI session 体积：kimi（Clowder 相关子集） | 465.8 KB / 6 个 session 单元 | 2026-07-25 | 同上 |
| 11 | CLI session 体积：codex 全量 | 3.8 GB / 1715 个 rollout 文件（按日期组织，无法只读归属到具体项目） | 2026-07-25 | 同上 |
| 12 | CLI session 体积：gemini 全量 | 332.4 KB / 6 个 session 文件 | 2026-07-25 | 同上 |
| 13 | CLI session 体积：claude 全量（本机所有项目） | 979.8 MB / 658 个 jsonl 文件 | 2026-07-25 | 同上 |
| 14 | CLI session 体积：claude（Clowder 相关子集） | 108.8 MB / 194 个 jsonl 文件 | 2026-07-25 | 同上 |
| 15 | 唤醒耗时（Created invocation → Session init）：全体猫汇总 | mean 7,549 ms / p50 2,492 ms / p95 7,557 ms / max 2,663,405 ms（n=4,403） | 2026-07-25（抽样窗口：pm2 日志现存全部内容，最早 2026-05-31） | 同上，读取 `~/.pm2/logs/clowder-api-out.log`（429.4 MB） |

**关于第 1 项 vs KR1"评测集 ≥30 条查询"的口径**：memory_eval_corpus.yaml 里 15 条 recall + 2 条 precision 共 17 条查询条目；notes_recall_gold.yaml 15 条查询；user_profile_classification_gold.yaml 12 条用例（性质上等价于"输入→期望判定"的查询）。三者相加 = 44 条，超过验收线。

---

## 3. notes/ 层召回：方法论说明（为什么用 topicSimilarity，不是新算法）

docs/research/memory-absorption.md §0.3 与可抄清单第 2 条已经指出：notes/ 目前是**零机制**状态（`AgentMemoryStore.ts` 只给路径约定，没有索引/排序）。批次 1 的纪律是"不改行为，只加度量"——所以这份评测尺**不能**顺手把 F163 的 `salience()` 公式接进 notes/（那是批次 2/3 F-D 的工作范围），只能用**生产代码里已经存在、且不需要新写算法**的排序器来建立第一个可比较的基线。

选择了 `AgentMemoryPromotionGate.ts` 里已导出的纯函数 `topicSimilarity()`（char-bigram Jaccard 相似度，冲突检测已经在生产环境跑了很久）作为唯一诚实的基线打分器：给定一条任务情境查询，对全部候选 notes 按 `topicSimilarity(query, note.body)` 排序取 top5。

**素材来源**（15 条 notes，均为只读读取，未写入任何生产文件）：

- **real-cat-memory**（13 条）：摘自生产 `.cat-cafe/memory/{catId}.md`（grok / kimi / opus-45 / pi / gpt52 五只猫的"已关闭决策 / 行为偏好 / 环境 gotcha / 最近验证"真实条目，2026-07-25 只读读取）。
- **real-docs-history**（2 条）：摘自仓库 `docs/` 真实历史文档 —— `docs/features/F163-memory-entropy-reduction.md:71`（`invalid_at` 冲突触发而非时间触发）、`docs/decisions/024-kv-cache-friendly-context-layout.md:113`（D1 volatile 内容禁止进 system，只进队尾 meta）。

**这份基线的定位**：批次 2/3 给 notes/ 接 F163 `salience()` 加权排序后，重跑同一份 `notes_recall_gold.yaml` 即可量化提升——`notes-recall-eval.test.js` 里的断言阈值（Recall@5 ≥ 0.9 / NDCG ≥ 0.9 / MRR ≥ 0.9）是**回归下限**，不是目标值；15 条 notes 的规模较小，topicSimilarity 在小语料下天然容易命中，salience 化后的真正价值会在 notes 数量增长、话题重叠增多时才体现出来。

---

## 4. USER.md 晋级分类：方法论说明

`evaluateMemoryPromotion`（`AgentMemoryPromotionGate.ts:453`）是一张**确定性规则表**（7 步判定，first-match-wins），`UserProfilePromotionGate.ts` 对 USER.md 的写入全部复用这张表（恒为 enforce 档）。确定性规则表天然适合金测：同样的输入永远产生同样的输出，不需要真实语料也能做到"高置信度金标签"。

12 条用例覆盖全部 7 个判定分支（含 2 个边界变体）：

| 分支 | 用例 |
|---|---|
| 1. session-temp skip | UPC-01 |
| 2. duplicate skip（对生产内容 / 对候选队列） | UPC-02、UPC-03 |
| 3. closed-decision hold（含"用户 fast-track 仍被 hold"边界） | UPC-04、UPC-05 |
| 4. user-stated fast-track promote（无冲突 / 有 port 冲突两种） | UPC-06、UPC-07 |
| 5. fact/preference 冲突 hold（port / brevity） | UPC-08、UPC-09 |
| 6. low-confidence skip | UPC-10 |
| 7. candidate（默认队列：fact / preference） | UPC-11、UPC-12 |

结果：**12/12 全部吻合，准确率 100%**。这是规则表本身首次有金测覆盖——此前只有零散的单元测试（`test/agent-memory-promotion-gate.test.js` 的 C-S/C-P 系列）验证过个别分支，没有汇总成"分类准确率"这个可回放的数字。批次 2 拆分 hold 分支为 `hold-mergeable`/`hold-supersede` 时，这 12 条用例（尤其是 UPC-04/05/08/09 四条 hold 用例）就是判断"拆分后行为有没有跑偏"的现成回归集。

---

## 5. Session 体积与唤醒耗时基线（只读扫描，2026-07-25）

### 5.1 扫描范围与方法

`packages/api/scripts/memory-session-baseline.mjs` 是一个纯只读脚本（不删除、不移动、不轮转任何文件，唯一输出是打印到 stdout 的 JSON + stderr 的人类可读摘要）。调研确认的各 provider 原生 session 真实路径：

| Provider | 真实路径 | 组织方式 |
|---|---|---|
| Codex | `${CODEX_HOME:-~/.codex}/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl` | 按**日期**组织，不按项目——只读扫描无法只凭路径把一个 rollout 文件归属到具体项目，需要读内容（cwd 字段）才能精确归属 |
| Grok | `${GROK_HOME:-~/.grok}/sessions/<url-encoded-cwd>/<sessionId>/*` | 按项目（cwd）分桶，一个 session = 一个目录（`updates.jsonl`/`events.jsonl`/`chat_history.jsonl`/... 组成） |
| Kimi | `${KIMI_CODE_HOME:-~/.kimi-code}/sessions/wd_<slug>_<hash>/ses_*/`（CLI 已从 `~/.kimi` 迁移到 `~/.kimi-code`，见 `packages/api/src/utils/local-cli-model-probes.ts:287-292`） | 按项目分桶，一个 session = 一个目录 |
| Gemini | `~/.gemini/tmp/<projectDirName>/chats/session-*.json(l)` | 按项目（`basename(cwd)`）分桶，一个 session = 一个文件 |
| Claude | `~/.claude/projects/<url-encoded-cwd>/*.jsonl` | 按项目分桶，一个 session = 一个文件；**Claude CLI 本身不区分 Clowder 内部 catId**，同一项目目录下会混有多只 Claude 系猫（opus/opus-45/gpt52/claude-sonnet5/...）的会话 |

"Clowder 相关子集"是按路径/项目名包含 `clowder`/`cat-cafe` 关键字的弱匹配，仅供参考（尤其 Codex 按日期组织，完全无法这样过滤，其 clowder 子集统计已在脚本里标注为"弱匹配仅供参考"，本文档不采用）。

### 5.2 体积分布关键发现

| Provider | 全量 | Clowder 相关子集 | Top 单元（体积最大） |
|---|---|---|---|
| Codex | 3.8 GB / 1715 文件 | 无法归属（按日期组织） | 478.8 MB（`2026/04/03/rollout-...019d5372...jsonl`）——单文件接近半 GB，但不确定是否 Clowder 猫产生 |
| **Grok** | 129.5 MB / 34 个 session | **85.5 MB / 15 个 session** | **76.4 MB**（`clowder-ai-slock-like-webui/packages/api` worktree 下的 session `019f5b79-...`）—— 比下面确认的"25MB 事故"还大 3 倍，且目前仍在（mtime 较新），需要人工确认是否也已经/即将撑爆 |
| Kimi | 99.0 MB / 145 个 session | 465.8 KB / 6 个 session | 18.0 MB（`wd_ai-design_...`，与 Clowder 无关——kimi 在 Clowder repo 里用得很轻） |
| Gemini | 332.4 KB / 6 个文件 | 1.1 KB / 1 个文件 | 134.6 KB（体量极小，gemini 猫在本机用得很少） |
| Claude | 979.8 MB / 658 文件（本机全部项目） | 108.8 MB / 194 文件 | 29.3 MB（Clowder 子集内最大，`clowder-ai-slock-like-webui/packages/api` 项目下） |

**重点发现（实证价值）**：docs/research/memory-absorption.md §3 把"grok 猫 CLI 原生 session 涨到 25MB，唤醒即卡死，推特日报连断多场"标注为**"未证实"**（任务描述转述，当时未在仓库内找到直接文件/日志证据）。本次只读扫描在

```
~/.grok/sessions/%2FUsers%2Fcy%2FDocuments%2F03%20life%2FAI%20design%2F产品项目%2F自动化工作流/019f5c15-f262-7040-ba3e-82f4524c544b
```

找到了体积 **24.4 MB**（`du -sh` 实测 25M）的真实目录，内含 `updates.jsonl`（16.45 MB）+ `events.jsonl`（2.2 MB）+ `chat_history.jsonl`（724 KB）等文件，最后修改时间 2026-07-23 00:01——与 `.cat-cafe/memory/grok.md` 里 grok 自己记录的"故障 session ... 整包 25MB"、"最后成功产出 2026-07-22 中午"完全吻合。**这个事故现在是实测确认，不再是"未证实"。**

同时发现一个**更大的、此前完全没被提及的**风险点：Clowder 自己 `packages/api` worktree 目录下的 grok session `019f5b79-...` 已经涨到 **76.4 MB**，比确认的事故还大 3 倍，且 mtime 较新（活跃状态）。这条应该作为批次 3 F-G（CLI 会话轮转）阈值调参的第一个真实样本——如果轮转阈值设成"超过 25MB 强制轮转"，这个 session 早就该触发了。

### 5.3 唤醒耗时分布关键发现

从 Clowder 自己的 pm2 结构化日志（`~/.pm2/logs/clowder-api-out.log`，429.4 MB，只读抽样，未清理未轮转）里，用 `invoke-single-cat.ts` 已经在打的两条 pino 日志（`Created invocation` → `Session init: binding session`）配对，共配出 **4,403 对**样本（从 4,543 条 Created / 4,506 条 Session-init 日志行里）：

| 猫 | mean | p50 | p95 | max | 样本数 |
|---|---|---|---|---|---|
| 全体汇总 | 7,549 ms | 2,492 ms | 7,557 ms | **2,663,405 ms**（≈44.4 分钟） | 4,403 |
| gpt52 | 9,896 ms | 4,322 ms | 9,630 ms | 2,498,051 ms（≈41.6 分钟） | 998 |
| claude-sonnet5 | 17,406 ms | 3,136 ms | 7,375 ms | 2,663,405 ms（≈44.4 分钟） | 313 |
| kimi | 19,825 ms | 80 ms | 79,063 ms | 1,029,791 ms（≈17.2 分钟） | 359 |
| grok | 15,589 ms | 128 ms | 31,963 ms | 533,624 ms（≈8.9 分钟） | 90 |
| opus-45 | 4,100 ms | 2,728 ms | 5,076 ms | 462,417 ms | 1,822 |
| pi | 1,583 ms | 40 ms | 698 ms | 434,415 ms | 613 |

**解读**：p50（中位数）普遍在几十到几千毫秒，属于正常冷启动范围；但每只猫的 max 都存在数十万毫秒级（数分钟到 44 分钟）的离群值，且 mean 被这些离群值大幅拉高（mean 远高于 p50），说明"偶发严重卡顿"是跨猫的普遍现象，不只是 grok 一只猫的问题。这与 PRD 里"荧荧（grok）连断 6 场"的具体事故一致，但抽样显示 gpt52 / claude-sonnet5 / kimi 也有类似量级的尾部延迟，**批次 3 F-G 的会话轮转不应该只灰度 grok 一只猫，其余几只猫的原生 session 也值得纳入同一批观察**。

**方法论说明**：这里的"唤醒耗时"指标口径是"invocation 创建"到"CLI 子进程成功绑定 session"之间的时间差——正是 25MB 事故里"启动就卡死"发生的那个区间，不是完整回复耗时（完整耗时目前只通过 SSE 推给前端，没有落一条可 grep 的 pino 日志，本次未纳入）。样本仅统计"两条日志在同一份日志文件里都能配对上"的 invocation；部分更早的 Created 记录可能因为日志文件保留窗口而配不上 Session-init，属于抽样口径限制，不影响相对比较。

---

## 6. 测试证据（全绿）

```
$ pnpm run build   # tsc 干净，无错误（本批次只加 test/*.test.js + *.yaml + scripts/*.mjs，均不在 tsconfig include=src/**/* 范围内，对 tsc 零影响）

$ bash ./scripts/with-test-home.sh node --import "$(pwd)/test/helpers/setup-cat-registry.js" --test \
    test/memory/notes-recall-eval.test.js \
    test/memory/user-profile-classification-eval.test.js
# tests 10, suites 4, pass 10, fail 0

$ bash ./scripts/with-test-home.sh node --import "$(pwd)/test/helpers/setup-cat-registry.js" --test \
    test/memory/eval-runner.test.js \
    test/adr-024-context-cache-layout.test.js
# tests 21, suites 7, pass 21, fail 0   (含 golden ADR-024 缓存布局测试，绿)
```

---

## 7. 风险与限制（范围内记录，范围外交给对应批次）

- **notes/ 基线用的是朴素相似度，不是未来的 salience 排序**——15 条 notes 规模小，topicSimilarity 天然容易命中满分；批次 2/3 换成 F163 `salience()` 加权后需要在 notes 数量增长、话题重叠更多的情况下重新评估，当前 100% Recall@5 不代表"notes/ 召回已经很好"，只代表"零机制状态下用现成相似度函数能建立的基线"。
- **Codex session 无法按项目归属**——只读扫描拿不到"这个 rollout 是不是 Clowder 猫产生的"，3.8GB / 1715 文件的全量数字里可能混有大量与 Clowder 无关的日常 codex CLI 使用。批次 3 若要给 Codex 也做体积轮转，需要先解决"按内容识别项目归属"这个前置问题（读 rollout 文件内的 cwd/cd 字段），本次不展开。
- **Claude session 无法按 Clowder 内部 catId 归属**——同一项目目录下混有多只 Claude 系猫的会话，只能做到"项目级"而非"猫级"的体积归因。
- **唤醒耗时抽样受日志保留窗口限制**——只统计同一份现存日志文件里能配对上的 invocation（4,403/4,543 ≈ 96.9% 配对成功率），早于日志保留窗口的 Created 记录配不上 Session-init，不代表这些 invocation 真的没有初始化成功。
- **grok 在 Clowder packages/api worktree 下的 76.4MB session 是本次新发现、尚未有人审查的风险点**——不在本次任务范围内处理（批次 1 只加度量不改行为），已在 §5.2 标注给批次 3 F-G 作为第一个真实样本，建议尽快人工确认这个 session 是否也已经出现卡顿症状。
- **本次三份新评测件与脚本均未提交 git**——按任务纪律"范围内不 commit"，留给铲屎官/主协调决定何时合并。

---

*产出物清单*：
- `packages/api/test/memory/notes_recall_gold.yaml`（notes/ 召回 gold set）
- `packages/api/test/memory/notes-recall-eval.test.js`（runner）
- `packages/api/test/memory/user_profile_classification_gold.yaml`（USER.md 分类 gold set）
- `packages/api/test/memory/user-profile-classification-eval.test.js`（runner）
- `packages/api/scripts/memory-session-baseline.mjs`（只读体积 + 唤醒耗时扫描脚本）
- 本文档
