---
feature_ids: []
topics:
  - grok
  - provider
  - permissions
  - security
  - mcp
doc_kind: decision
created: 2026-07-18
decision_id: ADR-025
---

# ADR-025：Grok trusted headless 权限边界

> 状态：已接受
>
> 决策者：铲屎官（明确授权）；实现与验收：Clowder AI 团队

## 背景

最初的无头终端取消修复采用 `permission-mode=default` 与窄 `--allow` 清单。后续真实工程任务仍被交互式权限确认中断，即使先后补入 `Bash`、`Write` 与 `Edit`。铲屎官随后明确要求 Grok 的权限“改到跟 Claude 一样”；Claude provider 的对应 headless profile 使用 `bypassPermissions`。

历史证据包括：2026-07-18 的明确授权记录、实现提交 `d7c13201`，以及随后真实工具调用和交叉验收通过。原 bug report 的窄权限结论是阶段性正确结果，但未随本决策更新，造成实现与文档相互矛盾。

## 决策

Grok 的 trusted headless profile 使用：

```text
--permission-mode bypassPermissions
--allow MCPTool(cat-cafe-clowder-runtime__*)
--allow Bash
--allow Write
--allow Edit
```

这四条 allow 是**能力文档，不是安全边界**：在 `bypassPermissions` 下，Grok 的内置工具通常会自动获得批准，不能把 allow 清单误解成系统级 deny-list。

## 保留的边界

- 每次调用创建临时、隔离的 `GROK_HOME`，关闭 Claude/Cursor 兼容 MCP 导入，只注册 Cat Cafe MCP server。
- MCP bridge 只接收调用所需的 callback 环境变量；账号 API key 和回调 token 都不写入 `config.toml`，桥接源码也不含账号 API key。
- Cat Cafe MCP callback 继续执行身份、任务、工作区与只读等服务端权限校验。
- Grok 的 deny rules、hooks 与管理员锁若在运行环境配置，仍能阻止相应操作。

## 明确接受的风险

本决策**无 OS 级沙箱**。Grok 的内置 `Bash`、`Write`、`Edit` 以 Clowder API 进程所在用户身份运行；隔离 `GROK_HOME` 只隔离 CLI 配置和 MCP 注册，不能约束内置工具的宿主权限。该风险由铲屎官针对 trusted automation profile 明确接受。

因此，安全测试必须验证 MCP 运行时隔离和机密不落盘，但不得把 `--allow` 当成“未列工具被拒绝”的安全断言。任何回到窄权限、扩大宿主能力或切换到非 trusted profile 的变更，都需要新的决策与真实 smoke。

## 后果与验证

- `GrokAgentService` 中的参数注释必须准确说明 bypass 的语义，避免“未知工具仍受门控”的误导。
- `security-boundary.test.js` 固定检查 permission mode、MCP 隔离、机密不泄露以及本 ADR 的存在。
- `grok-agent-service.test.js` 覆盖 subscription 模式的 `GROK_AUTH_PATH` 回落与显式宿主覆盖，防止隔离逻辑改变既有认证语义。

## 2026-08-13 补充：Grok Skills 隔离快照

Clowder 中的 Grok 需要使用 `~/.grok/skills` 与 `~/.grok/bundled/skills`，但不得因此把完整宿主 Home 透传给临时运行目录。

- 禁止把源 Skills 目录直接 symlink 到临时 `GROK_HOME`：symlink 不提供只读边界，trusted headless 工具可写入链接目标。
- 禁止透传完整 `~/.grok`：凭据、日志、插件、Hooks、配置与历史不属于本能力范围。
- 每次 invocation 只把含有效 `SKILL.md` 的用户和 bundled Skill 复制到临时快照；用户顶层链接在复制时解引用。
- 单个 Skill 缺失、损坏或复制失败应降级跳过并聚合告警；临时 Home 的基础配置无法建立时才终止调用。
- 临时副本沿用 Grok 原生的用户优先于 bundled 的同名解析规则，并在 invocation 结束后清理。

该补充不改变 `bypassPermissions` 决策，也不新增 OS 级沙箱声明。
