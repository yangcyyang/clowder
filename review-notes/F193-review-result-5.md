---
feature_ids: [F193]
topics: [review, freshness, callback, approval]
doc_kind: review-result
created: 2026-07-11
---

# F193 Independent Review Result 5

Review Head: `7c9ce9c`
Verdict: `APPROVE`

## Closed

- 过早 claim：独立 `register-pr` 复现为 `422 → ok → duplicate`，仅写入 1 个任务。
- protected non-latest：旧 invocation 返回 `stale_ignored`，无投票状态、无广播。
- guide-resolve 分类：stale watermark 与 replay 都返回完整且一致的查询结果。
- ambiguous game 4xx：下游先产生副作用再返回 400 时保留 claim，重放为 duplicate，外部写仅 1 次。

## Independent Evidence

- API build：通过。
- 定向测试：41/41。
- Callback/legacy 矩阵：444/444。
- Redis freshness：12/12，仅 `127.0.0.1:6398/15`。
- 工作树：clean。

## Residual Risk

claim 后、业务写前进程崩溃仍采用 at-most-once / fail-closed 语义。abort 当前按 key 删除；未来可用 owner token 或 claim lease 强化极端延迟竞争，不阻塞本次 P0-1。

## A2A Handoff

- **What**：第五轮独立复审通过。
- **Why**：历史缺陷与新增游戏边界均有独立黑盒闭环。
- **Tradeoff**：副作用状态不明时 fail closed，不冒险重复执行。
- **Open Questions**：后续是否引入带 owner token 的 claim lease。
- **Next Action**：进入 merge-gate。
