---
feature_ids: [F193]
topics: [review, freshness, callback, validation, classification]
doc_kind: review-result
created: 2026-07-11
---

# F193 Independent Review Result 4

Review Head: `1565a98`
Verdict: `CHANGES_REQUESTED`

## Closed

- 第三轮 stale-baseline callback P0、current 单次执行、replay 幂等与 Redis 原子 claim 已关闭。
- request-permission 与 legacy 无 baseline 行为已关闭。

## Findings

1. **P1 — 共享 preHandler 在业务校验前消费 claim**：PR repo 校验第一次 422 且零 task，第二次同请求却返回 published duplicate。
2. **P1 — protected invocation 跳过 latest guard**：同 cat/thread 新 invocation 取代旧 invocation、但 watermark 不变时，旧 invocation 仍可 start-vote。
3. **P2 — 纯查询 guide-resolve 被误认领**：重复或 stale 查询丢失 discovery 数据。

## Remediation

- `27a8265` 删除共享 preHandler，将所有写路由的 claim 下沉到 schema/ownership/existence/latest/只读前置校验之后、首次业务写之前。
- helper 对所有 protected side effect 统一执行 latest 检查；旧 invocation 返回 `stale_ignored` 且零写入。
- 增加显式 abort，仅在调用方能证明零业务写时释放 claim，解决验证失败后的同请求重试；内存 claim 增加 24 小时机会式清理。
- `guide-resolve` 保持纯查询，不受 watermark/replay 拦截。

## Evidence

- callback side-effect：6/6，包含 stale/current/replay、protected non-latest、4xx→retry。
- protected guide-resolve stale + replay：返回相同 matches，不变成 duplicate。
- 写路由定向首跑 204/205，唯一 legacy limb unknown-node 状态码回归修复后专项 27/27。
- API build、changed-scope Biome 0 error、Redis Message freshness 12/12。

## Next Action

同一独立 reviewer 覆盖 `27a8265` 与本记录，重点自建前置失败重试、non-latest、query 分类和至少一个非样例写路由复现；无新 blocker 时明确给出 `VERDICT: APPROVE`。
