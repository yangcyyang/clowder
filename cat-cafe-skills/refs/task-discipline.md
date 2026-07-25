---
title: Task Discipline — 十条纪律（Raft 对标）
doc_kind: reference
created: 2026-07-24
feature_ids: [F194]
topics: [task, thread, raft-replication, sop, memory, search]
---

# Task Discipline — 十条纪律

> 来源：docs/research/clowder-raft-thread-task-design.md §5.2 / §5B.1-5B.5（Raft agent 系统提示词原文 + 一手实证）。
> 平台机制（claim 原子性、状态枚举、thread 隔离）不会替你判断——判断力住在这份纪律里，配合 batch 2-C 新增的
> `cat_cafe_task_*` / `cat_cafe_reply_in_thread` / `cat_cafe_search_messages` 工具执行。

## 1. 动手才建（claim/create 只为"要动手"的事）

只有当满足一条消息需要"动手"（跑工具、写代码、改东西）而不只是回复时，才认领/创建任务。纯粹回答问题或聊天不需要建任务——建了反而污染任务面板、把回复路由到错误的地方。

**为什么**：Raft 原文——"if fulfilling a message requires you to take action beyond just replying (running tools, writing code, making changes), claim the message first. If you're only answering a question or having a conversation, no claim needed."

**灰区判据**（第五轮访谈实证）：为了回答而做的**只读查证**（查日志、读代码、搜历史）算"回答"，不建任务——"回答"天然包含取证。只有会留下副作用（改代码/部署/改数据）或产生需要验收的交付物才建。

**方案先行，勿即派工**：探讨/方案阶段即使聊的就是活，也不在探讨阶段建任务——等 owner 明确一句 go 再转。讨论收敛出可执行工作后**另立顶层任务**（thread 内的讨论消息不转任务，与"任务不嵌套"规则同构）。宁可漏建（人可以补建），不可滥建（垃圾票稀释整个任务板的可信度）。

**工具**：判断"要不要建"是你（猫）的判断层职责，工具只提供机制——`cat_cafe_task_create` / `cat_cafe_task_claim`。

## 2. 先领后干；领不到就走开

开工前第一动作永远是 claim。Claim 失败（409，别人已认领）说明别人在做，**不要**去做同一件事，除非 owner/铲屎官明确改派给你。这不是"先到先得"的礼貌问题，是并发正确性问题——两只猫同时干一件事，产出会冲突且浪费。

**为什么**：Raft CRITICAL 原文——"Always claim a task before starting work. If the claim fails, do not work on that task unless an owner/admin explicitly redirects it to you."

**工具**：`cat_cafe_task_claim`（taskId 或 messageId 两种形式）；409 响应带 `ownerCatId`，据此判断谁已经在做。

## 3. 已有消息别新建——改 claim

如果这个工作项已经以一条消息的形式存在（铲屎官发的指令、别的猫报的 bug），直接 claim 那条消息/任务，不要另建一个新任务。重复建任务 = 任务面板里出现两条指向同一件事的记录，谁都不知道哪条是权威的。

**为什么**：Raft 原文——"If someone already sent the work item as a message, just claim that existing message/task instead of creating a new one."

**工具**：`cat_cafe_task_claim(messageId=...)` 把消息原子性地转成任务并认领；`cat_cafe_task_create` 传 `subjectKey` 时会先查重，命中会返回 `status:"existing_task"` + hint 提示改用 `task_claim`，不会静默建重复任务。

## 4. 拆分三规则

需要把一件大事拆成子任务时：
1. **有依赖就按阶段分组**（phase），不要拆成一堆互相卡着的碎片；
2. **优先拆成互不阻塞的独立子任务**；
3. **避免拆出顺序链**（A done 才能 B 开始才能 C 开始……）——这种链条一个环节卡住全链停摆。

拆出的子任务默认**不认领**（unowned todo），留给别人认领——不要自己把所有子任务全部领走，那样"分工"变成了"一个人假装分工"。

**为什么**：Raft 原文——"Group by phase if tasks have dependencies / Prefer independent subtasks that don't block each other / Avoid creating sequential chains." 子任务默认 unowned "for others to claim"。

**工具**：`cat_cafe_task_create` 不传 `ownerCatId` 即为 unowned todo；用 `parentTaskId` 挂到父任务上。

## 5. 来源在哪回哪

回复任何消息时，永远复用收到消息的原始目标（thread/task），不要凭感觉挑一个"看起来合适"的地方。工作进度/结果汇报必须进对应任务的 thread，不是主频道。允许上主频道的例外只有三种：①源消息本来就在主频道的对话 ②给 owner 的整批进度/决策请求 ③与任何 thread 都无关的新事项。

**为什么**：Raft 原文——"To reply to any message, always reuse the exact target from the received message" + "Post updates in the task's thread."

**工具**：`cat_cafe_reply_in_thread(messageId, content)`——按消息锚定路由到它对应任务的 discussion thread；如果这条消息还没被转成任务、没有对应 thread，会明确报错（`NO_ANCHORED_THREAD`）而不是猜一个地方发出去。

## 6. 完成先 in_review 贴证据，人验过才 done

任务做完不能直接跳到 `done`。先把状态改成 `in_review` 并附上证据（测试输出/diff/截图/sha），等人验证通过（哪怕只是一句"looks good"）再置 `done`。`done` 是终态，不支持再改。

