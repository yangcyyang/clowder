# Clowder Slock-like Agent Protocol

## 目标

Clowder 的 Agent 运行要从“收到一条消息就直接触发模型”升级为 Slock-like 的成熟秘书协议：

```text
收件 → 归类 → 合并最新意图 → 判断讨论/任务 → claim → 执行 → 交付 → 验收
```

这份协议是 task #180 / #181 / #182 的上游规则文档：先固定行为边界，再分别落到 inbox、阶段门禁和执行闭环审计。

## 背景问题

Clowder 现有能力已经补齐了很多底座：

- task discipline 提示注入
- Clowder CLI task/message 命令
- thread 归属与回复隔离
- toolPolicy 工具箱分层
- contextBudget 诊断与裁剪
- Agent 可取消与阶段进度展示
- 跨会话 memory 与 reminder

但它仍偏“聊天触发模型”：

- Agent 常只处理触发它的那一条消息。
- 用户连续补充时，Agent 容易按旧消息开始执行。
- 长流程 Agent 容易跳过确认门禁。
- task claim / evidence / in_review 主要靠提示约束，缺少统一审计协议。

Slock 的优势不是模型更强，而是消息协议更稳：每条消息有明确 surface，Agent 有 inbox freshness，任务有 claim/in_review 纪律，thread 不污染主频道。

## 核心概念

### Surface

Surface 是一次对话发生的位置：

- channel
- thread
- DM
- connector thread（微信、飞书等 IM 映射出的 thread）

Agent 只能默认读取当前 surface，不应跨频道扫描历史。

### Inbox Window

Agent 被唤醒时，需要读取当前 surface 中尚未处理的用户消息窗口，而不是只看触发消息。

建议窗口：

- 普通 thread：最近 20 条未处理/相关消息
- 长 thread：最近 20 条 + thread digest
- connector DM：最近 10 条

### Intent Snapshot

Intent Snapshot 是同一 surface 当前最新任务理解。

它不是简单拼接消息，而是要合并用户连续补充，并处理覆盖关系：

- 后发的“先别做”覆盖前面的“开始做”。
- 后发的“换成 HTML”覆盖前面的“导出 PPT”。
- 同一主题补充材料应合并到当前阶段输入。

### Task Gate

当用户消息是行动任务时，Agent 必须进入 task gate：

```text
识别 action intent
  → 绑定/创建 task
  → claim task
  → 执行
  → 写入交付证据
  → 标记 in_review
```

没有 claim，不应写文件、改代码、启动构建或声称完成。

### Stage Gate

长流程 Agent 必须按阶段推进。典型如 PPT Agent：

```text
需求收集
  → 需求确认
  → 大纲生成
  → 大纲确认
  → 策划稿生成
  → 策划稿确认
  → 设计初稿
  → 调整
  → 导出
```

每一阶段的产物采用三件套：

```text
*.md    给人阅读和编辑
*.json  给系统执行，作为真相源
*.html  给用户预览和确认
```

用户未确认当前阶段，不进入下一阶段。

## 运行协议

### 1. 收件

Agent invocation 创建前，后端应解析当前 surface：

```text
threadId / channelId / dmId
triggerMessageId
catId
lastProcessedCursor(catId, surfaceId)
```

然后读取：

```text
newMessages = messages after lastProcessedCursor in same surface
```

如果没有 cursor，回退为最近 N 条消息，但必须限制在当前 surface。

### 2. 归类

对 Inbox Window 内消息做轻量分类：

- discussion：解释、方案、询问、确认
- action：修复、构建、执行、导出、检查、排查、推进
- correction：先别做、等等、换方向、不是这个
- approval：确认、可以、开始做、按这个来
- stage-input：补充资料、补充要求、改大纲、调整策划稿

分类结果进入 Intent Snapshot。

### 3. 合并最新意图

合并规则：

1. 同一 surface 内，后发 correction 优先级最高。
2. approval 只对最近一个待确认阶段生效。
3. action 需要 task gate。
4. stage-input 只更新当前阶段缓冲区，不自动越级执行。
5. 多个独立 action 应拆成多个 task，而不是塞进一次 invocation。

输出结构建议：

```json
{
  "surfaceId": "thread-123",
  "triggerMessageId": "msg-456",
  "intentType": "action | discussion | correction | approval | stage-input",
  "latestInstruction": "用户当前最新指令",
  "supersededMessageIds": ["msg-old"],
  "requiresTask": true,
  "requiresUserConfirmation": false,
  "stage": "outline_review",
  "toolPolicyHint": "minimal | standard | full"
}
```

### 4. 判断讨论还是任务

如果是 discussion，Agent 直接回复，不 claim。

如果是 action，必须走 task gate。

