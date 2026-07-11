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

同一频道里可以让多只猫并行思考，但用户不应该看到“七个人同时回答同一个问题”。更危险的是：猫开始生成后，用户又补充了新信息，旧回答仍可能从正文、Rich Block、语音、Connector、Push 或 A2A 任一出口泄漏。

用户要求把系统改成：快速确认已接收；内部并行产出候选；只有一个发布者提交最终答案；发布前如果发现上下文已更新，就先 Hold 旧稿、回灌增量并重新审阅。

## What

### Phase A：持久水位与 Hold 状态机

- MessageStore 为每个 thread/audience 提供不透明 append watermark。
- `appendIfFresh()` 在同一个内存临界区或 Redis Lua 中完成比较与正式追加。
- FreshnessHoldStore 保存完整私有草稿、增量消息、CAS 版本、审阅次数和终态。
- InvocationRecord 保存读取上下文前捕获的 baseline。

### Phase B：统一输出提交闸门

- Callback 与 stdout 最终输出共用 FreshnessEgressGate。
- 只有 `published` 可以进入 history、WebSocket、TTS、Push、Connector 和 A2A。
- `held`、`discarded`、`needs_attention` 是成功的控制流，不伪装成发送成功。

### Phase C：ACK、重审与单一发布者

- 用户消息进入后 1 秒内显示 accepted/queued/started ACK。
- 多猫输出作为内部 proposal 保存，由 Lead/Publication Coordinator 选择、合并或要求补充。
- 新输入到达时旧稿转入“重新审阅”，最多重审 2 次；超时或持续冲突转人工处理。

### Phase D：全出口与恢复

- Web、Callback、Connector、跨线程、A2A、语音和 Push 使用同一 publication verdict。
- 重启后恢复未完成 Hold 与可见状态，但不自动泄漏私有草稿。
- 支持渐进开关与 fail-closed 回滚。

## Acceptance Criteria

### A. 水位与持久化

- [ ] AC-A1: substantive/queued 消息推进 per-thread audience watermark；status/system/briefing 不推进，whisper 只推进接收者。
- [ ] AC-A2: Redis 并发下只有“入站先发生→旧稿 stale”或“出站先提交→published”两种线性结果。
- [ ] AC-A3: Hold 按 invocation submission key 去重，CAS claim 只有一个赢家，重启后保留完整草稿与状态。
- [ ] AC-A4: baseline 在 memory/Redis invocation registry 中往返不丢失，并在读取上下文前捕获。

### B. 统一提交协议

- [ ] AC-B1: current baseline 正式发布一次；stale baseline 零正式 append 并创建同一个 holdId。
- [ ] AC-B2: replace/send_draft 可再次 Hold；第 3 次冲突或 30 分钟超时进入 needs_attention；discard 幂等。
- [ ] AC-B3: stale stdout/callback 不产生正文、Rich Block、附件、TTS、Push、Connector outbound 或 A2A 泄漏。
- [ ] AC-B4: agent-key/cross-thread 等没有可信 baseline 的 legacy 分支被明确标记、可观测且不伪装为 protected。

### C. ACK 与多猫收口

- [ ] AC-C1: 用户消息 1 秒内获得 accepted/queued/started 中至少一种可见 ACK。
- [ ] AC-C2: 同一任务的多猫内容默认进入 proposal，不直接形成多条最终回答。
- [ ] AC-C3: Publication Coordinator 每轮只发布一个 final，记录使用了哪些 proposal 和为何取舍。
- [ ] AC-C4: 新消息触发 Hold 后，活跃调用收到 delta；已结束调用安排至多一个 bounded freshness_review continuation。

### D. 体验、恢复与兼容

- [ ] AC-D1: Web 显示“正在重新审阅”，刷新/重启后仍能恢复，且不展示私有草稿正文。
- [ ] AC-D2: Callback、Web、Connector、A2A、语音与 Push 的 verdict 一致。
- [ ] AC-D3: 两代理集成测试证明 B/用户中途追加后，A 的旧字节不会出现在任何正式出口。
- [ ] AC-D4: 功能可按 thread/cat 渐进启用；关闭后恢复 legacy，不破坏已发布消息和现有队列。

## 需求点 Checklist

| ID | 用户要的效果 | AC | 验证 |
|----|--------------|----|------|
| R1 | 先快速告诉我系统收到并开始处理 | AC-C1 | ACK latency test + UI |
| R2 | 多模型内部协作，不要七条答案轰炸 | AC-C2, AC-C3 | multi-agent integration |
| R3 | 新信息来了，旧回答先别发 | AC-A1, AC-A2, AC-B1 | atomicity + gate tests |
| R4 | 把新信息给模型重看，再决定替换/发送/丢弃 | AC-B2, AC-C4 | review-loop tests |
| R5 | 所有出口都不能漏旧稿 | AC-B3, AC-D2, AC-D3 | leak matrix |
| R6 | 重启后也不能忘，异常时可人工接管 | AC-A3, AC-D1, AC-D4 | Redis restart + UI |

## Non-goals

- 不用 MessageId、timestamp、WebSocket seq 或 delivery cursor 代替持久 append watermark。
- 不让所有猫拥有最终发布权；proposal 与 final 是不同数据类型。
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
| KD-6 | 单一 Publication Coordinator | 把多模型从“多答”变成“多提案、一发布” |

## Design Gate

- 用户已批准“快速 ACK、旧稿 Hold、回灌重审、多猫单一最终发布”的整体方案。
- 主界面不展示内部 proposal 洪流；只展示 ACK、必要进度、Hold 状态和最终答案。
- Hold 卡片提供重新审阅、发送当前稿、丢弃和人工处理入口；默认不展示私有稿全文。

```yaml
in_context_observability:
  primary_surface: "当前 thread 的 ACK、重新审阅状态和单一 final"
  why_not_dashboard_only: "是否正在 Hold 会直接影响用户对当前回答的预期"
  deep_dive_surface: "Hub Observability 的 publication/hold 事件与 proposal trace"
  noise_dedup_policy: "同一 holdId 只保留一条状态卡；进度更新覆盖，不新增消息"
```

## Risks

| 风险 | 缓解 |
|------|------|
| 旧稿从旁路泄漏 | 所有出口只消费统一 verdict；集成测试覆盖泄漏矩阵 |
| Redis Lua 复杂度/兼容 | 内存与 Redis 同契约，隔离 Redis 并发测试 |
| 重审循环增加成本 | 两次上限、30 分钟超时、needs_attention |
| 并行 proposal 互相制造 stale | 同一 parent invocation group 的 sibling 不互相推进业务水位 |
| 私有草稿被历史接口恢复 | Hold 与普通 Draft 分离，history/recovery 明确过滤 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-07-11 | 用户批准执行方案；完成 Message watermark、持久 Hold Store 与 baseline 持久化的第一阶段实现 |
