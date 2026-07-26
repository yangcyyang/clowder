---
title: 批次 4 执行文档（交 Codex 实施版）
doc_kind: execution-spec
created: 2026-07-26
status: 待开工
feature_ids: [F194]
topics: [reliability, task, review, session]
---

# 批次 4 执行文档（给 Codex 的完整开工包）

> 你（Codex）拿到本文档即可开工，不依赖任何历史会话。本文档由批次 4 PRD（`docs/prd/batch4-reliability-task-closure-session.md`）的最终节"第七轮访谈参数落定"转写而来，**所有参数已定稿，不要自行更改参数值**；拿不准的地方停下来问，不要猜。

## 0. 项目背景（30 秒版）

Clowder 是一个多 AI-agent 协作平台（"猫"=CLI 子进程执行者）：Fastify API（端口 3004）+ Next.js Web（端口 3003）+ Redis（端口 6399，**生产库**）+ PM2 托管。本批次修三类真实流过血的事故：

1. **权限静默瘫痪**：macOS TCC 收权后猫被静默杀死，无任何告警（07-25 推特日报断更事故）；
2. **任务有始无终**：置 in_review 后没有验收人、没有超时；认领后挂机的唤醒器又因护栏 bug 引发每 60 秒轰炸风暴（07-26，现已用 env 关停）；
3. **会话撑爆断刊**：某猫的 CLI 会话文件累积到 25MB，每次唤醒整载卡死超时，断刊 6 场。

设计原则（已由 7 轮对标访谈定稿）：**血案实证才立机制**；提醒类机制三级封顶，第三级必须是状态动作而不是更响的闹钟；打标自动、转派必须人决定；永不自动化语义判断。

## 1. 环境与仓库

- 仓库：`/Users/cy/.slock/worktrees/clowder-ai-slock-like-webui`（pnpm monorepo：`packages/api` 后端、`packages/web` 前端、`packages/shared` 共享类型）。
- 当前 HEAD 基线：`258d5ad0`（批次 4 PRD 定稿提交）。
- 生产在 PM2 上跑（clowder-api / clowder-web）。**你不负责部署、不重启服务、不碰 PM2**——只交付代码 + 测试 + 报告，部署由主会话统一做。
- 仓库内有**他人未提交的脏改动**，一律不许碰、不许提交、不许 stash：涉及 first-run-quest、mcp-probe、BACKLOG.md、png 图片、shared-rules、UserProfileCandidatesPanel 等文件。你的提交只含你自己的改动。

### 测试跑法（照抄，别改）

```bash
# api 单测（跑的是 dist，改了 api 源码必须先 build）
cd packages/api && pnpm run build
bash scripts/with-test-home.sh node --import ./test/helpers/setup-cat-registry.js --test <测试文件...>

# 需要真 Redis 的测试：用隔离 Redis 脚本（随机端口起独立实例，退出自动清理）
bash scripts/with-test-home.sh bash scripts/run-isolated-redis-tests.sh node --import ./test/helpers/setup-cat-registry.js --test <测试文件>

# web 测试
cd packages/web && pnpm vitest run <文件>
```

### 硬纪律（红线，违反=返工）

1. **禁连生产 Redis 6399**。任何测试/调试一律走隔离 Redis 脚本。
2. **禁 `git stash`**（会吞他人脏改动）。要看基线用 `git show HEAD:<file>`。
3. **禁 `pnpm install`**（锁文件不许动）。
4. 构建/测试命令**禁止接管道**（`| head` 等会吞退出码）；要截断就重定向到文件再看，退出码用 `$?` 单独判。
5. golden 测试 `packages/api/test/adr-024-context-cache-layout.test.js` 全程必须绿——每次提交前跑一遍。
6. 每个新机制必须带 env 开关，并在 `packages/api/src/config/env-registry.ts` 注册（中文说明写清：干什么、默认值、怎么关）。
7. **默认开启的自动化，护栏必须在真实存储路径（隔离 Redis）上验过才准默认开**——这是唤醒器风暴的学费，不是官僚要求。
8. 修 bug 先写红测试（复现），再修到绿。"做完"必须有证据（测试输出原文）。
9. 报告、提交信息里的说明、告警文案全部用中文。
10. 按工作包分别提交（A/B/C 各自成串），不要一个大杂烩提交；**不许 push**。

---

## 2. 工作包 A：可靠性收尾（权限自检 + EPERM + 属主锁 + 测试卫生）