**为什么**：Raft 原文——"完成先置 in_review，人验过才 done"（design doc §5.2 rule 6）；与 §5B.4 的"完成贴证据"三拍同构：开工报一句 → 节点报状态 → **完成贴证据**。这也是 Cat Cafe 既有纪律"Done requires evidence"的具体落地。

**工具**：`cat_cafe_task_update` 服务端校验合法迁移——非 `in_review` 状态直接跳 `done` 会被拒绝（`ILLEGAL_STATUS_TRANSITION`），逼着你走 in_review 这一步。

## 7. 搜索优先于瞎答；搜不到要明说

有人引用一段你上下文里没有的历史讨论/决策时，**先搜索**（关键词搜 + msg-id 二跳读原文），找到原始 thread/决策/owner 再回答；不要凭印象编。搜索确实找不到时，**明确说"没搜到"**，不要装作知道。

**为什么**：Raft 原文（design doc §5B.5）——"有人引用历史讨论而上下文里没有→先 search+read 找到原始 thread/决策/owner 再答；找不到要明说。" 三方分工：记忆=蒸馏结论，搜索=原文与证据，问人=只有 owner 脑子里有的——三者不能互相顶替。

**工具**：`cat_cafe_search_messages(q, threadId?, catId?)` 做第一跳（关键词 + 相关度排序，返回 msg-id + 来源 thread + 内容片段），然后用 `cat_cafe_get_thread_context` / `cat_cafe_fetch_thread_history`（带 threadId/fromMessageId/toMessageId）做第二跳读全文。**注意**：这是关键词匹配，不是语义搜索——搜不到不代表不存在，多换几个关键词再确认。

## 8. 记忆结论带 msg-id 面包屑

往 `.cat-cafe/memory/{catId}.md` 或 notes/ 写结论时，附上产生这个结论的 msg-id（例如"已报 yangcyyang(858e3680)"）。下次需要验证这个结论时，直接用 msg-id 二跳读原文，不必重新搜索。

**为什么**：Raft 原文（design doc §5B.5）——"msg-id 面包屑直达"是 agent 使用频率最高的检索方式，排在关键词搜索之前；"关键词依赖的短板靠面包屑纪律绕过——不算搜索强，是纪律兜着"。没有面包屑，结论就是孤证，没法回去核实。

**工具**：`cat_cafe_search_messages` 返回的每条命中都带 msg-id；记忆写入沿用现有 `cat_cafe_retain_memory_callback` / notes 文件手写 msg-id 引用。

## 9. 长任务开工前先写 Active Context

预计要跑很久、会经历上下文压缩的任务，**开工前**先把目标/已完成项/当前聚焦写进 MEMORY.md 的 Active Context 段。压缩本身无害，没有落盘的"脑内状态"才会真的丢。关键节点（决策、阶段性产出）必须发一条 thread 消息存档——thread 是事件真相源，永不因压缩而丢，MEMORY 只是状态快照，两层互备。

**为什么**：Raft 原文（design doc §5B.2）——"事前写 Active Context，压缩本身无害，没落盘的脑内状态才会丢"；"thread 当进度存档——频道=事件真相源，MEMORY=状态快照，两层互备"。

**工具**：Active Context 写入沿用现有 MEMORY.md 索引机制；关键节点用 `cat_cafe_post_progress`（heartbeat）或 `cat_cafe_task_update`（why 字段）落盘，msg-id/taskId 就是回拉锚点。

## 10. 停手前清欠

一轮工作结束、要停手之前，检查是否欠着别人一个"阻塞项"（别人在等你的判断/产出）。欠着就必须发一条**最小可动作**的消息说清楚现在卡在哪、需要什么。没有可动作内容就不要硬发消息刷屏；只在被 @ 时才插嘴讨论题。

**为什么**：Raft 原文（design doc §5B.3）——Ping 纪律三条："停手前欠着谁的阻塞项必须发一条最小可动作消息 / 无可动作内容不发（禁刷屏）/ 只在被 @ 时插嘴。" 目的是让"没读 ≠ 没活"这件事对下一个接手的人（猫或铲屎官）可见。

**工具**：`cat_cafe_reply_in_thread` / `cat_cafe_cross_post_message` 发最小可动作消息；`cat_cafe_task_unclaim` 明确放手（附 why）而不是悄悄消失。

## 速查表

| # | 纪律 | 违反的后果 | 主要工具 |
|---|------|-----------|---------|
| 1 | 动手才建 | 任务面板被问答类噪音污染 | `task_create` / `task_claim` |
| 2 | 先领后干，领不到走开 | 双人重复工作、产出冲突 | `task_claim`（409 冲突） |
| 3 | 已有消息别新建 | 同一件事两条记录，权威性混乱 | `task_create(subjectKey)` 查重 |
| 4 | 拆分三规则 | 顺序链一环卡死全链 | `task_create(parentTaskId)` |
| 5 | 来源在哪回哪 | 回复进错地方，owner 看不到 | `reply_in_thread` |
| 6 | 完成先 in_review | 未经验证的"done"污染信任 | `task_update`（迁移校验） |
| 7 | 搜索优先于瞎答 | 凭印象编造过时/错误结论 | `search_messages` + 二跳 |
| 8 | 记忆带 msg-id 面包屑 | 结论无法回溯核实 | `search_messages` 返回 msg-id |
| 9 | 长任务先写 Active Context | 压缩后断片，重复劳动 | MEMORY.md + `post_progress` |
| 10 | 停手前清欠 | 阻塞项无人知晓，链路卡死 | `reply_in_thread` / `task_unclaim` |
