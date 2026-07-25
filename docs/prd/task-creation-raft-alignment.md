---
title: PRD——任务创建对齐 Raft 模式（平台退出猜测，猫判断+人声明）
doc_kind: prd
created: 2026-07-25
status: 已批准并实施（2026-07-25）
feature_ids: [F194]
topics: [task, admission, raft-replication, sop]
---

# PRD：任务创建对齐 Raft 模式

> 一句话：**平台不再替猫猜"这是不是活"**。建任务只剩两条路——人类显式声明（As Task / 右键转任务），猫自主判断后认领（claim）。宁可漏建，不可滥建。

## 1. 背景与问题

- 现状有**三条**建任务路径并存：
  1. **平台分类器自动建**（F194 `classifyWorkAdmission`：消息进来先按形态猜"像不像活"，像就建任务卡+讨论分支）——Raft 访谈实证这是反模式，我们自己也付过学费（碎片垃圾票 9 条挂 18 天、in_review 堆积 55%）；
  2. 人类显式：As Task 勾选 / 右键 Convert to Task；
  3. 猫工具：`cat_cafe_task_claim(messageId)` 原子转任务（批次 2-C 已就绪，但目前很少被用到，因为平台总是抢先建好了）。
- Raft 的实证模式：判断力在 agent（"需要回复之外的动作才认领"），平台只提供机制（原子 claim、防重复、状态机）。**平台猜测和猫判断并存时，猫的判断力永远练不出来**——平台先建了，猫只剩执行。

## 2. 目标 / 非目标

**目标**
- G1 平台分类器**退出任务创建**：不再因"消息长得像活"自动建任务；
- G2 猫按 SOP 纪律 1（已更新灰区判据）自主 claim——这成为唯一的"自主建"路径；
- G3 人类显式路径保持不变且体验不降级；
- G4 一键可回退（env 开关保留旧行为）。

**非目标**
- in_review 闭环（验收人+超时）→ 批次 4 独立立项；
- thread-first 回复路由不动（与任务创建是两层，轻量豁免已单独上线）；
- 无主任务唤醒抢单机制不动（唤醒源仍是"无主任务出现"，与谁建的无关）。

## 3. 改造方案

### 3.1 行为对照表

| 消息场景 | 现状 | 改造后 |
|---|---|---|
| 人类 @猫 提需求（形态像活） | 平台自动建任务卡+分支 | **不自动建**。猫收到后按纪律判断：要动手→`task_claim(messageId)` 原子转任务（任务卡+讨论分支随 claim 产生）；只回答→纯回复 |
| 人类 @猫 问问题/闲聊 | 分类器判 reply_only（偶有误判建卡） | 一定不建（平台路径整个不存在了） |
| 人类勾 As Task 发送 | 强制建任务 | 不变 |
| 人类右键 Convert to Task | 转任务 | 不变 |
| 猫拆子票 | `task_create`（查重） | 不变 |
| 定时任务(scheduler)投递 | 不建任务 | 不变 |

### 3.2 技术改动（最小爆炸半径）

1. `messages.ts` 的 `autoTaskDecision` 门：`isAutoTaskThreadRoutingEnabled` 判定为真时才走分类器建任务——**把全局 env `CLOWDER_AUTO_TASK_THREAD_ROUTING` 从 true 翻成 false**（pm2 保存 env + ecosystem 文档同步），并将该 env 语义在注册表中标注为"legacy 回退开关"。频道白名单 env（`CLOWDER_AUTO_TASK_THREAD_THREADS`）保留——个别频道想要旧行为可单独开。
2. **代码零改动优先**：若验证发现分类器还承担"As Task 的标题生成/脱敏"等复用职责，保留分类器代码本身，只掐"自动触发"这一个入口。
3. 猫侧无需新代码：`cat_cafe_task_claim(messageId)` 与防重复（subjectKey 查重、409 带 ownerCatId）已就绪；SOP 纪律 1（含灰区判据、方案先行勿即派工）已发布。

### 3.3 上线与回退

- 上线 = env 翻转 + api 重启（`/restart-clowder` 普通重启即可，无需构建）；
- 回退 = env 翻回 true 再重启，零代码回滚；
- 观察窗口 3 天：看任务板新增票的"发起方分布"（人类声明 / 猫 claim / 拆票）与漏建投诉。

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| 猫不主动 claim → 活没人记账（漏建） | Raft 哲学明确接受：人可以补建（As Task/右键成本一次点击）；SOP 已含判据；观察窗口盯漏建率 |
| 用户习惯了"发需求自动出任务卡"的体感 | 体感变化=任务卡晚几秒出现（猫判断后 claim 时才出）且更准；如果 3 天后觉得不行，一键回退 |
| 个别高频工作频道希望保留自动建 | 频道白名单 env 保留，可逐频道开旧行为 |

