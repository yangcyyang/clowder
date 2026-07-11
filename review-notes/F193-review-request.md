---
feature_ids: [F193]
topics: [review, freshness, publication, reliability]
doc_kind: review-request
created: 2026-07-11
---

# Review Request: F193 输出提交协议与 Freshness Hold

Review-Target-ID: freshness-hold
Branch: codex/freshness-hold
Range: b1a1683..HEAD
Review-Fix-Head: 8ade644

## What

为所有受保护 Agent 输出加入 per-thread/audience append watermark、持久 Hold 状态机、原子提交闸门、callback/stdout 重审、过期收敛、全出口 verdict、灰度开关，以及不含私稿的 Web/Connector 状态提示。

## Why

Agent 组织回答期间若用户或另一 Agent 写入独立新消息，旧回答不能继续从正文、Rich/audio、Push、Connector、task event、transcript 或 memory 旁路发出；它必须先被安全扣住，读完增量后再发布、改写或放弃。

## Original Requirements（必填）

> agent 要发消息时，若目标 thread/频道自它本轮开始后有新消息，先扣住不发、把新消息回灌，让它 review 再决定发或改。
> 纯 status/liveness/系统提示不走 freshness，只对实质消息生效。
> 扣草稿必须可观测；回灌后有有限次数/超时，避免高频频道永远发不出。
> 真实双 Agent 场景验证 A 正在答、B 中途插新消息时，A 被扣住并回灌。

- 来源：`/Users/cy/Documents/03 life/AI design/OrbitOS-CN/00_收件箱/2026-07-11-Raft借鉴-Clowder优化点与执行方案.md`
- **请对照上面的摘录判断交付物是否解决了用户的问题。**

## Tradeoff

- 受保护 invocation 采用 fail closed：即使最终发布，本版也不补写原始 transcript/agent memory，避免裁决前旁路泄漏。
- rollout 默认关闭，可按 cat/thread 白名单启用；同一路由只有全部初始目标都命中才进入 protected 模式，动态 A2A 后代继承已选中的 protected 语义。
- released/discarded 终态立即擦除 draft/delta；`needs_attention` 为人工恢复保留私稿，但 API 永不返回正文。
- Redis 可恢复 Hold 与 active metadata；stdout review QueueEntry 的私有调度 payload 只在进程内存在，重启后稿件仍安全但不会自动重建 successor。

## Open Questions

1. 全出口矩阵是否仍存在可绕过 per-cat verdict 的旁路，尤其是 callback tool detail、A2A、task event 与 rich-only 结果？
2. Hold 的 `reviewing → queued → released → delivered` 恢复与终态 scrubbing 是否存在 CAS/崩溃窗口？
3. fail-closed transcript/memory 取舍、默认关闭 rollout，以及进程内 successor 限制是否与已批准的 P0-1 范围一致？
4. route-serial/parallel 与 QueueProcessor 的改动是否引入非 Freshness 行为回归？

## Next Action

请同一独立 reviewer 对照原始需求、F193 AC、前两次 review findings、状态机/安全边界和 `8ade644` 修复差异进行只读复审；重点确认 public/private lookup capability、专用 release、批量 reveal 单 Lua 与跨 Queue protected lineage。无阻塞项时明确给出 APPROVE。

## Re-review Fix Map

| 首轮 finding | 修复 | RED→GREEN 证据 |
|---|---|---|
| P0 queued review 私稿进入 delta | 内部 marker + memory/Redis 结构 barrier；delivered/canceled 才清 marker | Gate crash recovery；Redis queued sentinel / real Gate crash tests |
| P0 普通 tool detail 在 verdict 前广播 | serial/parallel 按 publication epoch 缓冲所有 tool detail | route serial/parallel fresh/held tool tests |
| P1 provider error tool-only 绕 Gate | protected error 分支 fail closed、只留安全 error control | serial/parallel protected error tests |
| P1 successful submit 不幂等 | Gate 派生稳定 key，`replayed` 贯穿 route/Web/Queue/Connector/fast-lane | Gate、route replay、Web/Connector、fast-lane tests |
| P1 callback replace 附着旧 epoch | held/discarded 清旧 callback、普通工具与 metadata epoch | held→replace callback augment regression |
| P2 Redis watermark double 精度 | max-safe 前置拒绝，INCR 后 GET 精确文本；append/restore/reveal 无部分写 | Redis max watermark / partial mutation tests |
| 残余：动态 A2A 混合 rollout | route 选中后使用共享 store 的 `forProtectedRoute()` | rollout + Gate protected-route tests |
| 残余：active ZSET 膨胀 | release/discard CAS 同 Lua 原子 ZREM | Redis Hold active-index tests |
| 残余：旧 thread fetch 迟到 | AbortController + request generation | FreshnessHoldBar thread isolation test |
| 残余：私稿派生路由提示抢跑 | routing syntax/inline feedback 延后到 published | held inline routing hint test |
| 二审 P1：Web replay 二次 Push/continuation | invocation-wide 与 per-cat 新发布判定；replay-only 零 fanout | Web Push + continuation route tests |
| 二审 P1：queued 私稿公共读取/普通 delivery 旁路 | public getById/scanAll/around/reply preview 默认隐藏；Gate raw capability + 专用 release | exact-id/around/reply preview/marker delivery tests |
| 二审 P1：动态 A2A 跨 Queue 恢复 legacy | QueueEntry immutable lineage；Web/Queue/callback 传播；child 强制 protected Gate | freshness-protected-a2a-lineage + route handoff tests |
| 二审 P2：多 whisper reveal 部分提交 | 单 Lua 发现候选、精确容量预检、整批 hash/index 更新 | Redis multi-whisper MAX_SAFE test |

## Review Sandbox（必填）

- Path: `/tmp/cat-cafe-review/freshness-hold/independent-reviewer`
- Start Command: `pnpm review:start`
- Ports: `web=3213`, `api=3214`（隔离预留；实现预览证据使用当前 worktree 的 3013/3014）

## 自检证据

### Spec 合规

- F193 的 16 条 AC 均有 test/doc/screenshot evidence；CloseGateReport 位于 feature spec。
- 原需求只覆盖 P0-1 Freshness Hold，未把 ACK 或 Publication Coordinator 扩入验收。
- 根目录媒体/设计工件扫描为空；F193 无匹配 `.pen`，隔离页面实际渲染了 reviewing 状态条。

### 测试结果

- `pnpm -r --if-present run build` → exit 0
- `pnpm lint` → exit 0（仅仓库既有 warning）
- 最新 F193 + consumer matrix → 228/229；唯一失败在目标分支同文件 44/45 复现，新增私稿边界、replay 与 A2A lineage 用例全部通过
- Redis F193（127.0.0.1:6398/15，串行）→ 17/17
- MCP server → 173/173
- Web FreshnessHoldBar → 2/2
- Web 全量差分：分支 81 fail / 2917 pass；目标分支相同 81 fail / 2915 pass
- route-strategies 大基线 → 72/98，与目标分支一致
- changed-scope Biome → 61 files, 0 errors；全仓 check 被外部 gstack 的 1534 个既有格式错误阻断

### 相关文档

- Plan: `/Users/cy/Documents/03 life/AI design/OrbitOS-CN/00_收件箱/2026-07-11-Raft借鉴-Clowder优化点与执行方案.md`
- Feature: `docs/features/F193-output-publication-freshness-hold.md`
- Protocol: `docs/agent-runtime/slock-agent-protocol.md`
- Governance: `docs/agent-runtime/slock-governance-runtime.md`
