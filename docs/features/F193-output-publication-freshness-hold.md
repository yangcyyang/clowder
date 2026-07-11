---
feature_ids: [F193]
related_features: [F048, F069, F148, F175]
topics: [agent-runtime, publication, freshness, multi-agent, reliability]
doc_kind: spec
created: 2026-07-11
---

# F193: 输出提交协议与 Freshness Hold

> **Status**: in-progress | **Owner**: Maine Coon / Codex | **Priority**: P0

## Why

同一频道里多只猫可能基于过期上下文各说各话。更危险的是：猫开始生成后，用户或另一只猫又补充了新信息，旧回答仍可能从正文、Rich Block、语音、Connector、Push、task event、transcript 或 A2A 任一出口泄漏。

用户批准的 P0-1 方案是：发布前若发现目标 thread 自本轮读取后出现独立新消息，就先 Hold 旧稿、回灌增量并重新审阅；status/system 等结构化运行提示豁免，重审次数和时间均有上限。F193 只承载这条答旧防线，不把 ACK 或多提案单一发布者扩进本次验收。

## What

### Phase A：持久水位与 Hold 状态机

- MessageStore 为每个 thread/audience 提供不透明 append watermark。
- `appendIfFresh()` 在同一个内存临界区或 Redis Lua 中完成比较与正式追加。
- FreshnessHoldStore 保存完整私有草稿、增量消息、CAS 版本、审阅次数和终态。
- InvocationRecord 保存读取上下文前捕获的 baseline。

### Phase B：统一输出提交闸门

- Callback 与 stdout 最终输出共用 FreshnessEgressGate。
- 写型 callback 在首次持久/外部副作用前共用原子 side-effect claim；stale 要求刷新重试，replay 零重复执行。
- 只有 `published` 可以进入 history、WebSocket、TTS、Push、Connector 和 A2A。
- `held`、`discarded`、`needs_attention` 是成功的控制流，不伪装成发送成功。

### Phase C：重审与可观测控制流

- 活跃 callback 原位拿到 delta 并选择 replace / send_draft / discard。
- 已结束 stdout 安排一个有界 `freshness_review` successor；私有稿件不进入 QueueEntry。
- 新输入到达时旧稿转入“重新审阅”，最多重审 2 次；30 分钟超时或持续冲突转人工处理。
- Hold 状态可见，但任何用户可见事件、task event、transcript 或 memory 都不得带出私有稿件。

### Phase D：全出口与恢复

- Web、Callback、Connector、Queue fast-lane、A2A、语音和 Push 使用同一 publication verdict。
- Redis 重启后恢复未完成 Hold 与 active metadata，但不自动泄漏私有草稿。
- 无可信 baseline 的 agent-key / cross-thread callback 保持明确 legacy；受保护路径无法确认 verdict 时一律 fail closed。

## Acceptance Criteria

### A. 水位与持久化

- [x] AC-A1: substantive/queued 消息推进 per-thread audience watermark；status/system/briefing 不推进，whisper 只推进接收者。
- [x] AC-A2: Redis 并发下只有“入站先发生→旧稿 stale”或“出站先提交→published”两种线性结果。
- [x] AC-A3: Hold 按 invocation submission key 去重，CAS claim 只有一个赢家，重启后保留完整草稿与状态。
- [x] AC-A4: baseline 在 memory/Redis invocation registry 中往返不丢失，并在读取上下文前捕获。

### B. 统一提交协议

- [x] AC-B1: current baseline 正式发布一次；stale baseline 零正式 append 并创建同一个 holdId。
- [x] AC-B2: replace/send_draft 可再次 Hold；第 3 次冲突或 30 分钟超时进入 needs_attention；discard 幂等。
- [x] AC-B3: stale stdout/callback 不产生正文、Rich Block、附件、TTS、Push、Connector outbound 或 A2A 泄漏。
- [x] AC-B4: agent-key/cross-thread 等没有可信 baseline 的 legacy 分支被明确标记、可观测且不伪装为 protected。

### C. 重审、可观测与私有性

- [x] AC-C1: Hold 产生无稿件正文的可见提示；active-holds 查询只返回当前用户/线程的状态元数据。
- [x] AC-C2: 新消息触发 Hold 后，活跃 callback 收到 delta 并可 review；已结束 stdout 至多安排一个有界 freshness_review continuation。
- [x] AC-C3: 最多重审 2 次；首次 Hold 30 分钟后由启动时 + 60 秒周期扫描收敛到 needs_attention，稿件继续 fail closed 保留。
- [x] AC-C4: 受保护 invocation 的私有 text/tool input/rich/audio 不得在 verdict 前进入 history、QueueEntry、task event、transcript、agent memory 或用户可见 socket。

