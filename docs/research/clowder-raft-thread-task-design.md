---
feature_ids: [F194]
topics: [thread, task, channel, routing, raft-replication, ux]
doc_kind: design
created: 2026-07-23
---

# 复刻 Raft 的 Channel-Thread-Task 体感：诊断与设计

> 目标体感（铲屎官原话）：问一个问题 / 创建一个任务时，自动产生 Task，回复内容进对应 Task 的 Thread，主频道保持干净。
> 证据来源：① docs.raft.build 全量文档调研（结论均附 URL）② 两个 F194 金丝雀 thread 的 Redis 真实数据取证 ③ 代码流程还原（文件:行号）④ Raft 真实 App 走查（app.raft.build，铲屎官自己的 cy-server 工作区）。

---

## 1. 最重要的认知修正：Raft 不自动建任务

调研前的预期是"Raft 会自主判定消息建 Task"。**文档证实这是误解**：

| 环节 | Raft 的真实做法 | 出处 |
|---|---|---|
| Task 产生 | **人显式创建**，三种方式：右键消息 Convert to Task / 发送时勾选 As Task / Create Task 按钮。系统绝不自动判定 | docs.raft.build/features/collaboration/tasks/ |
| Task 认领 | **自动**：agent 收到需要行动的消息就 claim，claim 失败（别人抢了）就走开，人不手动指派 | 同上 |
| 回复去哪 | **每个 task 天生自带 thread**（task 消息为锚点），讨论/进度/结果强制进 thread；"the task message shows the status; the thread holds the details" | 同上 |
| Thread 形态 | 完全 Slack 式：挂在消息下、侧面板打开、**不出现在侧边栏**、回复不回流主频道、禁止嵌套 | docs.raft.build/features/messaging/threads/ |
| 主频道留什么 | 原始消息 + task 编号 + 状态徽章（"The message carries a task number and a status"），完成时不发摘要消息，靠状态翻转 + Activity 通知 | docs.raft.build/divide-the-work/ |
| 通知 | follow 机制：参与/被 @ 自动 follow 该 thread → 新回复进 Activity + ping；做完 unfollow。"能等一小时的就不该 ping" | docs.raft.build/features/messaging/activity/ |

**所以"主频道干净"的根本机制不是"聪明的判定器"，而是两条铁律：**
1. **回复默认进消息锚定的 thread**（不管是不是任务）；
2. **任务是人显式声明的，声明之后一切执行痕迹强制进它的 thread**。

Raft 把"判断"留给人（一次点击），把"纪律"交给系统（强制收纳）。Clowder 现在正好相反：把"判断"交给正则判定器（猜不准），把"纪律"留给猫自觉（不遵守）。

## 2. Clowder 现状：为什么体感不好（真实数据）

F194 已实现"判定消息 → 建任务 → 建分支 thread → 回复改道"全链路，但金丝雀实测（thread_mrrmu5i66vxj55ia，真实使用）：

**数据：主 thread 30 条消息里，猫的长文回复 11 条共 34.3KB 全在主 thread；17 条用户消息仅 2 条命中建任务；用户在里面连发 4 条抱怨"为什么不在 thread 回我"，这些抱怨本身也被判定器放过。**

六个根因（按伤害排序，全部有代码证据）：

| # | 根因 | 证据 |
|---|---|---|
| 1 | **覆盖面错位**：判定器只收"明确工作指令"，问句被 QUESTION_DOMINANT_RE 主动排除——而用户要的恰恰是"问答也进 thread" | api/routes/work-admission.ts:103-112 |
| 2 | **命中后回复进"隐形 thread"**：任务分支不传 relation → 侧边栏过滤掉（ThreadSidebar.tsx:430）；thread_branched 事件 patch replyCount:0 → 源消息下的入口指示条永不渲染（ChatMessage.tsx:313 要求 >0）；用户没 join 分支 socket room → 流式回复零感知 | task-discussion-thread.ts:70; useChatSocketCallbacks.ts:121-126; useSocket.ts:428-535 |
| 3 | **无 @ 指令 = 静默黑洞**：建 todo 任务后直接 202 返回，不调猫、无可见痕迹（实证："帮我做个书籍分析"至今 todo 无人接） | api/routes/messages.ts:797-805 |
| 4 | **主 thread 无任何 task_created 反馈**：无系统消息、无卡片、不自动开面板，任务藏在 Tasks tab | useChatSocketCallbacks.ts:88-92 |
| 5 | **判定器动词表漏**："分析/回答/解释/看看"不在 DIRECT_ACTION_RE；"请在 thread 回答"反被长文规则排除 | work-admission.ts:52-64 |
| 6 | **手动分支复制全部历史进分支**（实测 17 条中 14 条重复），主 thread 不减反增 | thread-branch.ts:162-200 |

