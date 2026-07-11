---
feature_ids: [F193]
topics: [review, freshness, publication, redis, a2a]
doc_kind: review-result
created: 2026-07-11
---

# F193 Independent Review Result 2

Review Head: `0413d4d`
Verdict: `CHANGES_REQUESTED`

## Closed

- 普通工具详情、provider error tool-only、callback epoch、submit replay、FreshnessHoldBar stale fetch 与 terminal active index 已关闭。
- Web replay-only 的二次 Push / continuation 在审查期间由 `0413d4d` 修复并经独立定向测试确认关闭。

## Findings

1. **P1 — queued review 私稿公共读取与普通 delivery 旁路**：exact-id、around、reply preview、Redis scanAll 可 hydrate 私稿，普通 `markDelivered` 可清 marker。
2. **P1 — 动态 A2A 跨 InvocationQueue 丢失 protected lineage**：allowlisted 父 route 的非白名单 child 新 route 会重新选择到 legacy。
3. **P2 — Redis 多 whisper reveal 部分提交**：接近 MAX_SAFE 时第一条已公开，第二条才抛 exhausted。

## Remediation

- `8ade644`：公共 MessageStore lookup 默认隐藏 pending review publication；Gate 使用显式 raw capability，专用 release primitive 才能 deliver。
- `8ade644`：一次 reveal 的候选、容量预检与全部 hash/index 更新收口到单个 Lua。
- `8ade644`：QueueEntry 增加 immutable `freshnessProtected` lineage，Web/Queue/callback 传播到非白名单 child route。

## Evidence

- Public/private boundary + Gate：97/97。
- A2A lineage + F193 directed non-Redis：111/111。
- F193 consumer matrix：228/229；唯一失败在目标分支同文件 44/45 复现。
- Redis `127.0.0.1:6398/15` 串行：17/17。

## Next Action

同一独立 reviewer 覆盖 `8ade644` 及其文档提交，逐项复核上述 2×P1 + 1×P2；无新 blocker 时明确给出 `VERDICT: APPROVE`。
