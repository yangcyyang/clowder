---
feature_ids: [F042, F129, F148, F167]
topics: [kv-cache, context-engineering, transport, implementation-plan]
doc_kind: plan
created: 2026-07-24
---

# ADR-024 实施计划：KV-Cache 友好上下文布局

> 依据：docs/decisions/024-kv-cache-friendly-context-layout.md（v2.1 accepted）。本计划只做拆解与排期，不改设计；所有 D1-D6 条款语义以 ADR 原文为准。
> 总原则：**flag 门控（`CONTEXT_CACHE_LAYOUT=v1|v2`，默认 v1=零行为变化）+ 先测量后改造 + 金丝雀实测收账**。

## 波次拆解

### Wave 1（并行，文件零交集）

**W1-A · 测量与字节稳定性 harness**（sonnet）
- 缓存遥测：从 CLI NDJSON usage 里捕获 `cache_read_input_tokens` / `cache_creation_input_tokens`（Anthropic 系；其他 provider 等价字段有则采无则记 null），落进 InvocationRecord.usage，暴露到 GET /api/usage/daily 聚合。
- 字节稳定性 harness（CI 测试）：同一 cat 相邻两次组装，快照 diff——当前基线下**预期是红的**（记录基线差异清单），v2 布局落地后转绿（`[STATIC SYSTEM]`+工具定义字节一致、diff 仅在 meta 块与当前消息）。
- 产出：基线报告（当前命中率数字 + 每轮变动段清单），作为验收对照组。

**W1-B · 四槽 seam + system 层拆分**（opus，架构敏感核心）
- 新建 transport seam：`assembleTransportPayload({system, history, meta, userMsg})`，四槽独立字段、**禁止预 join**（ADR 落地设计项 2）。
- `SystemPromptBuilder`：拆 `buildInvocationContext` → static 保留段 + `buildTurnMetaBlock()`；记忆摘要/lessons/项目四件套/`shouldInjectProjectContext` 产物移出 `buildStaticIdentity`（D1 分界线：session 内会写的一律下放 meta）。
- `route-serial` / `route-parallel`：不再内联拼 parts，改为产出四槽调 seam；contextUsageWarning 入 meta（消除每轮 2-3 次整段重建）。
- Claude 适配器映射：`system → --append-system-prompt`；`-p` 按 **history → meta → userMsg** 排列。
- 全程 `CONTEXT_CACHE_LAYOUT` 门控：v1 走原路径（字节级不变），v2 走新路径。
- F042 Identity 行例外保留在 system（ADR D1 明文）。

### Wave 2（W1-B 合入后）

**W2-C · transport 产物治理（D4）**（sonnet）
- 对准 route-helpers.ts:3256 注入 seam（勿用 :3168 裁剪序）：evidence 检索结果→meta；coverageMap/threadMemory/anchors 逐个核查输入是否含时间戳/随机序→能确定性化的做 append-only（同状态同字节），做不到的入 meta；navigationHeader/Inbox Snapshot→meta；burst 留原位。
- 配合滑动窗口冲突（ADR 开放问题 3）：实现"保前缀驱逐"最小版——按块驱逐 + anchor 钉住，摘要不原位替换。

**W2-D · 不变量与类型约定（D3/D5/D6）**（sonnet）
- meta 永不持久化：AutoSummarizer/SessionSealer/TranscriptWriter/buildThreadMemory 摄入侧显式排除；三条不变量测试（ADR D3 原文）。
- cacheClass 注册（static/volatile/deterministic）+ CI 强制新 section 归类。
- 工具定义顺序回归测试（现状合规，防退化）。

**W2-E · 其余 provider 适配器映射**（sonnet，机械）
- Kimi/Pi 单 blob 按 system→history→meta→userMsg；Codex/Grok/Gemini/OpenCode/Dare/A2A/CatAgent/Antigravity/ACP 各自四槽映射；adapter 内禁止自带 meta 逻辑（D2）。

### Wave 3（部署窗口，需铲屎官在场）
- 部署后 `CONTEXT_CACHE_LAYOUT=v2` 仅对金丝雀猫（ADR 指定 kimi）开 24-48h；
- 用 W1-A 的遥测对比：验收 = 长会话（>50 轮）cache-read 占比 <20% → >70%，TTFT 下降；
- 行为回归：F042 防坍缩 / A2A 行首路由 / 乒乓球熔断 / 压缩接续既有测试集；
- 通过则全量默认 v2，异常一键回 v1。

## 风险与纪律
- 全程不 build/不重启/不提交；改动落码，部署合并到下一个统一窗口。
- W1-B 是热路径重构，flag 默认 v1 保证合入即零风险；金丝雀才是真验证。
- ADR 开放问题 4（deterministic 判定）由 W2-C 逐个核查后在报告中裁决，拿不准一律降级入 meta（弱占优）。
- 与批次 2（thread-first/工具移交）无文件冲突，可并行推进。
