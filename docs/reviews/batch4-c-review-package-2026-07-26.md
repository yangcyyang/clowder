---
title: 批次 4-C 完成情况——交 Codex 独立审查包
doc_kind: review-handoff
created: 2026-07-26
feature_ids: [F194]
topics: [reliability, session, review]
---

# 批次 4-C 完成情况（交 Codex 审查）

> 给你（Codex）的角色设定：**独立第三方 reviewer**。本包工作由 Claude 执行者实施、主会话（Fable）验收入库——按"执行者永不自审、跨家族互审优先"的家规，现在请你出第三只眼。你的任务是**复审已入库的代码**，不是重新实施。

## 0. 审查对象与环境

- 仓库：`/Users/cy/.slock/worktrees/clowder-ai-slock-like-webui`，分支 `feature/slock-like-webui`
- **审查范围就两个提交**：`6cde7a5c`（批次 4-C 代码，20 文件 +230/−20）、`09bd0b7b`（配套文档，可略读）。基线 `258d5ad0`。
- 用 `git show 6cde7a5c` / `git diff 258d5ad0..6cde7a5c` 看全量 diff。
- ⚠️ 工作区另有**多路他人未提交脏改动**（cats.ts、mcp-probe.ts、first-run-quest.ts、若干测试文件、BACKLOG、shared-rules 等）和一个**在飞的裁剪 agent**（正在摘除游戏模块，会出现大量删除）。**这些统统不在审查范围**——只看上述两个 commit 的内容，工作区现状的任何其他变化一律忽略。
- 审查纪律：只读为主；如需跑测试，先 `cd packages/api && pnpm run build`（测试跑 dist）；**禁连生产 Redis 6399**（要 Redis 用隔离脚本，见 §4）；禁 git stash；禁 pnpm install；命令禁接管道（重定向到文件再看，`$?` 单独判）。

## 1. 本包交付了什么（实施者声明 + 验收方核对过的清单）

背景一句话：某猫（codex 家族）的 CLI 原生会话文件累积到 25MB，定时任务每次唤醒都 `--resume` 整载导致卡死超时、断刊 6 场。本包按定稿 PRD（`docs/prd/batch4-reliability-task-closure-session.md` 末节"第七轮访谈参数落定"）实施：

| 项 | 内容 | 主要文件 |
|---|---|---|
| C4 定时任务每场新会话 | 新增 `forceFreshCliSession` 标志全链插桩：scheduler 模板（reminder/web-digest）→ ConnectorInvokeTrigger → InvocationQueue 条目 → QueueProcessor → 路由三线（AgentRouter/route-serial/route-parallel）→ `invoke-single-cat.ts:877` 置空 resume sessionId（provider 无关）。env `CLOWDER_SCHEDULER_FRESH_CLI_SESSION` 默认开、可关回旧行为。上下文延续依赖既有 session-chain digest，不受影响 | scheduler/types.ts、templates/reminder.ts、templates/web-digest.ts、email/ConnectorInvokeTrigger.ts、invocation/InvocationQueue.ts、QueueProcessor.ts、invoke-single-cat.ts、routing/AgentRouter.ts、route-helpers.ts、route-serial.ts、route-parallel.ts |
| C2 唤醒器参数落定 | 认领闲置唤醒器首推阈值默认 15→**120 分钟**；nudge 文案改"请把进度或阻塞说一句"式；2 次封顶+升级人工保持不变 | invocation/ClaimedIdleScheduler.ts、config/env-registry.ts |
| C5 会话体积纯观测 | codex rollout 文件大小在每次调用完成时 stat 并入 usage（`sessionFileBytes`），超阈值（默认 4MB，`CLOWDER_CODEX_SESSION_SIZE_WARNING_MB`）打 log.warn，**不轮转不删除不影响调用** | providers/CodexAgentService.ts、codex-session-context-snapshot.ts、services/types.ts |
| C1 唤醒器护栏回归 | 新增隔离 Redis 回归测试（真实存储路径上二次扫描不重复唤醒）。**原执行文档的"Redis 不落库、测试应红"前提被实测证伪**——护栏在真实路径工作正常 | test/claimed-idle-scheduler.redis.test.js（新）、test/claimed-idle-scheduler.test.js |
| 测试基建 | with-test-home.sh 固定 `DEFAULT_CAT_ID=opus` 防宿主 .env 泄漏进测试；speech-mentions 测试断言随之去硬编码 | scripts/with-test-home.sh、test/agent-router-speech-mentions.test.js |

## 2. 验收方已做过的核验（别重复，聚焦 §3 的增量）