### D. 体验、恢复与兼容

- [x] AC-D1: Web/Connector 显示“正在重新审阅”；Redis 与 active-holds API 可在刷新/重启后恢复元数据，且不展示私有草稿正文。
- [x] AC-D2: Callback、Web、Connector、Queue fast-lane、A2A、语音与 Push 的 verdict 一致。
- [x] AC-D3: 两个独立 Agent service invocation 的集成测试证明 B 中途正式追加后，A 被 Hold、收到 delta、review，旧字节不会出现在正式出口。
- [x] AC-D4: agent-key/cross-thread 等无可信 baseline 的 legacy 边界明确可观测；受保护路径发生存储或 verdict 异常时不回退发布。

## 需求点 Checklist

| ID | 用户要的效果 | AC | 验证 |
|----|--------------|----|------|
| R1 | 新信息来了，旧回答先别发 | AC-A1, AC-A2, AC-B1 | atomicity + gate tests |
| R2 | 把新信息给模型重看，再决定替换/发送/丢弃 | AC-B2, AC-C2 | review-loop tests |
| R3 | status/system 提示不应误扣正常回答 | AC-A1 | classification tests |
| R4 | Hold 必须可见，不能静默失败 | AC-C1, AC-D1 | route/API/placeholder tests |
| R5 | 高频 thread 不能无限扣住 | AC-B2, AC-C3 | review-limit + expiry tests |
| R6 | 两只 Agent 交错时旧稿不得从任何出口泄漏 | AC-B3, AC-C4, AC-D2, AC-D3 | leak matrix + two-agent integration |

## Non-goals

- 不用 MessageId、timestamp、WebSocket seq 或 delivery cursor 代替持久 append watermark。
- 不在 F193 内实现 ACK 协议、proposal 编排或 Publication Coordinator；这些不是用户批准的 P0-1 Freshness Hold 验收项。
- 不在首版为无可信 baseline 的 agent-key/cross-thread 路径伪造 freshness 保证。
- 不自动无限重试，不因 Hold 产生新的“猫猫合唱”。

## Key Decisions

| # | 决策 | 理由 |
|---|------|------|
| KD-1 | freshness check 与 append 必须原子化 | 消除 check→append TOCTOU |
| KD-2 | 私有 Hold Store 是唯一草稿真相源 | 防止 history/draft 恢复路径泄漏 |
| KD-3 | watermark 是不透明十进制字符串 | 避免 JavaScript number 精度问题 |
| KD-4 | status 豁免只看受信任结构字段 | 禁止通过正文猜测状态 |
| KD-5 | 最多 2 次重审，之后 needs_attention | 控制成本与死循环 |
| KD-6 | 先私有缓冲所有内容副作用 | verdict 前不允许正文、工具参数、rich/audio、transcript 或 memory 穿透 |

## Design Gate

- 用户已批准“发送前结构化 freshness 检查、旧稿 Hold、回灌重审、status/system 豁免、次数/超时上限”的 P0-1 方案。
- 主界面只展示无稿件正文的 Hold 状态和最终发布结果；active-holds API 只提供恢复元数据。
- callback reviewer 可选择 replace / send_draft / discard；stdout 通过有界 successor 自动复核，needs_attention 交由人工处理。

```yaml
in_context_observability:
  primary_surface: "当前 thread 的重新审阅状态和最终发布结果"
  why_not_dashboard_only: "是否正在 Hold 会直接影响用户对当前回答的预期"
  deep_dive_surface: "Hub Observability 的 publication/hold 事件与 invocation trace"
  noise_dedup_policy: "同一 holdId 只保留一条状态卡；进度更新覆盖，不新增消息"
```

## Risks

| 风险 | 缓解 |
|------|------|
| 旧稿从旁路泄漏 | 所有出口只消费统一 verdict；集成测试覆盖泄漏矩阵 |
| Redis Lua 复杂度/兼容 | 内存与 Redis 同契约，隔离 Redis 并发测试 |
| 重审循环增加成本 | 两次上限、30 分钟超时、needs_attention |
| 并行 sibling 输出互相制造 stale | 同一 parent invocation group 的 sibling 不互相推进业务水位 |
| 私有草稿被历史接口恢复 | Hold 与普通 Draft 分离，history/recovery 明确过滤 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-07-11 | 用户批准执行方案；完成 Message watermark、持久 Hold Store 与 baseline 持久化的第一阶段实现 |
| 2026-07-11 | 完成统一出口门、callback/stdout review、续跑恢复、过期扫描、灰度开关与状态 UI |
| 2026-07-11 | 完成私有性审计与回归验证：工具参数、Rich/audio、task event、transcript、memory、终态草稿均 fail closed |
| 2026-07-11 | 独立审查返回 CHANGES_REQUESTED；完成 queued 私稿 barrier、全工具事件缓冲、成功重放幂等、callback epoch 隔离、动态 A2A 路由冻结、Redis 安全水位与 Web 切线程竞态修复 |
| 2026-07-11 | 第二轮独立审查返回 CHANGES_REQUESTED；关闭 Web replay 二次 Push/continuation、公共私稿读取与普通 delivery 旁路、Redis 批量 reveal 部分提交，以及跨 InvocationQueue 的 A2A protected lineage |

