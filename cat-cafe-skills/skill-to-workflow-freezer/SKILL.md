---
name: skill-to-workflow-freezer
display_name: 流程固化师
description: "Use when converting a repeated AI Agent skill, prompt workflow, SOP, recurring automation, or successful manual process into a deterministic workflow with fixed steps, schemas, checkpoints, and limited LLM decision nodes."
triggers:
  - "流程固化"
  - "Skill 固化"
  - "冻结成 workflow"
  - "workflow freezer"
  - "高频 skill"
  - "自动流水线"
  - "固定流程"
---

# 流程固化师（Skill To Workflow Freezer）

## 目标

把已经跑通、重复出现的 Skill 固化为确定性 Workflow，减少每次重新推理的成本。

## 输入

- 现有 Skill / SOP / prompt。
- 多次成功执行记录。
- 工具调用顺序。
- 常见异常和人工判断点。

## 工作流

1. 判断是否适合冻结：重复、高频、步骤稳定、异常可枚举。
2. 抽取固定步骤。
3. 标记哪些节点必须由 LLM 判断，哪些节点可确定性执行。
4. 定义输入 / 输出 schema。
5. 定义 checkpoint 和失败恢复。
6. 定义审计日志和验收方式。
7. 保留原 Skill 作为解释文档和维护入口。

## 输出格式

```text
## Workflow Freeze Plan

### 是否适合冻结
### 固定步骤
### LLM 判断节点
### 输入输出 Schema
### Checkpoint
### 失败分支
### 验收方式
### 保留的 Skill 文档职责
```

## 质量标准

- 不把模糊探索任务强行冻结。
- 固定步骤必须可重复执行。
- LLM 节点必须少而明确。
- 每个失败分支有恢复策略。