1. 四组测试全部亲自复跑：内存调度器 31/31、隔离 Redis 1/1、codex 快照 3/3、golden（adr-024）绿、speech-mentions 6/6；
2. 20 个文件逐一核对 diff 与归属（他人脏改动未混入提交）；
3. 插桩链人工走查到终点 `invoke-single-cat.ts:877`；
4. 风暴根因日志取证（见 §3.1）；
5. `trigger()` 调用方清单核查：scheduler 模板已接；连接器对话路径（ConnectorRouter）**故意不接**（交互式对话应续会话，正确）；email/GitHub 周期任务规格（CiCdCheckPoller 等）未接——但该模块生产从未启用（IMAP 未配置）且已列入裁剪清单，属自消解缺口。

## 3. 请你重点复核的五个点（按价值排序）

### 3.1 风暴根因判断链的最后一环（最有价值）
07-26 上午"每分钟治理拦截"风暴，我方结论：**唤醒器护栏没坏，是被治理门拦截的派发以 `errorCode: PROJECT_PERMISSION_DENIED` 结束、被标为 failed (retryable) 后遭重试机制反复重投**。证据：生产日志 04:11-04:17 UTC 九次拦截、节拍漂移（+35s/+84s，非 60s 扫描节拍）；`invoke-single-cat.ts` 拦截分支注释明言 "routes mark invocation as failed (retryable)"；该错误码全库零消费点；AutoRetry env 关闭。**但"具体是哪个组件在重投、按什么节奏"尚未定位到代码行。**请你独立走查失败 invocation 的重试/重投路径（QueueProcessor 条目生命周期、routes 对 done-with-errorCode 的处理），把最后一环钉死或推翻——这直接决定批次 4-A2 修复（该错误码终态化）的落点是否正确。

### 3.2 forceFreshCliSession 覆盖面
请独立扫一遍所有"定时/周期性派猫"的入口，确认除 scheduler 模板外没有第四类入口会累积原生会话（已知豁免与缺口见 §2.5）。同时审 `invoke-single-cat.ts:877` 置空的位置：它在 session-chain 重置逻辑之后、Claude budget gate 之前——有没有顺序副作用（例如 budget gate 基于 `hasResumeSession=false` 走了不同分支是否符合预期）。

### 3.3 `sessionFileBytes` 并入 TokenUsage 的语义
`services/types.ts` 把它加进 `LatestTokenUsageKey`（保留最新快照而非累加）。请核：①mergeTokenUsage 的聚合路径会不会把它误算进任何成本/token 统计；②前端/接口有没有消费 usage 全量对象的地方会把这个新字段渲染成奇怪的东西。

### 3.4 DEFAULT_CAT_ID 固定的影响面
with-test-home.sh 现在 export `DEFAULT_CAT_ID=opus`。请扫测试套件里是否有用例隐式依赖宿主 .env 的 `DEFAULT_CAT_ID=gpt52`（或依赖"未设置"状态）而被这次固定改变行为——尤其是没进本次提交的其他测试文件。

### 3.5 隔离 Redis 回归测试的强度
`test/claimed-idle-scheduler.redis.test.js` 只有 1 个用例（二次扫描不重复唤醒）。请评估它是否足以守住"真实存储路径护栏有效"这个结论——若你认为需要补第二个用例（如 30 分钟间隔护栏、2 次封顶后的 escalate 路径走真实 Redis），列出来即可，不必自己写。

## 4. 复跑命令（如需）

```bash
cd /Users/cy/.slock/worktrees/clowder-ai-slock-like-webui/packages/api && pnpm run build
```

```bash
cd /Users/cy/.slock/worktrees/clowder-ai-slock-like-webui/packages/api && bash scripts/with-test-home.sh node --import ./test/helpers/setup-cat-registry.js --test test/claimed-idle-scheduler.test.js test/codex-session-context-snapshot.test.js test/adr-024-context-cache-layout.test.js
```

```bash
cd /Users/cy/.slock/worktrees/clowder-ai-slock-like-webui/packages/api && bash scripts/with-test-home.sh bash scripts/run-isolated-redis-tests.sh node --import ./test/helpers/setup-cat-registry.js --test test/claimed-idle-scheduler.redis.test.js
```

## 5. 已知偏离与遗留（验收方已接受，审查时知悉即可）

1. C5 告警走 log.warn 而非大厅卡——符合第七轮"纯观测"修正精神；
2. 唤醒器生产 env 仍 `CLOWDER_CLAIMED_IDLE_WAKEUP=0` 关停，**重开前提=批次 4-A2 落地**（治理拦截终态化）；
3. 实施基线 `b4b58d00` 与文档基线 `258d5ad0` 代码等价（后者仅多一个 docs 提交）；
4. C 包已完成，批次 4 剩 A/B 两包待实施（执行文档 `docs/prd/batch4-codex-execution.md`，其 A2 节含风暴根因追加段）。

## 6. 审查产出格式（全中文）

- 总结论：通过 / 通过但有建议 / 有问题需返工；
- 问题列表按严重度排序，每条带 file:line 与失败场景；
- §3 五个点各给一句独立结论（尤其 3.1 的最后一环：钉死或推翻，附你的证据链）；
- 你独立跑过的验证命令与关键输出。
