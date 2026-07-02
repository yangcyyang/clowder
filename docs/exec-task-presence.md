---
feature_ids: []
topics: [task, ux, presence, execution-plan]
doc_kind: spec
created: 2026-06-28
author: 专家-Claude
status: proposed
context: "Task 存在感优化执行方案 — 对齐 Raft 的任务体验"
---

# 执行方案：Task 存在感优化

> **问题**：Clowder 的 task 存在感弱——感觉"没用起来"。
> **根因（已查证）**：不是缺功能（数据模型比 Raft 还丰富），而是 task 没活在对话流里 + 缺主动触达 + 大量结构化数据被藏起来。
> **目标**：对齐 Raft 已验证好用的朴素做法，让 task 从"要去查的归档柜"变成"一直在眼前的工作台"。
> **执行者**：@老者-codex。**验收**：@专家-Claude。
> **前置**：快车道改造 1 收尾后再开工（yangcyyang 已定先做完快车道）。

## 0. 分析依据（已查证的事实）

| 事实 | 查证位置 |
|---|---|
| inline badge 只渲染色点 `#3`，状态文字藏 hover | `ChatMessage.tsx` `MessageTaskBadge`（~L75） |
| API 只有 `GET /api/tasks?threadId`，无 by-owner/全局 | `routes/tasks.ts`（L203） |
| TaskStore 只有 `listByThread` / `listByKind` | `stores/ports/TaskStore.ts`（L131/145） |
| task 广播是 thread 作用域 `thread:${threadId}` | `routes/tasks.ts`（L209/290） |
| push 服务零 task 引用，in_review 不触达 | `PushNotificationService.ts` |
| 无 dueDate / priority 字段，无时间维度 | `shared/src/types/task.ts`（TaskItem） |
| done 任务会 eviction 淘汰 | `stores/ports/TaskStore.ts`（evictOldest） |
| 已有 LLM TaskExtractor（4-A），可自动抽任务 | `orchestration/TaskExtractor.ts` |
| 已有 linkify 模式可扩展给 task #N | `MarkdownContent.tsx` `linkifyFilePaths` |

## 1. 对齐 Raft 的 4 条原则（设计总纲）

1. **task = message**：状态长在消息上、活在对话流里，不是独立面板。
2. **claim-before-work**：动手前先 claim，板自动反映真实工作。
3. **状态迁移有播报 + 通知**：每次 claim/in_review/done 留痕并主动触达。
4. **task #N 全局可点**：任意位置引用都能跳转。

## 2. 分阶段实施（按杠杆排序，低风险先行）

### Phase A：呈现层快赢（纯前端，低风险，先做）
对应缺口：③Surfacing ⑦Traceability ⑤Salience | Raft 原则 1、4

1. **inline badge 升级**：`MessageTaskBadge` 从色点 `#3` 改成带状态文字 `task #3 · 待验收`，文字 + 颜色双编码；in_review 用最醒目色。
   - 落点：`ChatMessage.tsx`
2. **task #N 全局可点**：在 `MarkdownContent` 的 linkify 链路里加 `task #N` token，渲染成可点链接，跳到对应任务/线程。
   - 落点：`MarkdownContent.tsx`（复用 linkifyFilePaths 模式）
3. **inline 露出关键上下文**：badge 旁补极简元信息——失败过几次（retryOf）、是否子任务（parentTaskId）、证据数。只露最高价值的 1-2 个，不堆砌。
   - 落点：`ChatMessage.tsx`

**验收**：消息上一眼能看到任务号 + 状态文字；正文里的 task #N 可点跳转；不破坏现有布局。

### Phase B：主动触达 + 聚合（最高杠杆，核心）
对应缺口：⑥Notification ④Aggregation | Raft 原则 3

1. **in_review 主动触达**：task 状态进入 in_review 时，给"该验收的人"发通知（接 PushNotificationService + inbox 信号）。这是最痛点。
   - 落点：`PushNotificationService.ts` + task 状态迁移处（`routes/tasks.ts` 的 task_updated）
2. **跨频道"我的任务"聚合**：
   - 后端加 `listByOwner` / `listOpenForUser`（store + 新 API endpoint），打破只能 by-thread 的限制。
   - 前端加一个全局"我的任务"入口，默认聚焦"等我验收 + 进行中"。
   - 落点：`TaskStore.ts`（加查询）+ `routes/tasks.ts`（加 endpoint）+ 前端新面板
3. **广播范围**：task 变更广播除了 `thread:${threadId}`，补一个面向 owner/相关人的投递，否则跨频道聚合收不到实时更新。
   - 落点：`routes/tasks.ts` 广播逻辑

**验收**：agent 把任务切 in_review 时，对应的人能被主动通知到；有一个地方能看到跨所有频道"等我的事"；状态变更实时同步。

### Phase C：捕获（让板反映真实工作）
对应缺口：①Capture | Raft 原则 2

1. **agent 工作自动登记 task**：agent 接活时自动创建/关联 task（claim-before-work），不再纯靠人手动转。
   - 与快车道的"agent 状态 ↔ task 状态联动"是同一件事，复用那套。
   - 落点：QueueProcessor / invocation 链路 + 可选启用 TaskExtractor
2. **配套降噪**：自动捕获必须带去重 + 好标题 + 相关性过滤，否则越自动越乱（见 Phase D）。

**验收**：agent 实际在干的活能在板上看到；不产生重复/垃圾任务。

### Phase D：降噪 + 角色过滤（让"对的"任务显眼）
对应缺口：②Attribution 负存在感 双受众

1. **按角色/相关性过滤**：人默认看"等我决策/验收"，agent 看"可 claim / 我的"。pr_tracking 等自动任务默认折叠。
   - 落点：TasksPanel / 聚合面板的过滤逻辑
2. **排序**：等我验收 > 进行中 > 阻塞 > 待办 > 已完成；done/pr_tracking 不抢眼。

**验收**：板上第一眼是"真正需要关注的"，噪声任务不干扰。

### Phase E（可选，later）：时间维度 + OS 级 + 任务树
对应缺口：⑤Salience ⑧Closure 关系层 + OS

1. 数据模型加 `dueDate` / `priority`，支持按紧迫度排序、aging 提醒。
2. Electron dock/tray 待办角标 + 打开首屏任务摘要。
3. 任务树可视化（parent/retry/branch）。
4. 接 reminder：每日 digest"今天 N 个待办、M 个等你验收"。

## 3. 推进顺序与依赖

```text
快车道改造 1 收尾
  → Phase A（前端快赢，独立可发）
  → Phase B（核心，最高杠杆）   ← 最该优先做的一段
  → Phase C（捕获，依赖快车道的 agent状态↔task联动）
  → Phase D（降噪，依赖 C 的自动捕获）
  → Phase E（可选增强）
```

- A 和 B 没有强依赖，A 可先发快赢；但**B 是真正解决"存在感弱"的核心**。
- C 依赖快车道那套 agent 状态联动，所以排在快车道之后顺理成章。

## 4. 通用验收原则

- 每个 Phase 独立可验收、独立可发布。
- 每个 Phase 完成拉 git diff 给 @专家-Claude 审。
- 不破坏现有 task 数据 / 现有线程板行为（零回归）。
- 前端改动必审实际渲染效果（截图或本地验证），不只看文字报告。

## 5. 不做什么

- 不一次性全做，按 Phase 走，A/B 先落地见效。
- 不在 Phase A/B 改数据模型（dueDate/priority 留到 E）。
- 不引入外部任务系统（Linear/GitHub）双向同步，超范围。
