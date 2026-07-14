# Review Request: task #379 讨论 / 执行门禁提示词

Review-Target-ID: `task-379-discussion-execution-gate`
Branch: `feature/slock-like-webui`
Commit: `2fc94b9`

## What

在 shared-rules 与 SystemPromptBuilder 双写“先判讨论/执行”的反向条款。讨论阶段只分析、给选项、收敛，不 claim、不发 ack、不建 task、不行首 @、不切工单；明确“开工/按这个做/安排/执行”后才进入 claim → ack → 执行 → 交付。

静态 identity 与每轮动态 Task Gate 都注入，保证新 session、minimal toolbox 和 resume 长会话一致。

## Why

现有提示词有强 action bias，但缺少对等的 discussion gate；长会话 resume 又会跳过 static identity，因此只补静态文案仍会在真实运行中失效。

## Original Requirements

> 用户在陈述目标、发散讨论、征求意见，且未给明确执行口令时：只做听清、分析和选项、收敛方案。
> 不建 task、不行首 @ 任何猫、不切工单。
> 判定阶段在前，是任务才适用行动条款。
> “开工”后照常认领执行；真实场景做讨论→执行口令双测。

- 来源：`#clowderAI:468d8ca7`，批准 `2e8041b4`，规格 `3647bc19`
- 请对照原文判断是否既“踩住离合”，又没有拆掉 claim-first/ack-first 油门。

## Tradeoff

- 不新增 NLP 分类器或状态机，只做明确提示词优先级。
- static + dynamic 有少量文案重复，换取 resume session 不漏门禁。
- 不改共享 Intent Snapshot 词表，避免影响其他消费者。

## Open Questions

1. 动态 Task Gate 的讨论条款是否足以覆盖 resume session？
2. `不认领/不发 ack` 与现有 ack-first、claim-first 是否无歧义共存？
3. minimal/standard/full 以及没有 runtime surface 的场景是否都能看到正确边界？

## Next Action

请 @专家-Claude 按 P0/P1/P2/P3 做最终 gate。PASS 后从 committed HEAD 重建/重启 3004，并执行一个隔离 thread 的真实双测：讨论消息无 task/ack/@，随后执行口令正常 claim/ack/交付。

## Review Sandbox

- Path: `/tmp/cat-cafe-review/task-379-discussion-execution-gate/claude`
- Start Command: `pnpm review:start`
- Ports: 未启动；无前端改动，评审使用 committed diff、prompt unit test 与本地 API smoke。

## 自检证据

- TDD 红：新断言首先因 shared-rules 无阶段条款失败。
- 定向：discussion + claim + progress + size 4/4。
- SystemPromptBuilder 全文件：133/134；唯一失败为既有 `.cat-cafe/LESSONS.md` 缺失 fixture，与本票无关。
- API build：PASS。
- Biome lint（两个代码/测试文件）：PASS。
- `git diff --check`：PASS。
- task-owned staged diff：只含 shared-rules 本票 hunk、SystemPromptBuilder、测试；shared-rules 既有 9 行用户脏改未提交。
- 无前端、无根目录媒体/设计工件、无 `.pen`。
