---
feature_ids: []
topics: [kimi, cli-session, self-heal]
doc_kind: bug-report
created: 2026-08-04
---

# Kimi 失效会话未自愈

## 报告人

铲屎官发现 Clowder 的 Kimi 无法回复；Codex 于 2026-08-04 复现并定位。

## Bug 诊断胶囊

| 栏位 | 内容 |
|---|---|
| 1. 现象 | Kimi 每次恢复同一历史会话后立即报错。期望：失效会话自动切换到新会话；实际：持续复用旧会话。 |
| 2. 证据 | 运行时 PID 93632；`/api/ready` 中 Redis、SQLite 均正常；`/api/cats` 含 `kimi`；日志多次出现 `Session "…" not found`，以及旧工作目录创建的 session 无法在当前目录恢复。 |
| 3. 问题假设或根因 | 已确认：`cli-spawn` 将 Kimi stderr 脱敏成普通 code 1 错误，但没有附加缺失会话 reason code；上层因此走“原会话重试”，而不是现有的“清指针并无会话重试”。 |
| 4. 诊断策略 | 从 Kimi stderr 逆向追踪到 `formatCliExitError`、`classifyResumeFailure` 和 `invoke-single-cat` 的重试分支，并对照 Claude/Codex 已工作的缺失会话路径。 |
| 5. 超时策略 | 若一次最小分类修复不能使定向测试通过，停止叠加补丁，重新检查事件格式和 session-chain 替换时序。 |
| 6. 预警策略 | 若 fresh retry 仍携带旧 session、没有恢复 system prompt，或成功后旧链仍被再次选中，则方案不成立。 |
| 7. 用户可见交互修正 | 旧 Kimi 原生会话不可恢复时，首轮错误不再暴露给用户；系统自动建立新会话并继续回复。 |
| 8. 验收 | 新增 Kimi stderr 分类测试与无会话自愈测试；API build、定向测试通过；部署后实际 Kimi smoke 成功且日志出现新 session 绑定。 |

## 复现步骤

1. 在 Clowder 线程中保留一个 Kimi CLI 已删除或来自其他工作目录的 session pointer。
2. 再次调用 Kimi。
3. CLI 退出 code 1，Clowder 第二次调用仍带相同 `--session`，最终返回错误。

## 根因分析

Kimi 适配器正确传入了持久化 session，但底层 stderr 分类仅识别 thinking signature 和 Codex rollout 缺失。Kimi 的 `Session "…" not found` / `was created under a different directory` 没有进入 provider-neutral 的 `missing_session` 路径，因此通用自愈逻辑没有删除失效 pointer，也没有令第二次调用变成 fresh invocation。

## 修复方案

- 在通用 CLI stderr 分类中仅把两种可确认的 Kimi resume 失败标记为 `missing_session`。
- 在 resume failure 分类中识别该 reason code，复用现有一次性 fresh retry。
- 不手工删除 Redis 或 session-chain 数据；fresh invocation 的 `session_init` 负责替换并封存旧链。

## 验证方式

- 失败测试先证明旧实现不会标记 Kimi missing session，且第二次仍携带旧 session。
- 最小实现后重跑定向测试、API build 和相关全量检查。
- 经明确的 runtime 重启后，在原问题线程做一次 Kimi smoke，并复核健康端点与日志。
