# Agent Toolbox Routing

Clowder Agent 的工具箱用于控制每次调用前加载多少上下文和工具说明。

目标不是削弱 Agent，而是避免轻任务默认背重包。

## 三档工具箱

### minimal 轻量工具箱

适用：默认回复、微信 DM、Pi、任务入口类 Agent。

加载范围：
- 当前用户消息
- Agent 静态身份
- 必要的基础 MCP 回调说明

跳过范围：
- Pack blocks
- World context
- Signal articles
- Always-on docs
- SOP hint
- Guide context
- Session bootstrap

### standard 标准工具箱

适用：Claude、Codex、Kimi、工程执行、需求分析、项目拆解。

加载范围：
- minimal 全部内容
- Pack blocks
- World context
- Session bootstrap / 历史摘要

跳过范围：
- Signal articles
- Always-on docs
- SOP hint
- Guide context

### full 全量工具箱

适用：PPT、UI、原型、Design Harness 等需要重资料和流程门禁的 Agent。

加载范围：
- standard 全部内容
- Signal articles
- Always-on docs
- SOP hint
- Guide context

## 当前 Agent 默认映射

minimal：
- `pi`
- `task-intake`
- `task-decomposer`

standard：
- `opus-45`
- `gpt52`
- `gemini`
- `gemini25`
- `opencode`
- `kimi`
- `cycc`
- `requirements-analyst`
- `project-decomposer`
- `engineer-agent`
- `review-assistant`

full：
- `ppt-designer`
- `prototype-designer`
- `ui-designer`
- `design-harness`

## 用户提示词覆盖

用户可以在消息里显式指定本轮工具箱，不改变 Agent 默认配置。

规则：
- `轻度工具箱` / `轻量模式` / `minimal` -> `minimal`
- `中度工具箱` / `标准工具箱` / `standard` -> `standard`
- `重度工具箱` / `全量模式` / `full` -> `full`

运行时优先级：

```text
effectiveToolPolicy = 用户提示词覆盖 ?? Agent 默认工具箱
```

## Phase 2 预留：自动升级规则

Phase 1 不做自动意图识别，只支持 Agent 默认值和用户显式覆盖。

Phase 2 可以增加动态升级：
- 用户要求查资料、读设计规范、引用外部材料 -> 升级到 `full`
- 用户要求简单回答、确认状态、微信闲聊 -> 保持 `minimal`
- 用户要求修 bug、写代码、排查问题 -> 使用 `standard`

自动升级必须可解释：运行态需要展示 `自动升级：standard -> full，原因：需要读取设计规范`。
