---
feature_ids: [F004]
topics: [request-review, token, context]
doc_kind: review_request
created: 2026-07-13
---

# F004 一期方案 Review Request

Review-Target-ID: `f004-token-context-governance`

Branch: 当前工作目录文档变更（仓库尚无提交）

## Original Requirements

来源：内部讨论 thread（id 已脱敏）。

> 操作是否会带着大量上下文去到 LLM，导致不必要的 TOKEN 浪费；需要考虑
> Clowder 是否有问题。

## What / Why

新增 F004 一期方案：轻量猫默认使用 ≤500-token 的 `minimal` 固定注入，
但由服务端按任务风险升级；安全核心单一真相源，未知状态回退 `standard`。
这直接处理审计已证实的固定注入膨胀，同时避免为了节省 token 丢失门禁。

## Tradeoff

- 本期不启用 history summary，不把三类问题一次混改。
- 不以尚未对账的成本金额承诺收益，先以真实 tokenizer 和 per-source 遥测验收。
- 先 shadow 100 次再启用，速度让位于安全与路由等价性。

## Review Focus

1. ≤500-token 核心契约是否漏掉不可删规则？
2. “猫默认值 + 任务风险只升级”的边界是否足够 fail closed？
3. shadow 100 次与 7 天指标能否证明没有路由/安全回归？
4. P0/P1 边界是否清楚，是否存在把实现细节偷偷带入本期的情况？

## Evidence

- 审计：`docs/token-audit-2026-07-13.md`
- Spec：`docs/features/F004-token-context-governance.md`
- 自检：`docs/reviews/F004-token-context-governance-quality-gate.md`
- `git diff --check` 和 frontmatter/链接检查需在发出请求前通过。

## Review Result

芝芝于内部 review 消息放行；两处 P2 已补入 spec，
一处 P3 已转成 AC-5 的异常 shadow 样本要求。Reviewer 明确无需重走 review。
