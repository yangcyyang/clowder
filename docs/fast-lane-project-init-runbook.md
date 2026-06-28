---
feature_ids: []
topics: [orchestration, fast-lane, runbook]
doc_kind: runbook
created: 2026-06-29
author: 老者-codex
status: proposed
context: "project-init 快车道的启用、使用、验证和回退说明"
related:
  - docs/exec-fast-lane-mechanism.md
  - docs/fast-lane-phase0-audit.md
---

# project-init 快车道运行手册

## 1. 这是什么

`project-init` 是 Clowder 第一条真实快车道。

它只处理一种确定性任务：为一个已存在的项目根目录生成 `.cat-cafe/projects/<name>/` 项目档案。

命中后，它绕过完整 agent loop，直接运行本地脚本：

```text
cat-cafe-skills/project-init/scripts/init-project.mjs --no-commit
```

目标不是替代 agent，而是把“输入明确、流程固定、风险可控”的重复动作先固化下来。

## 2. 如何开启

默认关闭：

```bash
CAT_CAFE_FAST_LANE=0
```

启用：

```bash
CAT_CAFE_FAST_LANE=1
```

如果由 PM2 托管，需要把环境变量加到 PM2 启动配置或当前 shell 后重启 API 服务。

不要在未确认运行态配置来源前直接改全局环境变量。

## 3. 如何触发

必须使用显式命令格式：

```text
/project-init <project-name> --root <absolute-project-root> [--creator <name>] [--security]
```

示例：

```text
/project-init wechat-cli --root "/Users/cy/Documents/03 life/AI design/产品项目/微信CLI" --creator yangcyyang --security
```

以下输入不会触发快车道，会回到 slow lane：

- “帮我初始化一个项目”
- “讨论一下 project-init”
- “/project-init wechat-cli”
- “/project-init wechat-cli --root ./relative-path”
- 带附件或 `contentBlocks` 的消息

## 4. 安全边界

快车道只在高确定性场景执行：

- `CAT_CAFE_FAST_LANE` 必须显式开启。
- 消息必须是纯文本。
- 项目名必须符合安全正则。
- `--root` 必须是已存在的绝对路径。
- 写入范围限定在 `<root>/.cat-cafe/projects/<project-name>/`。
- 脚本强制使用 `--no-commit`，不会自动提交 git。
- 脚本超时 15 秒，输出缓冲上限 1MB。

回退策略分两类：

- preflight 不确定：fail-open，写 `fast_lane_decision` 后回到 slow lane。
- 脚本已执行但失败：fail-closed，写 `fast_lane_failed`，不静默重跑 slow lane。

## 5. 成功产物

成功后应生成：

```text
.cat-cafe/projects/<project-name>/
├── brief.md
├── progress.md
├── handoff-log.md
└── security.md   # 仅传 --security 时生成
```

同时会写入 artifact task event，记录文件清单和新增/删除行数。

## 6. 如何验收

运行基础验证：

```bash
pnpm --dir packages/shared build
pnpm --dir packages/api exec tsc --noEmit --pretty false
pnpm --dir packages/api build
node --test packages/api/test/queue-processor.test.js
node --test packages/api/test/tasks-route.test.js
```

运行态验收时，检查 task event：

- `fast_lane_decision`
- `fast_lane_started`
- `fast_lane_completed`
- `artifact`

`fast_lane_completed` 应包含：

```json
{
  "workflowId": "project-init",
  "routeExecutionBypassed": true,
  "durationMs": 123,
  "tokenUsage": {
    "inputTokens": 0,
    "outputTokens": 0,
    "totalTokens": 0,
    "costUsd": 0
  }
}
```

收益判断：

- fast lane 不调用模型，`totalTokens` 应为 `0`。
- `routeExecutionBypassed` 应为 `true`。
- 同类初始化任务不再进入完整 agent loop。

## 7. 常见问题

### 没有触发快车道

按顺序检查：

1. `CAT_CAFE_FAST_LANE` 是否为 `1`。
2. 消息是否以 `/project-init` 开头。
3. 是否包含 `<project-name>`。
4. `--root` 是否是已存在的绝对路径。
5. 消息是否带附件或 `contentBlocks`。
6. 是否包含未知 token；未知 token 会让 parser 返回 slow lane。

### 触发后失败

检查 `fast_lane_failed` event：

- `exitCode`
- `durationMs`
- `stderr`
- `message`

如果是目录已存在、权限不足或路径不符合预期，不要自动改走 slow lane。

这类失败说明确定性脚本已经接管任务，应该让用户或执行者修正输入后重试。

## 8. 后续边界

当前只把 `project-init` 做成快车道。

Phase 3 的 observe→freeze→wire→measure 暂缓，后续再基于 task events 做重复链路识别：

```text
toolSequenceHash + commandsHash
7 天内重复 ≥ 3 次
进入候选池，只提示，不自动上线
```

这能避免一次性把过多 workflow 塞进快车道，降低误判风险。