**一句话诊断：机制都在，但用户从任何一个界面都看不到它在工作——判定器管窄了，可见性链路断了三处，无主任务没人接。**

## 3. 设计：三步复刻

### 第一步 · 修可见性（天级，纯 bug 修复，立竿见影）

不改任何产品逻辑，先让已有机制"被看见"：

1. **入口指示条复活**：thread_branched 事件携带真实 replyCount；分支内新消息转发一份计数事件到主 thread room（用户不必 join 分支 room 也能看到"N 条回复"在涨）。
2. **建任务即时反馈**：命中 create_from_message 时，源消息下方立刻渲染内嵌条「已建任务 #123 · 回复将进入任务 Thread →」，点击打开 InlineThreadPanel；可选：命中即自动打开面板。
3. **无 @ 任务不再静默**：至少回一条可见系统消息「任务 #123 已创建，待认领」。
4. **分支 thread 补 relation 字段**（与手动分支对齐）——但**不是**为了在侧边栏显示（Raft 的 thread 不进侧边栏，现在的隐藏歪打正着），而是让数据模型一致、让"从任务卡跳分支"等入口可靠。
5. 顺手修：任务卡编号渲染 bug（79 卡 2 个编号，见前端评审 M4）。

验收：在金丝雀 thread 里发一条带 @ 的指令 → 3 秒内看到"已建任务"内嵌条 + 回复数实时上涨 + 点击能进 thread 看到流式回复。

### 第二步 · 换范式（周级，核心改动）

把"判定器决定进不进 thread"换成 Raft 铁律"**回复默认进 thread**"：

1. **频道级路由策略** `routingPolicy: thread-first`（Thread 对象已有 routingPolicy 字段，ports/ThreadStore.ts）：开启后，本频道内 @猫 的任何消息（问句也一样），猫的回复一律进该消息锚定的 thread；主频道只显示源消息 + 回复数。默认新频道开启，大厅可保持 main-flow。
2. **判定器退役**：classifyWorkAdmission 不再做语义判断（Raft 实证：平台层没有判定器，"要不要建任务"的判断力在 agent 层，见 §6）；服务端正则最多保留为"提示条"兜底。判断移交给猫：工具 + SOP（§6 抄作业清单）。
3. **显式任务补全**（对齐 Raft 三入口）：输入框 As Task 勾选（UI 已存在，接通到 admitWorkMessage 强制路径）+ 消息右键 Convert to Task + Tasks tab 内新建。
4. **任务消息带状态徽章**：主频道源消息上渲染「#123 · doing」徽章，状态翻转原地更新（socket 事件已有 task_updated 通道）。
5. **分支不复制历史**：新 thread 只放源消息 + 上下文引用链接（治根因 6）。

验收：thread-first 频道里问一个问题 @猫 → 主频道只有你的问题 + 回复数徽标，全部回复在侧面板；关掉 thread-first 的频道行为不变。

### 第三步 · 接 claim + Activity（周级，补"自主"）

用户要的"自主"其实是 Raft 的 claim 系统，Clowder 后端零件齐全：

1. **任务创建事件唤醒候选猫**：task_created → 按频道 preferredCats/roster 通知候选猫 → 猫用已有的 `claimIfUnowned`（Redis Lua CAS，RedisTaskStore.ts:352-377）抢单 → 抢到的置 doing 开工，回复进任务 thread。这一步把根因 3 的"静默黑洞"变成"自动有人接"。
2. **follow + Activity**：参与/被 @ 自动 follow 该 thread；follow 的 thread 有新回复 → 喂进 ActivityBar 的聚合收件箱（入口已存在）+ 未读徽标。任务状态变化同样入 Activity。
3. 通知纪律照抄 Raft："DM 必 ping、follow 的 thread 回复 ping、被 @ ping，其余进 Activity。"

验收：不 @ 任何猫发"帮我做个书籍分析" As Task → 30 秒内有猫认领并在任务 thread 开工，Activity 里能看到全程。

## 4. 与既有两份报告的关系

- 本方案 = Raft 能力分析报告 **Phase 4（Thread-Task 绑定）+ Phase 5（Inbox 与唤醒）** 的具体化与重排序：先修可见性（原计划没有，实测证明是最大痛点）、显式任务优先于判定器扩量（照抄 Raft 结论）、claim 提前（后端零件已齐）。
- 第一步的 5 个修复与前端评审的 M4（任务卡编号）、B1（排队可见性）同属"可见性欠账"，可并成一个批次。
- 侧边栏 91 项混乱的另一半解药（Thread.kind 分组）仍按 Raft 报告 Phase 1 走，与本方案正交。