## Close Gate Report

```yaml
close_gate_report:
  feature_id: F193
  spec_path: docs/features/F193-output-publication-freshness-hold.md
  head_sha: 8ade644
  report_date: 2026-07-11

  ac_matrix:
    - ac_id: AC-A1
      status: met
      evidence:
        - kind: test
          ref: packages/api/test/message-freshness-watermark.test.js
          description: audience 水位、结构豁免、whisper 与 queued/delivered 语义
      resolution: null
    - ac_id: AC-A2
      status: met
      evidence:
        - kind: test
          ref: packages/api/test/redis-message-store-freshness.test.js
          description: 隔离 Redis 上验证并发线性化、max-safe 水位 fail-closed 与无部分写入
      resolution: null
    - ac_id: AC-A3
      status: met
      evidence:
        - kind: test
          ref: packages/api/test/redis-freshness-hold-store.test.js
          description: Redis 重建、submission 去重、CAS 单赢家与终态 active index 原子清理
      resolution: null
    - ac_id: AC-A4
      status: met
      evidence:
        - kind: test
          ref: packages/api/test/invocation-freshness-baseline.test.js
          description: memory/Redis registry baseline 往返与 TTL 滑动
      resolution: null
    - ac_id: AC-B1
      status: met
      evidence:
        - kind: test
          ref: packages/api/test/freshness-egress-gate.test.js
          description: current 单次发布、stale 单一 Hold、成功 submit replay 与下游重放标记
      resolution: null
    - ac_id: AC-B2
      status: met
      evidence:
        - kind: test
          ref: packages/api/test/freshness-hold-store.test.js
          description: replace/send_draft 再检查、两次上限、deadline 与 discard
      resolution: null
    - ac_id: AC-B3
      status: met
      evidence:
        - kind: test
          ref: packages/api/test/route-serial-freshness-hold.test.js
          description: text、普通工具详情、Rich、TTS、provider error 与派生路由提示在裁决前均保持私有
        - kind: test
          ref: packages/api/test/web-outbound-delivery.test.js
          description: Web、Push/Connector 消费统一 per-cat verdict
      resolution: null
    - ac_id: AC-B4
      status: met
      evidence:
        - kind: test
          ref: packages/api/test/freshness-hold-rollout.test.js
          description: 未受保护路线保持整体 legacy；受保护路线的动态 A2A 后代继承同一保护语义
        - kind: doc
          ref: docs/agent-runtime/slock-agent-protocol.md
          description: agent-key/cross-thread 的可信 baseline 边界与观测语义
      resolution: null
    - ac_id: AC-C1
      status: met
      evidence:
        - kind: test
          ref: packages/api/test/freshness-holds-route.test.js
          description: current-user/thread 过滤且只返回安全元数据
        - kind: test
          ref: packages/web/src/components/__tests__/freshness-hold-bar.test.ts
          description: UI 状态文本不含草稿正文，快速切 thread 时旧响应不能覆盖当前状态
      resolution: null
    - ac_id: AC-C2
      status: met
      evidence:
        - kind: test
          ref: packages/api/test/freshness-hold-callback.test.js
          description: callback 原位 delta review
        - kind: test
          ref: packages/api/test/freshness-review-continuation.test.js
          description: stdout 有界 successor、去重与 latest ownership
      resolution: null
    - ac_id: AC-C3
      status: met
      evidence:
        - kind: test
          ref: packages/api/test/freshness-hold-expiry-scheduler.test.js
          description: 启动扫描、60 秒周期与 clean stop
        - kind: test
          ref: packages/api/test/freshness-delta-paging.test.js
          description: bounded delta 与 review limit 收敛
      resolution: null
    - ac_id: AC-C4
      status: met
      evidence:
        - kind: test
          ref: packages/api/test/freshness-invocation-private-sinks.test.js
          description: transcript、history import 与 agent memory 零泄漏
        - kind: test
          ref: packages/api/test/fast-lane-freshness-hold.test.js
          description: QueueEntry、task event 与 socket 仅携带安全元数据，成功 replay 不重复 fanout
        - kind: test
          ref: packages/api/test/redis-message-store-freshness.test.js
          description: queued review 私稿不进入 delta/getById/scanAll，普通 markDelivered 无法绕过专用 release
        - kind: test
          ref: packages/api/test/messages-endpoint.test.js
          description: around history 与 exact-id/reply preview 公共读取边界均隐藏私稿
      resolution: null
    - ac_id: AC-D1
      status: met
      evidence:
        - kind: screenshot
          ref: Hub Browser preview on 3013/thread/preview with isolated mock API 3014
          description: reviewing 状态条、私有性说明与 reviewCount 实际渲染
        - kind: test
          ref: packages/api/test/connector-invoke-trigger.test.js
          description: Connector 占位符进入 review 状态且不交付草稿
      resolution: null
    - ac_id: AC-D2
      status: met
      evidence:
        - kind: test
          ref: packages/api/test/route-parallel-freshness-hold.test.js
          description: callback/stdout/普通工具/Rich/PersistenceContext/replay 使用同一 per-cat verdict
        - kind: test
          ref: packages/api/test/streaming-outbound-hook.test.js
          description: Connector streaming placeholder 只接收 Hold 状态
        - kind: test
          ref: packages/api/test/freshness-protected-a2a-lineage.test.js
          description: Web/Queue/callback 的 protected lineage 跨 Queue 传播，非白名单 child 不回退 legacy
      resolution: null
    - ac_id: AC-D3
      status: met
      evidence:
        - kind: test
          ref: packages/api/test/integration/freshness-hold-two-agent.test.js
          description: Opus A 与 Codex B 独立 invocation 交错，A 旧稿零正式出口
      resolution: null
    - ac_id: AC-D4
      status: met
      evidence:
        - kind: test
          ref: packages/api/test/route-serial-callback-dedup.test.js
          description: held/discarded/failed/replayed callback 不恢复旧 stream fallback，replacement 不附着旧 epoch 工具详情
        - kind: test
          ref: packages/api/test/freshness-egress-gate.test.js
          description: release CAS 异常留下的 queued publication 对 delta 保持 fail closed，恢复后才可见
        - kind: doc
          ref: docs/agent-runtime/slock-governance-runtime.md
          description: protected 异常 fail closed、legacy 观测与回滚边界
      resolution: null
```

