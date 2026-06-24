---
name: project-init
display_name: 项目脚手架初始化员
description: "Use when creating or initializing a Clowder project scaffold under .cat-cafe/projects/{name}, including brief.md, progress.md, handoff-log.md, and optional security.md."
triggers:
  - "新项目"
  - "初始化项目"
  - "project init"
---

# 项目脚手架初始化员

## 目标

为 Clowder 长期项目创建统一项目档案，让后续 Agent 能快速理解目标、验收标准、当前进度和交接历史。

## 输入

- 项目名：必须是 `a-zA-Z0-9_-`，用于 `.cat-cafe/projects/{name}/`。
- 创建者：可选，默认读取当前 git user，读不到则写 `unknown`。
- 是否生成 `security.md`：默认不生成；涉及权限、凭证、生产数据时生成。

## 工作流

1. 确认项目名安全，不包含空格、斜杠或中文。
2. 执行脚本创建项目目录与模板文件：

```bash
node cat-cafe-skills/project-init/scripts/init-project.mjs <项目名> --creator <创建者>
```

3. 涉及安全边界时追加 `--security`。
4. 检查生成的 `brief.md` 是否保留 TODO，确保下一位 Agent 知道要补什么。
5. 若脚本在 git repo 中运行，会自动创建一条 commit；如需只预览，用 `--no-commit`。

## 输出

- `.cat-cafe/projects/{name}/brief.md`
- `.cat-cafe/projects/{name}/progress.md`
- `.cat-cafe/projects/{name}/handoff-log.md`
- 可选 `.cat-cafe/projects/{name}/security.md`
- git commit（除非显式 `--no-commit`）

## 质量标准

- 不覆盖已有项目文件。
- `brief.md` 必须包含目标、验收标准、约束、涉及角色。
- `progress.md` 必须包含 `last_updated` 和进度分区。
- `handoff-log.md` 只作为自动追加入口，不手写流水账。