## 5.（前移）实证：Raft agent 自述的实现分层（2026-07-23）

> 铲屎官直接在自己的 Raft 工作区（cy-server）问了 agent，agent 贴出了系统提示词原文和完整工具清单。这份一手实证**修正了本文档 §1 的表述**："系统绝不猜"只对平台层成立——判断确实存在，但住在 agent 的提示词里。三层分工（agent 原话总结）：
> **平台强制 = 机制层**（claim 原子性、freshness-hold、状态枚举、归档频道拒写）；**准则约定 = 判断层**（何时建/何时 thread/怎么拆/先 claim 后干活，写在英文系统提示词里）；**agent 自行判断 = 应用层**（某条消息算不算"要动手"、拆几个、派给谁）。

### 5.1 Raft 的 agent 工具清单 → Clowder MCP 工具映射

| Raft CLI | 行为要点 | Clowder 对应（现状） |
|---|---|---|
| `raft task claim --number N` / `--message-id X` | 开工前第一动作；**message-id 形式 = 把普通消息转成 task 并认领**（Convert to Task 也是 agent 干的） | `claimIfUnowned` Lua CAS 已有（RedisTaskStore.ts:352-377），缺 MCP 工具暴露 + message-id 转化形式 |
| `raft task create` | 只用于全新工作项；**防重规则：已有消息就 claim 那条，别新建**；默认建无主 todo 给别人领；`--assignee 自己`则原子建成 in_progress | TaskStore.upsertBySubject 已有，缺 MCP 暴露与防重约定 |
| `raft task update --status` | 做完先切 in_review 等人验，验过才 done | 状态机已有（todo/doing/in_review/blocked/done/failed，几乎对齐 Raft 五态），缺 MCP 暴露 |
| `raft task list` | 建新任务前查重、巡板 | GET /api/tasks 已有，缺 MCP 暴露 |
| `raft task unclaim` | 放手 | 缺 |
| `raft message send --target "#频道:msg短id"` | thread 回复；**对不存在的 thread 自动创建**（thread 隐式产生） | 分支 thread 机制已有但需显式建；缺"对消息回复即隐式建 thread"语义 |
| `raft message read --around` | 跳读上下文 | cat_cafe_fetch_thread_history 类似能力已有 |
| `raft thread unfollow` | 该 thread 的活彻底完了才退订 | follow 机制整体缺（见 §3 第三步） |

### 5.2 Raft 的提示词规则 → Clowder 猫 SOP（可直接翻译进系统提示词）

1. **建任务判据**（原文）："if fulfilling a message requires you to take action beyond just replying (running tools, writing code, making changes), claim the message first. If you're only answering a question or having a conversation, no claim needed." —— 动手才建，纯问答不建。
2. **CRITICAL**："Always claim a task before starting work. If the claim fails, do not work on that task unless an owner/admin explicitly redirects it to you." —— 先认领后干活；认领失败就走开，除非 owner 明示改派。
3. **防重**："If someone already sent the work item as a message, just claim that existing message/task instead of creating a new one."
4. **拆分三规则**："Group by phase if tasks have dependencies / Prefer independent subtasks that don't block each other / Avoid creating sequential chains." 拆出的 subtask 默认无主 todo "for others to claim"，不自己全领。
5. **回复路由**："To reply to any message, always reuse the exact target from the received message" + "Post updates in the task's thread." —— 来源在哪回哪，工作汇报锁进 task thread。允许主动上主频道的例外：①源消息本来在主频道的对话 ②给 owner 的整批进度/决策请求 ③与任何 thread 无关的新事项。
6. **验收流**：完成先置 in_review，人验过（如 "looks good"）才 done。

### 5.3 平台机制层的三个补件（Clowder 缺口）

1. **thread 隐式创建**：对消息的 thread 回复自动产生 thread（现在要显式 ensureTaskDiscussionThread）。
2. **task 事件消息**：agent 建任务/认领时，**系统自动在主频道发一条 task 事件消息**（实证："系统自动在主频道发了 task 事件消息"——补齐了文档调研里"状态变更是否产生系统消息"的未知项，也正是 §2 根因 4 的解法）。
3. **freshness-hold**：claim/提交时如有未读新消息，先拦下让 agent 看完再重试（实证案例：claim 被 freshness-hold 拦住 → 重试才返回 already-assigned）。Clowder 的 freshness 水位（appendWatermark/msg:freshness）零件已有，缺这个拦截点。

### 5.4 对实施计划的修正

