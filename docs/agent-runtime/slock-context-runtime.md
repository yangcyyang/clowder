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

## 本轮实现

本轮先做“可见性”，不先做激进裁剪。

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

## 后续 Phase 3

等运行数据稳定后，再做自动裁剪：

- minimal：强制不注入历史，只保留当前消息。
- standard：只保留当前 thread 摘要 + 最近 N 条。
- full：允许加载重资料，但必须有 token 上限和质量提示。
- 运行态如果 `estimatedTokens` 超过阈值，自动降级为摘要模式。