改动集中在启动路径与 provider 错误处理，共 5 件：

### A1 启动权限自检（一次性，不做常驻轮询）
- api 启动时执行一次：对治理注册表（`worktree/.cat-cafe/governance-registry.json`，代码 `packages/api/src/config/governance/governance-registry.ts`）中所有已确认项目目录做**读探测**（open 一个已知文件），对 Clowder 数据根（`.cat-cafe`）做**写探测**。
- 失败 → 大厅发一条**零 token 系统告警卡**（中文，含修复指引："在有完整磁盘访问权限的终端跑 pm2 update / 检查 系统设置→隐私与安全性→完整磁盘访问权限"）+ 记入 Activity；恢复后（下次自检通过）发解除通报。同一目录状态未变不重发。
- **明确不做**：每小时轮询（已在 PRD 瘦身节砍掉）。唯一的复检触发点是 A2 的 EPERM 失败。
- 启动挂载点参考：`packages/api/src/index.ts`（ClaimedIdleScheduler 在 :2380 附近挂载，可参照其模式）。

### A2 EPERM 智能分类收尾
- 文件：`packages/api/src/domains/cats/services/agents/invocation/provider-error-classification.ts` + `AutoRetryScheduler.ts`（同目录）。
- CLI 启动即退且 stderr 含 EPERM/permission → 新分类 `permission_denied`：**不重试**（当前按 transient 重试 2 次纯浪费）；线程里贴带修复指引的中文卡；并触发 A1 的自检立即复跑一次。
- 注意：本项"已上线大半"——先读现状再补缺口，别重复造。
- **【2026-07-26 验收后追加，必做】治理拦截派发必须终态化**：`invoke-single-cat.ts` 治理拦截分支以 `errorCode: PROJECT_PERMISSION_DENIED` 结束，注释明言 routes 将其标为 failed (**retryable**)，且该错误码全库无任何消费点——07-26 上午的"每分钟治理拦截风暴"实证根因就是失败重试机制反复重投同一条被拦截的派发（生产日志 04:11-04:17 UTC 九连，节拍漂移证明非扫描驱动；调度器护栏经隔离 Redis 复核工作正常）。要求：`PROJECT_PERMISSION_DENIED` / `GOVERNANCE_BOOTSTRAP_REQUIRED` 归入 `permission_denied` 终态分类，零重试；补红测试：治理拦截的队列条目不得被重投（先红后绿）。**认领闲置唤醒器（现 env 关停）重开以本项落地为前提。**

### A3 治理注册表查询韧性（实证 bug 修复）
- 文件：`packages/api/src/config/governance/governance-registry.ts`。
- 实证现象：某项目（"designe agent"）明明记录在注册表里，`get()` 却返回 null → 上游误判 needs_bootstrap。根因：查询路径做了依赖实时文件系统的规范化（realpath 之类），目录被 TCC 拒读时规范化失败 → 匹配不上。
- 修法方向：路径比较不依赖实时 fs 调用（纯字符串规范化）；读注册表文件本身遇 EPERM/EACCES 时**明确报"读不到"而不是"没注册"**。补测试：mock EPERM 场景红→绿。

### A4 属主锁最小版（防双开）
- 07-24 真实事故：桌面 App 与 PM2 双开两个 api 实例互抢。已有 `packages/api/src/services/ApiInstanceLease.ts`（Redis 租约），本项是**文件层兜底**：`.cat-cafe` 数据根放属主 marker（pid + dev/ino 身份校验），api 启动时校验；stale 锁（进程已死，`kill -0` 判）自动接管；冲突时拒绝启动并输出中文人话（"另一个 Clowder API（pid N）正在使用此数据目录……"）。
- 先读 ApiInstanceLease 现状，避免和 Redis 租约重复/打架——文件锁管"Redis 都连不上时"的兜底。

### A5 测试进程卫生（trap 全覆盖 + 无残留断言）
- 07-26 真实事故：测试起的 api 实例泄漏成常驻进程，双实例各吃满一核 + 26GB swap 跑了 1-2 天。
- 检查 `packages/api/scripts/` 下所有会 spawn 进程的测试脚本（`with-test-home.sh`、`run-isolated-redis-tests.sh` 等）：trap 必须覆盖正常/异常/超时三种退出路径，全部 kill 干净；脚本收尾加断言"无本脚本起的残留进程"，断言失败=测试失败（这是验收标准的一部分，不是顺手做做）。

