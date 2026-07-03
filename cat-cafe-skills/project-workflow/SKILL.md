---
name: project-workflow
display_name: 项目工作流接手员
description: >
  Use when: continuing, taking over, reviewing, or handing off a Clowder long-running project using `.cat-cafe/projects/{projectId}` fact sources.
  Not for: creating the scaffold (use `project-init`), one-off Q&A, or trivial local edits with no durable project state.
  Output: takeover summary + next-step plan + necessary fact-source updates or review risk report.
  GOTCHA: read brief/progress/decisions/handoff-index first; do not load every handoff, handoff-log, or full chat history by default.
triggers:
  - "/continue-project"
  - "/project-status"
  - "继续推进"
  - "接手项目"
  - "项目工作流"
  - "看下当前进度"
  - "项目状态"
  - "当前进度"
  - "项目进度"
  - "写交接"
  - "判断影响范围"
  - "review 任务"
  - "验收任务"
---

# 项目工作流接手员

## 目标

让 agent 以项目事实源为准推进长期任务，而不是只依赖当前聊天上下文。

本 skill 参考 `ai-project-workflow-skill` 的三层模型，但按 Clowder 的项目目录和任务系统轻量化。

## Quick Reference

- `project-init`：只负责创建 `.cat-cafe/projects/<projectId>/` 骨架。
- `project-workflow`：负责接手、推进、交接、影响面判断和 review。
- 主会话是决策室；task thread 是执行现场；项目事实源是长期记忆。
- 接手默认只读四件套：`brief.md`、`progress.md`、`decisions.md`、`handoff-index.md`。

## 适用场景

使用本 skill：

- 用户说“继续推进某项目”。
- 用户要求接手、交接、恢复上下文。
- 任务涉及项目进度、长期决策、验收、review。
- 上下文被压缩后需要恢复方向。
- 需要判断是复用已有 workflow，还是探索新问题。

不要使用本 skill：

- 一次性小问答。
- 不影响项目状态的纯解释。
- 明确指定的一行/小范围代码修复，且不需要项目事实源。
- 本地服务启动/重启，除非用户要求记录到项目进度。

## 层级选择

### Layer 1：项目推进

默认层。

读取：

```text
.cat-cafe/projects/<projectId>/brief.md
.cat-cafe/projects/<projectId>/progress.md
.cat-cafe/projects/<projectId>/decisions.md
.cat-cafe/projects/<projectId>/handoff-index.md
```

输出：

- 接手摘要
- 下一步计划
- progress 更新建议
- 必要时更新 handoff index

参考：`refs/context-contract.md`

### Layer 2：代码理解

当任务涉及系统结构、模块边界、API 契约或影响面时启用。

优先查：

```text
docs/project/system-map.md
docs/project/modules.md
docs/project/api-index/
```

没有现成资料时，只刷新当前任务相关切片，不做全仓库大地图。

### Layer 3：审查验收

当任务进入 review、验收、合并判断、风险评估时启用。

起点：

```bash
git status --short
git diff HEAD
```

输出：

- Findings first
- P0/P1/P2 风险
- 文件/行号
- 验证结果
- 未验证项

参考：`refs/review-checklist.md`

## 接手流程

1. 确认 `projectId`。
2. 读取项目事实源四件套：brief、progress、decisions、handoff-index。
3. 不默认读取所有 handoff 或 handoff-log。
4. 输出接手摘要：

```markdown
我接手到的项目状态：
- 当前目标：
- 最近完成：
- 当前阻塞：
- 下一步建议：
- 需要先确认：
```

5. 若没有阻塞问题，再执行任务。

## 写入规则

### 更新 `progress.md`

只有项目阶段、完成项、进行中、待办或验收状态发生变化时更新。

### 更新 `decisions.md`

只有用户/ reviewer 明确拍板长期决策时更新。

### 更新 `handoff-index.md`

只有新增 durable handoff 或接手入口变化时更新。

### 追加 `handoff-log.md`

只用于自动化交接流水；人工接手优先看 `handoff-index.md`。

## Common Mistakes

| 错误 | 后果 | 修复 |
|------|------|------|
| 接手时直接读完整聊天历史 | prompt 变大且混入过时信息 | 先读项目事实源四件套 |
| 把 `handoff-log.md` 当接手入口 | 流水账噪声会压过当前状态 | 先读 `handoff-index.md` |
| 把项目初始化和项目推进混在一个 skill | 路由边界不清，容易误触发 | 新项目用 `project-init`，后续推进用本 skill |
| review 先写总结再列风险 | 严重问题被埋掉 | Findings first，按 P0/P1/P2 输出 |
| 每个小动作都更新 `progress.md` | 事实源变成日志，难以扫描 | 只记录阶段、完成项、待办、验收状态变化 |

## 输出要求

日常接手：

- 先给短摘要。
- 再给下一步。
- 不把完整文件内容铺进主会话。

Review：

- Findings first。
- 如果没有发现问题，明确说“未发现阻塞问题”，并说明未验证项。

交付：

- 说明改了什么。
- 说明验证了什么。
- 给出文件或 commit。
- 标明剩余风险。

## 参考文档

- `docs/project-context-contract.md`
- `docs/project-workflow-pack.md`
- `refs/context-contract.md`
- `refs/handoff-template.md`
- `refs/review-checklist.md`
