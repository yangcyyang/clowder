---
feature_ids: [F193]
topics: [review, freshness, publication, reliability]
doc_kind: review-result
created: 2026-07-11
---

# F193 Independent Review Result 1

Reviewer: `/root/f193_independent_reviewer`

Verdict: `CHANGES_REQUESTED`

## Blocking Findings

- P0：review queued 私稿在 Hold release CAS 前已进入 freshness delta，崩溃窗口可让其他 invocation 读到旧稿。
- P0：普通 `tool_use` / `tool_result` 详情在最终 verdict 前经 route yield 到 WebSocket。
- P1：provider error + tool-only 分支绕过 Gate 写入正式 history。
- P1：successful submit 没有按 `(invocationId, submissionKey)` 幂等，重试可重复发布或制造假 Hold。
- P1：callback held 后 replace 发布会把旧 callback epoch 的 tool detail augment 到新消息。
- P2：Redis watermark 经过 Lua number / ZSET double，在 `2^53` 边界会出现科学计数法、异常后部分写与 score 碰撞。

## Residual Risks Raised

- 初始目标命中 rollout 后，动态 A2A 加入非白名单猫会形成 protected / legacy 混合路线。
- released / discarded Hold 长期残留在 Redis user-thread active ZSET。
- 由私有正文派生的 routing syntax / inline mention 提示可能先于 verdict 可见。
- FreshnessHoldBar 切换 thread 时，旧请求迟到可覆盖当前 thread 状态。
- stdout review successor 为进程内调度，重启后不自动重建；这是已记录的首版取舍，稿件仍 fail closed 保留。

## Remediation

代码修复提交：`7128ac9`。

- queued review publication 改为占水位但不 hydrate 的私有 barrier。
- serial / parallel 缓冲全部工具详情，error、held、discarded、replayed 均不释放。
- successful submit 统一幂等，并把 `replayed` 传到 route、Web、Queue、Connector、fast-lane 和 callback consumer。
- callback publication epoch 隔离，旧 tool detail 不再附着 replacement。
- Redis 水位在 max-safe 前原子拒绝，terminal active index 同 CAS 清理。
- route 选中 protected 后冻结整条动态 A2A 路线语义。
- 私稿派生提示延后到 published；Web 请求加入 abort + generation guard。

状态：等待同一 reviewer 对 `7128ac9` 与当前文档 HEAD 复审。