触发 action 的关键词包括但不限于：

- 修复
- 推进
- 执行
- 构建
- 导出
- 检查
- 排查
- 改造
- 写入
- 备份
- push
- 你来做

### 5. 执行与交付

执行任务时，Agent 输出必须包含验收证据：

- 代码类：commit、文件、测试命令、测试结果
- 文档类：文档路径、关键内容、决策摘要
- PPT 类：MD / JSON / HTML / PPTX 产物路径
- 调研类：来源、结论、风险

如果不能执行，必须明确 BLOCKED，并说明缺什么。

### 6. Cursor 更新

一次 invocation 完成后，应更新：

```text
lastProcessedCursor(catId, surfaceId) = max processed message seq
```

如果任务被取消，不应把未处理消息全部吞掉。取消时只标记当前 invocation 消费到的 cursor。

## 与现有模块的关系

### toolPolicy

本协议不替代 `toolPolicy`。二者关系是：

```text
Intent Snapshot 决定要做什么
  → toolPolicy 决定背多少上下文和工具
```

默认建议：

- discussion / short answer：minimal
- coding / debugging：standard
- PPT / UI / design / research-heavy：full

用户显式说“轻度工具箱 / 标准工具箱 / 重度工具箱”时，以用户覆盖为准。

### contextBudget

`contextBudget` 用于展示和限制本次调用背了多少内容。

本协议要求：Inbox Window 和 Intent Snapshot 必须计入 contextBudget，方便用户知道 Agent 是否背了过多历史。

### memory / reminder

memory 是长期偏好，不应替代当前 surface 的 inbox。

reminder 是未来唤醒，不应跳过 inbox freshness。提醒触发后仍要读取当前 surface 最新消息，避免基于过期状态行动。

### task board

task board 是行动任务的状态源。

任何 action intent 都应该绑定 task，且 task 线程是任务交付证据的主要承载位置。

## 分阶段落地计划

### Phase A：协议文档

对应 task #183。

交付：

- `docs/agent-runtime/slock-agent-protocol.md`
- 明确 inbox、intent snapshot、task gate、stage gate、cursor、验收证据规则

验收：

- 后续 task #180/#181/#182 能直接引用此文档执行。

### Phase B：Agent Inbox + 最新意图合并

对应 task #180。

建议实现：

- 新增 `AgentInboxService`
- 维护 per-cat per-surface cursor
- invocation 前生成 `IntentSnapshot`
- 将 snapshot 注入 Agent system/user context

验收：

```text
用户连续发：
1. 开始做
2. 等等，先别做
3. 先给方案

Agent 最终只给方案，不执行代码。
```

### Phase C：长流程阶段门禁

对应 task #181。

建议实现：

- 新增 thread-level `stageState`
- 支持 `stageBuffer`
- approval 才推进 stage
- PPT Agent 先接入三件套产物协议

验收：

- 未确认大纲不能生成策划稿。
- 未确认策划稿不能生成设计稿。
- 用户补充资料只更新当前阶段输入。

### Phase D：执行闭环审计

对应 task #182。

建议实现：

- 检查 action intent 是否绑定 task
- 检查 task 是否被 claim
- 检查 in_review 是否有 evidence
- 对违规 Agent 生成审计告警

验收：

- Agent 只说“我正在做”但没有证据时，不能进入 in_review。
- 代码任务没有 commit/test 结果时，提示缺交付证据。

## 非目标

本轮不做：

- 重写全部 routing。
- 让所有 channel 自动广播给所有 Agent。
- 把 Slock daemon 原样搬进 Clowder。
- 取消现有 toolPolicy / contextBudget / memory 机制。

本轮只补“成熟秘书协议”：先收件、合并、确认，再执行。

## 风险与约束

### 风险 1：过度自动合并导致误判

缓解：Intent Snapshot 必须可见，可在运行详情里展示“本次理解”。

### 风险 2：task 自动创建过多

缓解：action intent 才绑定 task；discussion 不创建 task。

### 风险 3：长流程卡在确认门禁

缓解：UI 明确显示“等待用户确认”，并提供确认按钮。

### 风险 4：cursor 吃掉未处理消息

缓解：只有成功生成 Intent Snapshot 并完成/明确取消后才推进 cursor。

## 成功标准

Clowder 达到以下行为，即认为本协议第一版成功：

1. 用户连续补充时，Agent 能合并最新意图。
2. 用户撤销/修正时，Agent 不继续执行旧指令。
3. 行动任务必须 claim 后执行。
4. 长流程必须等用户确认再推进。
5. 所有执行任务有可验收证据。
6. thread 内消息不污染主频道。
7. 重启/取消后不会丢掉未处理用户消息。