## Quality Gate Evidence

- 原始需求：`2026-07-11-Raft借鉴-Clowder优化点与执行方案.md` 的 P0-1 Freshness Hold；16 条 AC 均已覆盖，不扩张到 ACK 或发布协调器。
- 设计稿检查：仓库只命中 `docs/design/f190-console-layout.pen`，与 F193 无关；状态 UI 已在当前 worktree 的 3013 页面配合隔离 mock API 3014 实际预览。
- 最新 F193 + consumer 矩阵 229 项中 228 项通过；唯一失败仍为目标分支 45 项中同样失败的 Connector 静默回复旧语义，新增私稿边界、replay 与 A2A lineage 用例全部通过。
- Redis：`127.0.0.1:6398/15` 串行 17/17 通过（Message 11、Hold 5、delta paging 1）；MCP server 173/173 通过；Web 状态条 2/2 通过。
- 第三轮 P0 callback side-effect remediation：投票、建任务、生成文档 stale/current/replay 及共享写路由边界 4/4；核心/权限定向 38/38；Redis Message freshness 更新后 12/12。
- 第四轮时序/分类修复：删除过早共享 preHandler，写路由下沉至前置校验后 claim；protected non-latest、4xx retry、guide-resolve read-only 回归均转绿。写路由定向矩阵首跑 204/205，唯一 legacy limb 状态码回归修复后专项 27/27；核心/Guide 34/34，Redis Message freshness 12/12。
- 全仓递归 build 与 lint 均通过（lint 只有既有 warning）；变更范围 Biome 61 文件 0 error；`git diff --check` 与 artifact hygiene 通过。
- 路由大基线仍为 72/98，与目标分支完全一致；Web 全量为 81 个既有失败、2917 通过，目标分支为相同 81 个失败、2915 通过，新增 2 项均为 F193 通过项。
- 全仓 `pnpm check` 被外部 `~/.claude/skills/gstack` 的 1534 个既有格式错误阻断；changed-scope Biome 为 0 error。env registry 的 6 个既有缺口已在目标分支同命令复现，本次新增的三个 F193 变量已登记。
