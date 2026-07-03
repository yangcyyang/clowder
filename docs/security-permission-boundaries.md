---
doc_kind: reference
topics: [security, permissions, mcp, obsidian, capability]
created: "2026-07-03"
updated: "2026-07-03"
---

# Clowder 权限边界两层说明

> 一句话：OS 权限、文件系统权限、进程隔离和远端账号授权才是真边界；Clowder 的开关、预览、确认弹窗、只读索引和审计记录是安全网。

## Layer 1: Real Boundary

真实边界来自运行环境本身：

- macOS / Linux / Windows 的文件系统权限、TCC、用户账号权限
- 本地进程能访问的命令、网络、环境变量和凭据
- 远端服务账号的 OAuth scope、API key 权限和服务端策略
- 容器、沙箱、专用用户、只读挂载等操作系统级隔离

如果一个本地 MCP 进程本身能读某个目录，Clowder 的 UI 文案不能把它变成操作系统级不可读。

## Layer 2: Clowder Safety Net

Clowder 提供的是安全网，不是替代真实权限边界：

- 能力开关：控制某个 MCP / Skill / 插件是否进入当前 agent 可用能力列表
- 按猫启用：控制哪些 agent 可以看到某项能力
- 安装预览：在写配置前展示来源、命令、URL、环境变量和风险
- 确认弹窗：对高风险外部写入、批量操作、凭据访问做显式确认
- 只读索引：对 Obsidian / 外部目录只读取内容并写入 Clowder 缓存，不回写原目录
- 审计记录：记录能力变更、危险动作和工具使用证据，便于追责和复盘

安全网的目标是减少误触、提高可见性和留下证据；它不能保证第三方工具本身一定安全。

## Figma / opencli / MCP

Figma、opencli、浏览器自动化和其他 MCP 工具都必须用两层表述：

- 真实边界：本地进程权限、浏览器会话权限、Figma 账号权限、远端服务授权
- Clowder 安全网：安装预览、默认关闭、按任务启用、确认弹窗、审计记录

不要写成“Clowder 已经沙箱隔离该 MCP”。除非真的引入了 OS 级沙箱或容器隔离，否则只能说“Clowder 会 gate / preview / audit”。

## Obsidian / Read-Only Collections

Obsidian 只读知识库的边界也分两层：

- 真实边界：本机文件系统权限和系统隐私权限决定 Clowder 进程能不能读 vault
- Clowder 安全网：只读扫描、跳过 `.obsidian/`、写索引缓存到 `~/.cat-cafe/library/`、不修改原 vault

Secret quarantine 只表示命中文件被排除在索引外；它不删除原文件、不轮换密钥，也不改变文件系统权限。

## UI Copy Contract

所有相关 UI 和文档都应避免绝对化承诺：

- 可以说：`实际访问范围由 OS/进程/远端账号权限决定`
- 可以说：`Clowder 提供预览、确认、开关和审计安全网`
- 不要说：`Clowder 已完全隔离该工具`
- 不要说：`只读集合等于文件系统只读挂载`
- 不要说：`安装预览保证该能力安全`