## 5. 验收标准（AC）

- AC1 默认配置下，发一条"帮我修 XX"的 @消息：平台不建任务；猫 claim 后出现任务卡，卡锚定原消息、讨论在其分支 thread；
- AC2 发一条"这是什么意思？"：无任务产生，猫内联/thread 回复（按 thread-first 规则）；
- AC3 As Task / 右键转任务行为与现状逐字节一致；
- AC4 env 翻回 true 后行为回到现状（回归测试保护）;
- AC5 现有 thread-first-routing / work-admission 测试全绿，golden 不破。

## 6. 实施修正（2026-07-25）

实施前调研（动手前的"确认翻 env 即可掐断自动建任务入口"这一步）发现 §3.2 的原始技术方案**前提不成立**，本节如实记录发现的问题、扩大后的实际改动范围、以及最终语义，供事后审计。

### 6.1 发现的第二调用点

`classifyWorkAdmission` 在 `packages/api/src/routes/messages.ts` 里有**两个**调用点，而 §3.2 只分析了其中一个：

1. **`autoTaskDecision` 门**（原方案分析的那个，:879 附近）：正确地被 `isAutoTaskThreadRoutingEnabled(resolvedThreadId)` 门控；但它有前置条件 `!executionRoute`——只在消息未被 thread-first / explicit-cross-thread 路由接管时才会执行。
2. **"decorative task-card judgment" 调用点**（:836-839 附近，批次2 commit `6ece9b09` 于 2026-07-24 引入）：位于 thread-first 路由分支内部，注释写的是"never gates routing above"，实现上对 `!asTask` 的情形**无条件**调用 `classifyWorkAdmission`，完全不检查任何 env 开关。

2026-07-24 铲屎官拍板 `CLOWDER_THREAD_FIRST_DEFAULT=1` 后，thread-first 对所有非 DM、非分支的常规频道默认开启——也就是说调用点 2 才是覆盖绝大多数生产流量的**实际主入口**，调用点 1（原方案唯一分析的对象）反而只覆盖 DM / 消息分支 / 未开 thread-first 频道这类少数情形。若只翻转 `CLOWDER_AUTO_TASK_THREAD_ROUTING`，常规频道里"@猫 帮我修 XX"依然会被调用点 2 自动建卡，AC1/AC2 不达成。

现有测试 `test/thread-first-routing.test.js`（改动前的 :209）本身就把这个行为断言为"预期"（"the classifier still fires as a decorative task-card judgment"），证实这不是巧合而是当时有意为之的设计，只是与本 PRD 的目标（G1）冲突。

### 6.2 扩大后的实际改动范围

铲屎官确认：PRD 批的是行为契约（G1/AC1/AC2），§3.2"代码零改动优先"是手段偏好而非目标本身，前提不成立时按目标走。因此实际改动比 §3.2 描述多了一处：

- `messages.ts` 调用点 2 的 `!asTask` 分支同样挂上 `isAutoTaskThreadRoutingEnabled(resolvedThreadId)`：关闭时该分支的 `cardDecision` 直接取 `reply_only` 语义，跳过 `classifyWorkAdmission`——**只跳过建卡**，thread-first 的路由本身（锚点分支创建、回复投递）不受任何影响。`asTask` 分支（`forceCreateFromMessage`）一个字未动。
- `test/thread-first-routing.test.js` 原来断言"必建卡"的单一用例，改写为三态覆盖：① 默认（两个 env 都关）→ 不建卡，锚点分支路由照常；② `CLOWDER_AUTO_TASK_THREAD_ROUTING=true`（全局回退）→ 建卡；③ `CLOWDER_AUTO_TASK_THREAD_THREADS` 命中该频道（按频道回退）→ 建卡。

### 6.3 最终语义：两个调用点共用同一开关

`CLOWDER_AUTO_TASK_THREAD_ROUTING` / `CLOWDER_AUTO_TASK_THREAD_THREADS` 现在是**两个** `classifyWorkAdmission` 调用点共用的单一开关——语义变为"平台分类器自动建任务"这一整条能力的总闸，而不再只是 thread-first 上线初期的"频道级路由金丝雀"名义。默认（两个 env 都不设）= 关闭，两个调用点都不会自动建任务卡；`ROUTING=true` = 全局恢复旧行为；`THREADS` 命中 = 仅该频道恢复旧行为。回退方式不变：任一 env 翻回旧值 + 重启 api，零代码回滚（因为门控逻辑本身保留在代码里，只是默认值变了）。