### A 包验收标准
- A-AC1：模拟收权（chmod 000 测试目录）→ 启动自检发出告警卡；恢复后解除通报。
- A-AC2：CLI EPERM 退出 → 零重试、线程可见带指引的卡、分类记 `permission_denied`。
- A-AC3：第二个 api 实例启动 → 被属主锁拒绝并输出人话；杀掉持锁进程后可正常接管。
- A-AC4：故意让测试脚本异常退出 → 无残留进程。
- A-AC5：golden 绿；各机制 env 开关注册齐全（默认开）。

---

## 3. 工作包 B：任务闭环（reviewer + 分轨提醒 + 失能打标 + 证据自动化）

任务域代码：`packages/shared/src/types/task.ts`（类型）、`packages/api/src/domains/cats/services/tasks/`（task-status-transitions.ts 状态机等）。共 4 件，参数全部照抄下表，**一个都不许改**：

### B1 reviewer 单字段 + 缺省规则
- `task.ts` 增可选 `reviewerId`（猫 id 或 `'human'`）。**只建一个字段**——不做"gate 预验/人类终审"双字段（已砍，终审是纪律层不是平台字段）。
- 缺省规则：
  - 人建的票 → 常设 gate 猫（新 env `CLOWDER_TASK_DEFAULT_REVIEWER` 配置猫 id；未配置 = `'human'`）。**不是建票人**——建票人是需求方，验的是"要不要"；reviewer 验的是"对不对"。
  - agent 拆的子票 → 继承父票 reviewer。
  - **执行者永不 review 自己的票——服务端校验**（置 in_review 时若 reviewerId===owner/执行者，拒绝或落回缺省），不能只靠前端。
- 置 in_review 时通知验收人：human=大厅+Activity；猫=唤醒投递。

### B2 分轨超时提醒（按验收人类型分轨，不按票分级）
| 轨道 | 节奏 | 说明 |
|---|---|---|
| gate（猫）轨 | 24h 私提醒**验收人** | 瓶颈永远在验收人注意力，提醒发给验收人不是提交人 |
| human 轨 | 48h 私提醒 → +48h 频道内可见 @owner → 7-14 天**状态动作** | 状态动作=自动降回 doing + 通知双方，要求重新提交或明确弃票 |
- **三级封顶**，第三级必须是状态动作不是更响的闹钟（提醒无限升级只会被免疫）。每票每级各触发一次，不重复轰炸。

### B3 失能打标（打标自动，转派人决）
- assignee 状态异常**持续 >30 分钟**（防闪断误报）→ 其名下 in_progress/todo 票自动打"assignee 失能"标 → 通知 owner + 票所在频道（可见即可，**不 DM 轰炸**）→ **绝不自动转派**（自动转派=把无交接的活扔给不知情的人，比冻着更糟；转派由人/gate 决定并带交接）。
- 恢复后自动清标，但票上**留一条事件记录**（谁失能过、多久——验收时要知道这段真空期）。
- 失能信号来源：挂在 A2 的错误分类上（额度死/permission_denied/进程异常等持续态）。

### B4 验收证据自动化（只做四件，替代已砍的"模型预审"）
1. 置 in_review 时自动把 commit sha / diff stat / 改动文件清单锚进票 thread；
2. 自动重跑提交者声明的测试命令（**隔离环境**）并把原始输出附上；
3. 静态扫描：二进制/裸控制字符检测 + diff 内密钥形态扫描（历史真实拦截对象：裸 NUL 进代码、API key 进标题）;
4. 验收动作留痕（谁在何时验了什么证据，自动记录）。
- 实施顺序：①③④先行，②（隔离重跑）其次。
- **永不自动化**：diff 与声明的语义一致性判断、对抗性边界推演、范围裁定——这三样永远留给人。

### B5 票面卫生平台防呆（2026-07-26 晚追加，依据 Raft 第九轮访谈定稿，详见 docs/research/raft-r9-ticket-hygiene.md）

背景：`task_claim --message-id`（callback-task-routes.ts:526 附近）被执行猫每轮当记账动作使用，一晚产出 8+ 张标题为对话原文的垃圾票；纯纪律已被实证守不住。四条规则（各带 env 开关默认开，红→绿测试）：