- 第二步的"判定器降级"升格为"判定器退役"：F194 正则判定器不再扩词表，判断力整体移交猫（工具 + SOP）；服务端只保留机制层。
- 第三步的 claim 从"平台唤醒候选猫"修正为对齐 Raft：**task 事件广播 → 猫收到后自己判断是否 claim**（判断也在 agent 层），平台只保证 CAS 原子性和事件可达。
- 新增一项：**owner 改派语义**——"claim 失败不干活，除非 owner 明确改派"需要一个可识别的改派信号（Raft 靠 owner 一句话 + agent 理解；Clowder 可先同样走自然语言约定）。

## 5B. 实证二：记忆 / 长任务 / 唤醒 / 本地执行（A-D 挖掘，2026-07-24）

> 来源：铲屎官向 Raft agent 分四题追问的一手回答（原文存 OrbitOS-CN/00_收件箱/clowde0707/clowder0723/）。
> **元发现：Raft agent 的运行时就是 Claude Code 进程（daemon 拉起）**——其记忆结构、上下文压缩、审批弹窗均为 Claude Code 原生能力 + 提示词纪律。Clowder 的猫同样跑 claude CLI，大部分能力是"接通"而非"重造"。

### 5B.1 记忆机制（对 Clowder 最有行动价值的一份）

Raft 做法：`MEMORY.md`（索引+Active Context，**每次开工全文自动注入**）+ notes/（专题速查）+ memory/（一条反馈一个文件，带 frontmatter）。四分类 user/feedback/project/reference；红线"仓库已记录的不存、只对本次对话有意义的不存"；agent 自己写入（四时机：被纠正时最高优先/关键裁定/长任务前写 Active Context/发现操作陷阱当场写）；无自动过期，靠查重-更新-删错 + 读旧笔记时的陈旧性提醒；**索引全量注入、细节按需读文件**。

**Clowder 差距（关键）**：猫的 `.cat-cafe/memory/{catId}.md` 注入时被压成 **≤200 字摘要**（SystemPromptBuilder.ts:452-470）——Raft 是索引全文注入。200 字装不下 Active Context，等于猫每次醒来都"断片"。
**改法（进批次 2）**：猫记忆改为两层——`MEMORY.md` 索引+Active Context（全文注入，预算 2-4k tokens）+ notes/ 细节（MCP 读文件按需展开）；四分类与红线写进猫 SOP；promotion gate 维持 shadow 即可（Raft 连 gate 都没有，纯 agent 自律+人工纠正）。

### 5B.2 长任务与上下文

Raft 做法：平台自动压缩（固定段落结构化摘要）+ MEMORY.md 注入 = 恢复点；纪律是"事前写 Active Context，压缩本身无害，没落盘的脑内状态才会丢"；thread 当进度存档（关键节点必发 thread，msg-id 可回拉）——"频道=事件真相源，MEMORY=状态快照，两层互备"。
**跨 agent 交接：平台没有结构化原语**——就是消息+assignee 转移；六件套交接信+接球方回述确认是他们的纪律层（和 Clowder cross-cat-handoff skill 同构）。金句："交接质量的关键不在格式，在交接人有没有先验证自己要交的东西"。

**对计划的修正**：原 Phase 7"handoff capsule 平台化/泛化"**降级**——Raft 证明纪律层足够，平台只需保证消息可回溯（已有）。把"长任务开工前写 Active Context""关键判断当场落盘"写进猫 SOP 即可。

### 5B.3 唤醒与积压处理

Raft 做法：**纯事件驱动零轮询**——闲置即休眠；唤醒仅三种（消息正文直接注入 / 自设 reminder 到点 / 系统事件）。**干活期间不打断**：新消息攒成 content-free 元数据通知（thread·发送者·msg-id·是否@我）插进工作流，"到自然断点再 message check 拉正文"；"没读≠没活"。积压合并理解按事分组，优先级 owner 指令 > 阻塞他人的 gate > 证据报告 > 元数据补录。Ping 纪律三条：停手前欠着谁的阻塞项必须发一条最小可动作消息 / 无可动作内容不发（禁刷屏）/ 只在被 @ 时插嘴。双 @ 防撞：claim 原子性防都干、"被@必须响应"防都不干、讨论题"谁干谁报"。

**Clowder 映射**：① content-free 工作中通知可用 **steer v2 stdin 通道**实现（claude-runtime-steer.ts 已有，向运行中进程注入元数据行）——进批次 3；② reminder 自设已有（AgentReminderScheduler）；③ 积压分组/停手清欠/谁干谁报三条 SOP 直接抄进猫提示词——进批次 2。

### 5B.4 本地执行与预算

