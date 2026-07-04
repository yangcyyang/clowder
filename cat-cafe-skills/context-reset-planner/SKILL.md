---
name: context-reset-planner
display_name: 上下文接班规划师
description: "Use when designing context lifecycle, context compaction, context reset, session handoff, long-running task continuity, or prevention of context rot/anxiety for AI Agents and coding agents."
triggers:
  - "上下文接班"
  - "长任务续跑"
  - "handoff"
  - "context reset"
  - "上下文重置"
  - "Agent 跑久了"
  - "重启后继续"
---

# 上下文接班规划师（Context Reset Planner）

## 目标

为长任务 Agent 设计上下文生命周期，避免 session 越跑越脏。

## 输入

- 任务类型和平均时长。
- 当前上下文来源：对话、文件、工具输出、记忆、日志。
- 模型上下文窗口和成本约束。
- 是否允许新 session / 子 Agent / Handoff 文件。

## 工作流

1. 识别上下文来源，并区分必要信息与噪声。
2. 定义预算：prompt、工具输出、bootstrap、记忆召回、输出 reserve。
3. 设计两阶段轮换：
   - 60%-70% 使用率：同步状态，写 Handoff 草稿。
   - 80% 使用率或焦虑信号：Context Reset。
4. 对预计跨 session 或超过 1 小时的任务，先按 `refs/task-ledger-template.md` 建台账，记录目标、步骤、证据、断点、恢复指引。
5. 设计 Handoff 结构：目标、状态、决策、风险、下一步、验收标准。
6. 定义 reset 后 warm start：只加载 Handoff、任务台账、当前状态、必要规则。
7. 定义验证：新 session 是否能不读旧历史继续任务。

## 输出格式

```text
## Context Lifecycle Plan

### 上下文来源
### 预算设置
### 轮换触发条件
### 任务台账位置
### Handoff 模板
### Reset 流程
### 验证方式
### 风险与回退
```

## 质量标准

- 不只给“压缩摘要”，必须说明何时 reset。
- Handoff 不是聊天摘要，必须包含决策和下一步。
- 长任务必须指向任务台账；没有台账时，先建立再规划 reset。
- reset 后上下文要更小、更准、更可执行。
- 要保留人工接管入口。