1. **B5.1 层级规则**：分支/讨论 thread 内的消息不可经 message-id 转票；拒绝响应给猫可读提示（"讨论上下文不入票；新工作请 task_create + 自拟标题"）。
2. **B5.2 自噬禁止**：猫发的消息一律不可经 message-id 转票（人类消息可）；猫的工作票必须显式 task_create + 自拟标题。
3. **B5.3 活跃票降级**：同猫同 thread 已有活跃票（todo/doing/in_review）时，对人类消息的转票降级为"挂进度事件到活跃票"，并发可见提示卡"已挂到 #N；若这是新工作请显式建票"（显式逃生门）。
4. **B5.4 标题强制**：message-id 转票必须随附猫自拟标题（≤60 字，非截断），原文写入票 thread 首条；缺标题拒绝。mcp-server 的 task claim 工具 schema 同步加 title 参数与说明。

B5-AC：①分支 thread 消息转票被拒且提示可读；②猫消息转票被拒；③有活跃票时人类消息转票产出进度事件+提示卡而非新票，显式 task_create 仍可建新票；④缺标题被拒、带 61 字标题被拒、原文落 thread 首条；⑤存量票不动；env 全注册契约绿；golden 绿。

### B5.5 建票上浮到主频道（2026-07-26 深夜追加，铲屎官定稿；B1-B4 落地后单独小项实施，勿与其并行）

铲屎官原话依据："在 thread 里聊着聊着要创建 task，创建指令应该回到上一级主频道去建——符合父子层级关系、避免子级建票不可见、父级是管理全部 Task 的场景。"与 Raft 结构规则（分支=讨论上下文，频道=任务层）互为表里：B5.1 是"分支内不许转票"的拒绝面，B5.5 是"任务归位主频道"的出口面。

1. **上浮规则**：在分支/讨论 thread 内发起的**显式建票**（猫的 task_create、人类的 As Task / Convert-to-Task）→ 任务的 threadId 沿 parent 链上溯锚定到**顶层频道**；任务卡与"已创建任务"系统通告发在主频道。顶层频道/DM 内发起的建票行为不变。
2. **回执与溯源**：发起的分支 thread 里留一条轻量回执（"已在主频道创建任务 #N"，复用 appendTaskLifecycleNotice 模式）；任务创建事件记录 originThreadId/originMessageId，讨论上下文可回溯。
3. **任务讨论 thread 不受影响**：票自己的讨论分支仍照常挂在票下。
4. env：`CLOWDER_TICKET_HYGIENE_HOIST_TO_CHANNEL`（默认开，可关回旧行为），注册中文说明。
5. B5.5-AC：①分支内猫 task_create → 票锚定顶层频道+主频道通告+分支回执+origin 字段在案；②多级嵌套分支上溯到根频道；③人类 As Task/Convert-to-Task 同样上浮；④顶层/DM 行为不变；⑤关闭开关回旧行为；红→绿测试，golden 与既有票面卫生测试零回归。

### B 包验收标准
- B-AC1：猫置 in_review → 验收人按缺省规则被通知；执行者=reviewer 被服务端拒绝。
- B-AC2：构造超时 → gate 轨 24h、human 轨 48h/96h/第三级各触发一次且不超一次；第三级实际把票降回 doing。
- B-AC3：模拟 assignee 持续失能 31 分钟 → 名下票打标+双通知；恢复 → 清标+真空期事件在案。
- B-AC4：置 in_review → sha/diff stat/文件清单出现在票 thread；含裸控制字符的 diff 被扫出。
- B-AC5：golden 绿；新机制 env 可关。

---

## 4. 工作包 C：唤醒器修复 + 会话膨胀治理

> **【2026-07-26 状态更新】C 包已由另一执行者完成并通过 Owner 验收入库（见 `.cat-cafe/projects/batch4/progress.md` 验收记录）。C1 的"Redis 不落库"前提被实测证伪——护栏在真实存储路径工作正常，风暴真实根因是"治理拦截的派发被标记为可重试后被反复重投"，该修复已划入 A2（见 A2 追加段）。接手 A/B 包者不需要再做本节 C1-C5。**