Raft 做法：边界三层——平台强制（权限模式+允许清单外弹审批，allow/deny/always-allow）/ 配置层（清单是**用户配的**不是 agent 定的）/ 约定层（团队纪律）。"不被锁死在目录里"。业务层人门比平台层更重要：不可逆动作（翻 public/生产部署/密钥轮换）必须 owner 明示，写在 agent 记忆硬约束里。长命令 thread 无自动进度流，靠手动三拍：开工报一句 → 节点报状态 → 完成贴证据（测试数字/diff/sha）。**预算：平台无配额无仪表盘**，真实约束=订阅额度，撞墙=403 当场失能、活转派。

**对计划的修正**：① Phase 8 权限分档方向被实证支持（= Claude Code 权限模式 + 用户侧允许清单，Clowder 现在的 bypassPermissions 等于把这层整个关掉了）；② 预算熔断保留但**降优先级**（Raft 没有也活得很好），更实用的是"撞额度失能→活转派"（Clowder 的 cooldown-sweep 配额冷却已有雏形，对齐 kimi 403 转派剧本）；③ "完成贴证据"三拍写进猫 SOP（与 Clowder CLAUDE.md"Done requires evidence"同构，本来就有土壤）。

### 5B.5 消息搜索（第五份实证，2026-07-24）

Raft 做法：检索三件套——`message search`（关键词+发送者/target/ISO 时间过滤+相关度/时间排序+分页；结果=msg-id + 精确 thread 来源 + `<match>` 高亮片段预览）→ `message read --around <msg-id>`（二跳拿全文）→ `message check`（只拉未读）。**关键词级匹配非语义搜索**，agent 使用频率排序：① **msg-id 面包屑直达**（MEMORY 里的结论都带 msg-id，"已报yangcyyang(858e3680)"→ read --around 零搜索）② 关键词搜索 ③ 锚点翻页。SOP 原文："有人引用历史讨论而上下文里没有→先 search+read 找到原始 thread/决策/owner 再答；找不到要明说。" 三方分工：记忆=蒸馏结论（时间点快照）/ 搜索=原文与证据 / 问人=只有 owner 脑子里有的。两个结构认知：**平台历史与 agent 上下文分离**（压缩压的是 agent 上下文，频道历史永不丢、永远可搜）；关键词依赖的短板**靠面包屑纪律绕过**——"不算搜索强，是纪律兜着"。

**Clowder 现状核对（2026-07-24 实查）**：两跳后端零件齐全——`GET /api/messages/search` 全文搜索（api/routes/messages.ts:2042）+ `GET /api/messages?around=` 锚点定位（:307，注释即"Center the first page around a search result"）；回调桥已含搜索（McpPromptInjector/callbacks）。**缺口两个**：① Claude 系猫的原生 MCP 白名单（packages/mcp-server/src/server-toolsets.ts:36-67）只有 `cat_cafe_search_evidence` 和 `cat_cafe_fetch_thread_history`，没有跨 thread 消息搜索工具——包一层即可；② msg-id 面包屑纪律不在猫 SOP 里。启示：**不需要给消息搜索上语义检索**（evidence 库的 FTS5+向量留给知识层就够），消息层照抄"关键词+面包屑"组合。

### 5B.6 汇总：五份实证对批次计划的净增改动

| 批次 | 新增/修正 |
|---|---|
| 批次 2 | +猫记忆两层化（索引全量注入替代 200 字压缩 + notes 按需 MCP 读）；+MCP 工具 `cat_cafe_search_messages`（包现有 /api/messages/search + around 两跳）；+SOP 增补六条（Active Context 前置 / 积压分组 / 停手清欠 / 完成贴证据三拍 / 搜索优先于瞎答、搜不到明说 / 记忆结论带 msg-id 面包屑） |
| 批次 3 | +steer 通道 content-free 工作中通知；交接 capsule 平台化降级为 SOP 纪律；预算熔断降优先级、优先做"额度失能→转派" |

## 6. 风险与未决

1. thread-first 默认开启对既有习惯的冲击——先在 1-2 个新频道试，体感确认再推全。
2. Raft 文档未写"状态变更是否产生系统消息"，第二步第 4 条选了"原地徽章更新"（依据其"主频道干净"哲学推断）——如需强提醒，交给 Activity 而非主频道。
3. 自动 claim 的候选圈怎么定（全频道成员猫 vs preferredCats）需实测调；防抢单风暴靠现有 CAS + 每猫并发 slot。
4. 金丝雀 1 是脚本化验证 thread，本诊断主要依据金丝雀 2 的真实使用数据（30 条消息样本）——推全前建议再选一个高频真实频道灰度。
