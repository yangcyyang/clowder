---
feature_ids:
  - a1-history-governance
topics:
  - branch-convergence
  - personal-skills
  - quick-switch
doc_kind: worklog
created: 2026-07-05
---

# a1 收敛第一批低风险搬运工作记录

## 范围

从 `codex/a1-history-governance-observe` 选择性搬运低风险 commit 到
`codex/a1-converge-lowrisk`，不直接 merge 整个 a1 分支。

## 已搬 commit

- `cec419e` -> `cdf8ab0`：个人 skill 库方案文档。
- `cba6696` -> `01637e1`：个人 skill collection scanner、rebuild 脚本、测试。
- `1cb5335` -> `2a2c760`：StartupReconciler 遇到目标猫已回复时不重复 requeue。
- `92c0b0c` -> `45ba574`：QuickSwitch palette 和全局搜索接线。

## 手工合并说明

- `packages/api/src/config/env-registry.ts` 与主线冲突，已保留主线内容并补入 a1 的 env 注册项。
- QuickSwitch 原 commit 有一个 build lint 问题：`score` 解构变量未使用。已在 `45ba574` 中改为显式映射字段。

## 验证

- `pnpm --filter @cat-cafe/api build`：通过。
- `node --test packages/api/test/personal-skill-scanner.test.js`：3/3 通过。
- `node --test packages/api/test/startup-reconciler.test.js`：28/28 通过。
- `pnpm --dir packages/web exec vitest run ...quick-switch...`：4 个文件、12/12 通过。
- `pnpm --filter @cat-cafe/web build`：通过，仅保留既有 lint warnings。

## 非本次问题

误跑过一次 `pnpm --filter @cat-cafe/web test -- ...`，实际触发了全量 web vitest。
结果为 411 个文件中 37 个失败，失败集中在既有 sidebar/session/thinking 等测试，
QuickSwitch 定向测试与 web build 均已单独验证通过。

## 交接建议

本分支可先交给 Claude 做代码审查。下一批不要直接碰 `SkillRouter` 或 history summary，
应先开独立 worktree 做 personal skill route / MCP / dashboard 的适配方案。
