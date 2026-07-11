---
feature_ids: [F193]
topics: [review, freshness, callback, side-effects]
doc_kind: review-result
created: 2026-07-11
---

# F193 Independent Review Result 3

Review Head: `a2b96f4`
Verdict: `CHANGES_REQUESTED`

## Closed

- queued review 私稿公共读取与普通 delivery 旁路已关闭。
- Redis 多 whisper reveal 已收口到单 Lua，无部分提交。
- 动态 A2A protected lineage 与 Web replay Push/continuation 已关闭。

## Finding

**P0 — protected callback side-effect family 绕过统一 verdict**：`start-vote` 可在 baseline stale 后继续写 VotingState、广播 question、追加 history 并触发 A2A；task 与 document 等同族回调也只验证 auth/latest，没有消费 freshness baseline。

## Remediation

- `d2034a4` 在 MessageStore/Redis 增加原子 `claimFreshnessSideEffect`，以 invocation + route/request digest 幂等认领。
- `start-vote`、task create/update/claim、generate-document 在参数和归属校验后、首次业务写前认领。
- 其余写型 callback 由共享边界覆盖；权限请求单独接入。stale 返回 `freshness_retry_required`，replay 返回 `duplicate`，两者均不执行业务副作用。
- legacy invocation 无 baseline 时保持旧行为；只读、状态查询与 refresh-token 明确不进入认领。

## Evidence

- callback stale/current/replay：4/4（投票、建任务、生成文档、共享写路由代表）。
- FreshnessEgressGate + 权限回调：38/38。
- callback/task/document 既有定向回归：110/110。
- Redis Message freshness（`127.0.0.1:6398/15`）：12/12。
- API build 与 changed-scope Biome：通过，0 error。

## Tradeoff

side-effect claim 是业务动作的提交线性化点，而不是可重放 effect envelope。认领后、实际业务写前若进程崩溃会 fail closed，本次动作不会自动重放；Agent 需要用新 invocation 明确重试。

## Next Action

同一独立 reviewer 对 `d2034a4` 及文档提交复核 callback 写族覆盖、原子性、stale/current/replay 与 legacy 行为；无新 blocker 时明确给出 `VERDICT: APPROVE`。
