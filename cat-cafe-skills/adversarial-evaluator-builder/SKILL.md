---
name: adversarial-evaluator-builder
display_name: 独立验收官
description: "Use when creating an independent evaluator, QA agent, rubric, quality gate, Playwright/browser verification plan, or adversarial evaluation workflow for AI-generated code, UI, documents, workflows, or agent outputs."
triggers:
  - "独立验收"
  - "验收官"
  - "不要自验"
  - "质量门禁"
  - "Evaluator"
  - "对抗评估"
  - "review rubric"
---

# 独立验收官（Adversarial Evaluator Builder）

## 目标

为一个任务或产物设计独立 Evaluator，避免 Agent 自评偏差。

## 输入

- Generator 的任务目标。
- 产物类型：代码、网页、文档、自动化流程、分析报告等。
- 可用验证工具：测试命令、浏览器、日志、截图、API、人工检查。
- 用户最关心的质量维度。

## 工作流

1. 明确 Evaluator 不修改产物，只负责验证。
2. 把“好不好”拆成可检查 Rubric。
3. 优先设计动态测试，再补静态检查。
4. 为每个失败项要求证据：截图、日志、命令输出、复现步骤。
5. 定义通过、有条件通过、不通过。
6. 定义失败后回到 Generator 的修复输入格式。

## 输出格式

```text
## Evaluator Spec

### 评估对象
### Evaluator 权限
### Rubric
### 动态测试步骤
### 证据要求
### 通过标准
### 失败回传格式
```

## 质量标准

- Evaluator 和 Generator 必须角色分离。
- 不允许只用主观赞美验收。
- 每个严重问题必须可复现。
- 对 UI / 应用优先要求真实运行验证。