### C1 认领闲置唤醒器护栏修复（本包最高优先级）
- 文件：`packages/api/src/domains/cats/services/agents/invocation/ClaimedIdleScheduler.ts`（现有 22 个单测在 `test/claimed-idle-scheduler.test.js`）。
- **现状：生产已用 `CLOWDER_CLAIMED_IDLE_WAKEUP=0` 关停**（ecosystem.config.cjs），因 07-26 上午风暴：每 60 秒扫描一次就 nudge 一次，"每周期最多 2 次、间隔 ≥30 分钟"护栏完全没拦住。
- **根因疑点（待你实证确认）**：nudge 计数通过 task.events 读写；单测用内存 TaskStore 全绿，但生产 Redis 路径上 events 疑似未落库/读不回 → 每次扫描都以为是第 0 次。
- 修复流程（强制）：
  1. 先用**隔离 Redis** 写红测试：真实 Redis TaskStore 路径上连续两次扫描 tick → 断言第二次**不**nudge。此测试当前应为红（复现风暴）；
  2. 修到绿（让计数在 Redis 路径真实持久化，或改用不依赖 events 的持久计数）；
  3. 内存 store 的旧测试保持全绿。
- **修好后不要在 ecosystem.config.cjs 里重新开启**——开关翻转由主会话在部署窗口做。

### C2 唤醒器参数重调（与 C1 同批）
- 首次 nudge 阈值：15 分钟 → **120 分钟**（改 `CLOWDER_CLAIMED_IDLE_MINUTES` 默认值，env-registry.ts 的说明同步改）；
- nudge 文案改为"进度或阻塞说一句"式——要的是一句话状态，不是催促（"请尽快"只会得到"在做了"）；
- 保持：2 次封顶 + 之后零 token 系统通知建议人工处理（不加更多级）。

### C3 会话全量加载路径排查（先排查后动手）
- 背景：某猫 CLI 会话 jsonl 累积到 25MB 即卡死超时；对标系统单会话 207MB 零问题——**差别在访问模式不在体积**（它的 runtime 从不整文件加载）。
- 任务：排查我方链路上谁在整文件读——重点 `packages/api/src/domains/cats/services/session/`（TranscriptReader.ts / TranscriptWriter.ts / SessionSealer.ts）与 `packages/api/src/routes/session-chain.ts`、`session-hooks.ts`。产出一份排查结论（写进你的报告）：全量 parse 发生在我方代码还是第三方 CLI 的 resume 内部？
- **若在第三方 CLI 内部无法改 → C4 就是唯一杠杆，不要试图给体积设上限**（方向已定：不定体积上限）。

### C4 定时任务每场新会话
- scheduler 派单时不复用 cliSessionId，每场新会话。scheduler 代码：`packages/api/src/infrastructure/scheduler/`（TaskRunnerV2.ts / execute-pipeline.ts）；session 绑定实际发生在 invocation/cli-spawn 路径（`packages/api/src/utils/cli-spawn.ts`），C3 排查时一并定位复用点。
- 上下文延续靠既有 session-chain digest 机制（`packages/api/src/routes/session-chain.ts`，孟加拉猫冷启动 onboarding 已验证此路可行）。
- 带 env 开关（默认开，可关回旧行为）。

### C5 会话体积软告警（纯观测）
- session 绑定/结束时记录会话文件体积；超 **4MB**（env 可调）→ 大厅告警"XX 的会话已 XMB"。**不触发任何自动动作**——只收集数据供后续决策。

### C 包验收标准
- C-AC1：隔离 Redis 红→绿测试在案（红测试的失败输出 + 修复后通过输出都贴报告）。
- C-AC2：定时任务连续两场 → 两个不同 cliSessionId；第二场能引用第一场 digest 关键结论。
- C-AC3：构造 >4MB 会话 → 告警出现，且无任何自动动作发生。
- C-AC4：C3 排查结论成文（全量加载点定位到 file:line，或明确归因第三方 CLI）。
- C-AC5：golden 绿。

---

## 5. 交付物与验收流程

1. **提交**：按 A/B/C 三包分别成串提交（中文说明），基线 `258d5ad0` 之上，**不 push**、不部署、不改 ecosystem.config.cjs 的开关值（新增 env 注册除外）。
2. **报告**（全中文），每包一节：改了什么（file:line 级）、测试证据（命令 + 原始输出关键行）、C3 排查结论、你偏离本文档的任何地方及原因。
3. 主会话验收方式（提前告知）：抽查 file:line、亲自复跑你声明的测试、范围核对（有没有做文档外的事）。报告与实际不符=整包返工。
4. 遇到与本文档冲突的代码现状（比如某项已被别人实现）：**停下来在报告里说明并等确认**，不要自行裁定。
