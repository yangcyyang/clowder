---
feature_ids: [F001]
topics: [A2A, queue, handoff]
doc_kind: bug-report
created: 2026-07-15
---

# BUG-a2a：queued user 导致传球悬空

## 诊断胶囊

| 栏位 | 内容 |
|------|------|
| **1. 现象** | 同一线程仍有用户消息排队时，Agent A 的行首 `@Agent B` 只产生橙色“未触发”提醒；用户队列清空后 B 不会自动收到传球。期望是传球进入持久队列，用户消息处理完后自动补投。 |
| **2. 证据** | `route-serial.ts` 在 `queueHasQueuedMessages(threadId)=true` 时写入 `queued_user_messages` notice，并由 `!queuedMessagesPending` 跳过 `enqueueA2ATargets`。task #366 已提供 7 天 TTL、Redis journal 与空闲补投链路。运行时 preflight：3004 PID 19225，API 目标提交 `790e144` 后启动，`/api/ready` 与 `/api/cats` 均返回 200。 |
| **3. 问题假设或根因** | 已确认根因：公平闸门把“暂缓执行”错误实现成“禁止持久接纳”，因此没有 QueueEntry 可供队列清空时补投。 |
| **4. 诊断策略** | 逆向追踪 `routeSerial → enqueueA2ATargets → InvocationQueue → QueueProcessor.tryAutoExecute/onInvocationComplete`，并与 task #366 的 busy-target 正常链路逐项对照。 |
| **5. 超时策略** | 若 60 分钟内不能用现有 queue hook 复现并锁定，则停止实现，缩小到 route 单测与 QueueProcessor 集成 fixture；冲突语义不清时提交明确矩阵给方案 owner，不做隐式 NLP 猜测。 |
| **6. 预警策略** | 若需要新增 scheduler、绕过 queue fairness，或三次修复仍出现新竞态，视为架构方向错误并回到 Phase 1。并行调度、无 durable hook、无 Redis 三种边界必须单独声明。 |
| **7. 用户可见交互修正** | 传球被延后时改为“已排队，用户消息处理完自动传球”；若期间用户显式改指令或取消，则不唤醒目标 Agent，改为提醒发球方重新确认。 |
| **8. 验收** | 红测覆盖：queued user 时仍持久 enqueue；用户 entry 未清空前目标不执行、清空后恰好执行一次；无排队场景不回归；显式 correction 转发球方 reminder。最终运行 API 定向测试、build、diff check 与 live smoke。 |

## 五件套

### 1. 报告人

由 `@yangcyyang` 在 Clowder 实际协作中发现，`@专家-Claude` 完成初步代码定位并锁定排期。

### 2. 复现步骤

1. 同一线程快速发送两条用户消息，使第二条进入队列。
2. 第一条对应的 Agent A 回复中用独立行首 `@Agent B` 发起交接。
3. 观察当前只出现“未触发”提醒；第二条用户消息执行完后 B 仍未启动。

### 3. 根因分析

`queued_user_messages` 是合理的执行公平约束，但当前同时阻止 durable admission。系统保留了提示，却丢掉了真实待办。

### 4. 修复方案

保留 legacy 无队列 hook 的公平阻断；当 durable `enqueueA2ATargets` 可用时仍接纳 A2A work item，由既有 non-agent gate 延后执行。入队项携带原始用户消息边界与“曾等待用户队列”标记，通用 dequeue、批处理、手动 next 和 steer 都不能绕过专用 replay guard。

补投前扫描原始用户消息之后、同线程且已 delivered 的用户消息，并逐条复用 Intent Snapshot correction 规则：

- 命中明确改指令/取消时，不启动旧目标；先持久写入 `sourceCategory=conflict` 的发球方 reminder，再持久删除原 A2A 项，并广播一条幂等冲突通知。
- 普通补充消息不视为冲突，仍按既有 A2A 链路投递。
- history 读取失败、lineage 缺失、durable delete 失败时均 fail-closed，原 A2A 保留在队列中。
- history 异步读取前后都复查 non-agent work，封住用户消息插入窗口。

### 5. 验证方式

实现提交：`d4294a9 fix(a2a): replay handoffs after queued user work`。

Fresh 验证：

- 核心相关回归：160/160（InvocationQueue 115、Queue API 41、route notice 4）。
- replay guard + durable route：11/11。
- QueueProcessor 全文件：122/124；仅两条任务前已存在的 connector batching 基线失败，本改动相关断言全部通过。
- route-strategies 相关 A2A 用例通过；全文件其余失败属于工作树既有 fixture/时间戳/guide-context 基线。
- API build、workspace recursive build、workspace lint、目标文件 Biome、`git diff --check` 均通过。
- 全量 `pnpm test`：Web 381 files passed / 37 failed，2961 tests passed / 81 failed；失败集中在 SessionChain、ThreadSidebar 等既有 Web 基线，与本任务 11 个提交文件无交集。
- `pnpm check` 仍被仓库既有 1530 条问题阻断，主要来自外部 `.claude/skills/gstack` 与既有格式问题；目标 11 文件独立 Biome 为 0 error。

## 非阻断风险

- history 读取失败或 lineage 缺失时采用 fail-closed，只写 warn 并保留队列项；需要下一次队列事件或 TTL 才再次处理。
- 活跃时间超过 7 天的线程会扫描原始边界后的全部消息，极端长线程存在额外读取成本。
- notice 存储使用确定性幂等键；若底层返回既有消息，广播层仍可能再次推送相同 message id。

## CloseGateReport

```yaml
close_gate_report:
  feature_id: F001
  spec_path: docs/bug-report/a2a-queued-user-handoff-loss/bug-report.md
  head_sha: d4294a9
  report_date: 2026-07-15

  ac_matrix:
    - ac_id: AC-A1
      status: met
      evidence:
        - kind: commit
          ref: d4294a9
          description: queued user 只延迟执行，不再抑制 durable A2A admission
        - kind: test
          ref: packages/api/test/route-strategies.test.js
          description: durable hook 与 legacy 无 hook 两条路径均有回归锁
      resolution: null

    - ac_id: AC-A2
      status: met
      evidence:
        - kind: test
          ref: packages/api/test/queue-processor.test.js
          description: 用户 queued 和 processing 状态结束前目标不运行，结束后恰好一次
        - kind: test
          ref: packages/api/test/invocation-queue.test.js
          description: 通用 dequeue 与 A2A batching 不绕过 replay guard
      resolution: null

    - ac_id: AC-A3
      status: met
      evidence:
        - kind: test
          ref: packages/api/test/queue-processor.test.js
          description: correction 超过 intent window 仍命中并转为发球方 durable conflict reminder
        - kind: test
          ref: packages/api/test/queue-processor.test.js
          description: 普通补充不误判冲突
      resolution: null

    - ac_id: AC-A4
      status: met
      evidence:
        - kind: test
          ref: packages/api/test/queue-processor.test.js
          description: history 失败、lineage 缺失、delete 失败、异步读取竞态均 fail-closed
        - kind: test
          ref: packages/api/test/queue-api.test.js
          description: immediate steer 走定向 guard，promote 不允许改变保护顺序
      resolution: null

    - ac_id: AC-A5
      status: met
      evidence:
        - kind: test
          ref: packages/api/test/route-serial-notice-contract.test.js
          description: 用户可见提醒明确表达已排队并自动传球
        - kind: test
          ref: packages/api/test/queue-processor.test.js
          description: 冲突提醒先持久化再移除原 A2A，notice 使用确定性幂等键
      resolution: null
```
