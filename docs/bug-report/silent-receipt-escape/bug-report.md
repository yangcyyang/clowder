---
feature_ids: []
topics: [scheduler, silent_receipt, channel-noise]
doc_kind: bug-report
created: 2026-07-15
---

# BUG：window-primer silent_receipt 逃逸

## 诊断胶囊

| 栏位 | 内容 |
|------|------|
| **1. 现象** | task #377 已部署后，2026-07-15 的 08:00、10:30、13:00 三条 window-primer 回执仍作为普通 assistant 消息进入 default 主时间线。预期是 invocation、usage 与账本保留，但回执不渲染、不计 unread。 |
| **2. 证据** | live `GET /api/messages?threadId=default` 显示三条回执 `0001784073633308-000001-1dcac89d`、`0001784082618960-000003-7a100130`、`0001784091614412-000011-884b7c4a` 均只有 `extra.stream.invocationId`，没有 `extra.scheduler.hiddenReceipt`。对应 trigger 内容分别以 `@研究生 window-primer` 或 `@gpt52 window-primer` 开头。逃逸发生时的运行时预检：3004 listener PID 38666，进程启动晚于 #377 live migration `5ca0c75`，ready/Redis/SQLite/cats 均正常。 |
| **3. 问题假设或根因** | 已确认根因：`reminderTemplate` 用行首正则 `^window-primer` 判定 presentation，但线上真实 reminder 在 marker 前带目标 `@mention`，导致 `isWindowPrimer=false`，`responsePresentation` 从源头未进入 Connector、Router、MessageStore。Web 与 Redis 均按收到的数据正确工作。 |
| **4. 诊断策略** | 先从 live message 反查 invocation 与 trigger，再沿 `reminderTemplate → ConnectorInvokeTrigger → routeExecution → MessageStore → Web visibility` 逐层确认字段在哪一层第一次缺失；用线上真实 `@研究生 window-primer：...` 形态补红测。 |
| **5. 超时策略** | 若 30 分钟内无法在 reminder template 单测复现，则停止修改，改查 scheduler 实例序列化和旧进程加载；若字段已进入 Connector 但存储缺失，再转 Redis round-trip 集成测试，不扩大到 Web。 |
| **6. 预警策略** | 若修复需要正文模糊匹配或新增 message type，视为越界并回到 Phase 1。普通 reminder、人工“窗口已激活”和正文中提到 window-primer 必须保持可见；历史迁移只能使用本次三个精确 ID。 |
| **7. 用户可见交互修正** | scheduler 中明确的 window-primer 回执恢复静默；触发消息仍按既有 hiddenTrigger 规则隐藏，服务端未读摘要不再计 silent receipt；本次已落库的三条逃逸回执按精确 ID 隐藏，普通提醒与人工消息行为不变。 |
| **8. 验收** | 红测证明带单个前置 `@mention` 的 primer 原先没有 `silent_receipt`、服务端 unread 会误计、三条 live 逃逸仍可见；修后中英文 mention 形态均携带 presentation，正文提及 marker 的正负例不误吞，silent receipt unread-neutral，三个精确 ID 隐藏；API/Web build、目标测试、lint/diff check 通过。 |

## 五件套

### 1. 报告人

`@专家-Claude` 在 task #389 终验时发现并报告，由 `@老者-codex` 认领 task #391 独立调查。

### 2. 复现步骤

1. 注册 reminder，message 使用线上真实形态：`@研究生 window-primer：只需回复「Claude 窗口已激活 + 当前时间」`。
2. 让 scheduler 执行该 reminder 并唤醒目标 Agent。
3. 读取 default thread 消息。
4. 观察 assistant 回执缺少 `extra.scheduler.hiddenReceipt`，因此进入主时间线。

### 3. 根因分析

task #377 的传播链本身完整：`responsePresentation=silent_receipt` 会经过 Connector 的直连/排队路径，route 层持久化为 `extra.scheduler.hiddenReceipt=true`，Redis parser 与 Web visibility 也都保留和消费该字段。

真正缺口在协议入口。`reminderTemplate` 只识别以 `window-primer:` 直接开头的消息，而生产配置把目标猫的 `@mention` 放在 marker 前。现有测试同样只用了无 mention 的理想化样本，导致入口条件与生产 payload 漂移未被发现。

### 4. 修复方案

把 primer 判定扩展为：消息开头允许一个目标 `@mention`，随后必须紧接 `window-primer` 与中英文冒号。正则仍保持行首锚定，不允许正文任意位置命中。

同时补齐两项闭环：服务端 unread predicate 明确排除 `hiddenReceipt`；把本次已落库的三条逃逸按精确 ID 加入 task #377 的同一临时兼容表，不做任何正文文本匹配。

### 5. 验证方式

- 红测：新增生产形态 fixture 后，目标断言从 `undefined` 失败，证明缺陷可复现。
- 绿测：`@研究生 window-primer：...` 与 `@gpt52 window-primer: ...` 均得到 `responsePresentation=silent_receipt`。
- 负例：`复盘 window-primer: ...` 与 `@研究生 请复盘 window-primer: ...` 继续没有 silent presentation。
- API 目标回归 29/29、Web visibility 8/8；API build/lint、Web production build、目标 Biome 与 `git diff --check` 均通过。
- 扩展后独立复审结论：P0/P1/P2=0，建议 PASS；三个 live 精确 ID 已逐条锁测试。

## 非阻断风险

- 识别仍依赖稳定的 `window-primer:` 协议标记；若以后 scheduler 改为结构化 task kind，应迁移到结构化字段并删除文本识别。
- callback-first publication 目前仍缺少从 invocation policy 到 callback persistence 的结构化 presentation 桥；本次 live 三条均为 stream persistence，不是当前根因。该链路需要单独的 invocation/callback 合约红测，不在本次小补丁中做半套 metadata augment。
- 三条历史 ID 与 task #377 原有七个兼容 ID 共用 retention TODO，老化出 default-thread 保留窗口后应一起删除。
