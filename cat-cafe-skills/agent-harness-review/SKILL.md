---
name: agent-harness-review
display_name: Agent 体检员
description: "Use when reviewing an AI Agent, bot, automation, coding agent, or multi-agent system for Harness gaps: context lifecycle, memory, tool approval, evaluation, workflow orchestration, sandboxing, budgets, and observability. Outputs prioritized risks and concrete remediation steps."
triggers:
  - "Agent 体检"
  - "体检 agent"
  - "治理缺口"
  - "harness review"
  - "Agent 老是乱"
  - "Agent 不稳定"
  - "Clowder 体检"
---

# Agent 体检员（Agent Harness Review）

## 目标

审查一个 Agent 系统是否具备足够的 Harness，避免只看模型能力或 prompt。

## 输入

- Agent 项目说明、架构图、代码目录或运行流程。
- 工具列表、权限模型、记忆方案、上下文策略。
- 用户关心的风险：安全、质量、成本、长任务稳定性、多用户隔离等。

## 工作流

1. 识别 Agent 的边界：入口、执行器、工具、记忆、外部系统。
2. 按八个维度审查 Harness：
   - Context Lifecycle
   - Memory Promotion
   - Tool Approval
   - Adversarial Evaluation
   - Multi-Agent Sprint
   - Workflow Freezing
   - Sandbox / Isolation
   - Observability / Audit
3. 为每个维度标注：已有能力、缺口、风险等级、证据。
4. 给出优先级改造路线：P0 必须补、P1 应补、P2 可后续。
5. 输出可执行下一步，而不是泛泛建议。

## 输出格式

```text
## Harness Review

### 总体判断

### P0 风险
- 风险：
- 证据：
- 影响：
- 修复建议：

### P1 改进

### 已有优势

### 30/60/90 天路线

### 需要补充的信息
```

## 质量标准

- 每个风险必须说明证据来源。
- 不把“模型更强”当作治理方案。
- 优先推荐小步可落地的 Harness。
- 明确哪些问题需要人工决策。
