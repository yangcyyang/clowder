---
feature_ids: []
topics:
  - grok
  - provider
  - permissions
doc_kind: bug-report
created: 2026-07-14
---

# Grok 无头终端权限取消 Bug Report

## 报告人

@yangcyyang 观察到荧荧在频道中先回复“开工”，但一进入终端实作就静默结束。@专家-Claude 从 Grok session 事件中找到两次相同的权限取消轨迹，由 task #370 进入修复。

## Bug 诊断胶囊

| 栏位 | 内容 |
|------|------|
| **1. 现象** | 期望 Grok 无头回合能执行终端命令并完成任务；实际上 `run_terminal_command` 等待无人确认的权限框，约 15 秒后取消整个 turn，已流式输出的半截文本却被当成正常最终回复。 |
| **2. 证据** | `GrokAgentService.ts` 只传入 `--permission-mode auto` 和 MCP namespace allow。真实 session 在 23:26:43 与 23:35:15 分别记录 `run_terminal_command -> decision=cancelled -> wait_ms=15012/15018 -> turn_ended outcome=cancelled`。 |
| **3. 确认根因** | 根因 A：Grok 内部事件名是 `run_terminal_command`，但 CLI 权限规则使用 Claude 兼容前缀 `Bash`；现有 MCP allow 不覆盖 shell。根因 B：`grok-event-transform.ts` 保留了 `end.stopReason`，`GrokAgentService` 却忽略它并无条件 yield `done`。 |
| **4. 诊断策略** | 对照 Grok 0.2.93 本地官方文档的 permission rule，逆向追踪 session event -> Grok event transform -> AgentMessage，再以 service 层失败测试锁定两个断点。 |
| **5. 超时策略** | 30 分钟内若无法确认 allow 语法，停止猜测，以 CLI 内置文档和最小真实 smoke 为唯一裁决证据。 |
| **6. 预警策略** | 若需要 `bypassPermissions` / `--always-approve` 才能通过，或未 allow 的其他工具也被自动批准，立即判定方向错误。 |
| **7. 用户可见交互修正** | 权限取消时明确显示“终端工具未通过权限确认，本轮未完成”，不再把半截承诺当成成功回复。 |
| **8. 验收** | RED/GREEN 锁定 `permission-mode=default` + `--allow Bash`、禁止 blanket bypass、`Cancelled` 在 partial text 之后产生明确 error；完全使用生产参数的正向 smoke 写入 `/tmp/clowder-grok-bash-production-positive-95174.txt`，负向 smoke 触发未 allow 的 `Write` 并确认文件未落盘、结果为 `permission_cancelled`。 |

## 根因分析

Grok CLI 0.2.93 的真实工具事件名是 `run_terminal_command`，但 `--allow` 规则对 shell 使用 `Bash(...)` 前缀。裸 `Bash` 只自动批准这一个工具类型，不等于批准所有工具。当前 spawn 参数只显式允许 Cat Cafe MCP namespace，所以无头运行的 shell 必然进入无人回答的交互式确认。

真实负向复验还发现：旧参数 `permission-mode=auto` 会让未显式 allow 的 `Write` 直接落盘，不能证明“未来新工具仍走门”。因此基线必须使用 `default`，再以独立 allow 精确放行 MCP namespace 与 `Bash`；这样终端任务保持无头可用，未列入清单的副作用工具仍进入权限门。

第二个断点在 provider 适配层：`end.stopReason` 已被 parser 保留，但 service 没有将取消态映射为 `AgentMessage(type='error')`，流结束后还是无条件发出 `done`。上层因此只看到 partial text + done，无法知道任务中途失败。

第三个断点在终态消费层：`QueueProcessor` 过去没有读取 `done.errorCode`，会继续把 invocation 标成 `succeeded`，并可能将 partial text 作为完整外发结果；`RunLedgerAssembler` 还会把包含 `cancel` 的权限失败误归类为 `user_canceled`。

## 修复方案

1. 将 permission mode 从 `auto` 收紧为 `default`，在现有 MCP allow 之外追加独立的 `--allow Bash`，仅放行终端工具类型。
2. 对 Grok `end.stopReason` 做大小写无关的 cancelled 判定，在 `done` 之前 yield 一条明确 error，并在终态携带 `permission_cancelled`。
3. `QueueProcessor` 收到 provider 终态错误后将 invocation 标为 `failed`，不外发 partial text，也不生成 completed replacement。
4. Connector streaming placeholder 使用独立的 `onStreamFailure` 收口：将 partial placeholder 原位替换为失败提示，并覆盖 placeholder 创建晚于失败的竞态，不显示正常完成态。
5. `RunLedgerAssembler` 将 `permission_cancelled` 归类为 `tool_failed`，避免误报成用户主动取消。

放弃的备选：`bypassPermissions`、`--always-approve`、将所有工具统一 allow。这些都超出本 bug 的最小权限边界。

## 验证方式

- 参数单测：permission mode 为 `default`，同时存在 MCP namespace 与 `Bash` 两条 allow，且不存在 blanket bypass。
- provider 单测：partial text 后收到 `stopReason=Cancelled` 时，消息序列为 `text -> error -> session_init -> done`，error 与 done 均带 `permission_cancelled`；前置普通 stream error 不能吞掉权限专属错误；`AbortSignal` 主动取消不被误判。
- 队列/账本单测：明确终态 `done.errorCode` 会使 invocation 失败、禁止 partial 外发，并在 RunLedger 中归类为 `tool_failed`；可恢复的中间 `error.errorCode` 不会被误升级为终态失败。
- connector 单测：active partial placeholder 与 failure-before-start 两种时序都被原位替换为失败提示，不走正常完成清理。
- 无回归：API lint/build 与 Grok provider、QueueProcessor、RunLedger 定向测试全绿。
- 真实正向 smoke：完全使用生产参数，强制调用 `run_terminal_command`，在 `/tmp/clowder-grok-bash-production-positive-95174.txt` 写入精确内容 `GROK_BASH_PERMISSION_OK_V2`；文件存在、内容精确、无 errorCode、回合正常 `done`。
- 真实负向 smoke：完全使用同一生产参数，强制调用未 allow 的 `Write` 写 `/tmp/clowder-grok-write-production-negative-95174.txt`。确认文件不存在，消息序列为 `system_info -> error -> session_init -> done`，error/done 均带 `permission_cancelled`，错误文案明确本轮未完成。

## Quality Gate

- 原始需求：task #370 / `#clowderAI:13e17dfa`，三条验收为“终端工具窄放行、权限取消诚实失败、生产参数正反双 smoke”。
- 设计稿：`designs/**/*.pen` 无 Grok/permission/task-370 匹配；本任务无 Web UI 改动。
- 工件卫生：工作树与 `origin/HEAD...HEAD` 均无仓库根目录媒体/设计工件。
- 静态与构建：API build、API lint、`git diff --check`、workspace 全量 build 通过。
- 定向回归：provider + RunLedger + StreamingOutboundHook 42/42；Queue 关键回归 2/2。
- 已知基线：QueueProcessor 全文件 107/109，剩余两项为任务前已存在的 connector batching 失败；仓库全量测试仍为既有 Web 37 files / 81 tests 失败；`pnpm check` 仍被仓库外 `~/.claude/skills/gstack` 与既有格式问题阻断。本提交未修改这些范围。
- 独立终审：provider 权限、安全边界；Queue/RunLedger/connector 失败闭环；范围与验收三路复审均为 PASS，P1/P2/P3 清零。
- 运行态：未重启、未改 live 配置，验证来自当前 worktree 与真实 Grok CLI 调用。
