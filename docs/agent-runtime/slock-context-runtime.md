# Slock-like Agent Context Runtime

## 目标

Clowder Agent 不应该在每次回复前读取完整频道。

更合理的模型是：只保证当前 surface 足够新，再按工具箱决定加载多少上下文。

## Slock 的处理方式

Slock 的 Agent 运行不是“扫全服务器历史”，而是按当前目标面工作：

```text
当前 channel / thread / DM
  → inbox freshness：先确认最新消息
  → session resume：复用上次运行态
  → thread memory / digest：长历史用摘要续接
  → tools：需要时才调用
```

核心原则：

- 只读当前 surface，不跨频道乱扫。
- 不把全频道原文塞进每次 prompt。
- 长历史靠 digest / resume，而不是每次重读。
- 工具按需加载，不默认背重工具包。

## Clowder 对齐规则

### minimal 轻量工具箱

适用：微信 DM 默认回复、Pi、简单问答。

应加载：

- 当前消息
- Agent 静态身份
- 必要 callback / MCP 指令

应跳过：

- Pack blocks
- World context
- Signal articles
- Always-on docs
- SOP hint
- Guide context
- Session bootstrap

### standard 标准工具箱

适用：Codex / Claude / Kimi 工程与需求类任务。

应加载：

- minimal 全部
- Pack blocks
- World context
- Session bootstrap / 历史摘要

应跳过：

- Signal articles
- Always-on docs
- SOP hint
- Guide context

### full 全量工具箱

适用：PPT、UI、设计系统、需要重资料的任务。

应加载：

- standard 全部
- Signal articles
- Always-on docs
- SOP hint
- Guide context

## Phase 2 实现

Phase 2 先做“可见性”，不先做激进裁剪。

每次 Agent invocation 创建时，后端会把 `contextBudget` 一起下发给前端：

- `toolPolicy`：minimal / standard / full
- `toolPolicySource`：默认 / 用户指定
- `estimatedTokens`：本次 prompt + system 估算 tokens
- `historyMessages`：本次纳入的历史消息数量
- `loadedBlocks`：实际加载的上下文块
- `skippedBlocks`：按工具箱跳过的上下文块
- `usesFullHistory`：是否接近全量历史
- `maxPromptTokens` / `maxContextTokens`：当前 Agent 预算

前端执行条会显示：

```text
执行中  Codex  标准·默认  12k/160k · 8条  0:08
```

鼠标悬停在预算标签上，可看到加载/跳过的上下文块明细。

## Phase 3 实现

Phase 3 开始把“成熟秘书”规则落到运行预算层：

- minimal：强制不注入历史，只保留当前消息 + 静态身份 + 必要 callback/MCP 指令。
- standard：从原始大窗口收缩到“最近必要窗口”。
  - 普通 channel：最多 40 条历史，最多 24k context tokens。
  - DM / 分支 thread：最多 24 条历史，最多 12k context tokens。
- full：保留原始大上下文能力，给深度调研、PPT、UI、设计系统等重任务使用。

同时增加默认降级：

- 用户显式写“轻度工具箱 / 标准工具箱 / 重度工具箱”时，以用户指定为准。
- Agent 默认是 `standard` 时，短问候、短问答会自动降到 `minimal`。
- 命中“修复 / 代码 / 报错 / 调研 / PPT / 文件 / API / Git”等重任务关键词时，不自动降级。

这让 Clowder 的默认行为更接近 Slock：

```text
先看当前房间
短问题少拿材料
重任务再拿重工具
```

## 后续 Phase 4

下一步再做摘要化，而不是只做截断：

- thread 中优先注入父消息摘要 + thread 最近回复。
- 超过阈值的旧历史写入 thread memory，再用摘要续接。
- 运行态如果 `estimatedTokens` 超过阈值，提示“上下文过重”，并建议切换摘要模式或轻量工具箱。
