# Cat Cafe Skill 使用审计（2026-06-14）

## 结论

- 当前仓库 `cat-cafe-skills/*/SKILL.md` 实际有 43 个 live skill，不是 46 个。
- `skills-manifest.json` 中 `source=cat-cafe` 且 `clowder_available !== false` 的有 41 个。
- `SkillRouter` 当前最多注入 35 个菜单项，因此 manifest 里仍有 6 个可用 skill 不会进入菜单。
- 近 30 天 `tool-usage-archive.jsonl` 只记录到 1 个当前 live skill：`writing-skills`。
- 不建议按这份日志直接批量移动归档 42 个零调用 skill。原因是日志只覆盖工具调用归档，不覆盖 Skill Router 的 prompt 命中与人工按需读取，存在明显漏记。

## 数据口径

- 审计日期：2026-06-14
- 统计窗口：2026-05-15 起
- skill 根目录：`cat-cafe-skills`
- 使用日志：`.cat-cafe/tool-usage-archive.jsonl`
- manifest：`/Users/cy/Documents/03 life/AI design/产品项目/skill管理/skills-manifest.json`

## 使用记录

### 当前 live skill 命中

| Skill | 次数 |
| --- | ---: |
| `writing-skills` | 1 |

### 非当前 live skill / 外部 skill 命中

| Skill | 次数 | 说明 |
| --- | ---: | --- |
| `browse` | 4 | 不在 `cat-cafe-skills` live 目录内 |
| `kickoff` | 1 | 不在 `cat-cafe-skills` live 目录内 |
| `opencli-usage` | 1 | 不在 `cat-cafe-skills` live 目录内 |

## 零调用候选

这些 skill 在当前日志口径下没有近 30 天调用记录，但不能直接等同于“无价值”：

```text
adversarial-evaluator-builder
agent-harness-review
bootcamp-guide
browser-automation
browser-preview
clowder-agent-runtime-doctor
collaborative-thinking
console-dev
context-reset-planner
cross-cat-handoff
cross-thread-sync
debugging
deep-research
enterprise-workflow
expert-panel
feat-lifecycle
guide-authoring
guide-interaction
hyperfocus-brake
image-generation
incident-response
knowledge-engineering
memory-consolidator
merge-gate
open-source-teardown
pencil-design
ppt-agent
ppt-forge
quality-gate
receive-review
request-review
rich-messaging
schedule-tasks
self-evolution
skill-to-workflow-freezer
subagent-dispatch
tdd
update-skills-dashboard
video-forge
workspace-navigator
worktree
writing-plans
```

## 归档建议

### 立即归档

无。

本轮没有执行物理归档。批量移动 skill 目录会改变可用能力面，且当前使用日志不完整，风险高于收益。

### 观察期归档候选

- `hyperfocus-brake`：偏个人工作节奏，不是 Clowder 核心执行链。
- `video-forge`、`image-generation`、`pencil-design`：依赖外部工具或服务，建议确认可用性后再决定。
- `bootcamp-guide`、`guide-authoring`、`guide-interaction`：偏教学/文档型，适合降级为手动触发。

### 应保留但要修触发

- 工程闭环链：`feat-lifecycle`、`writing-plans`、`worktree`、`tdd`、`quality-gate`、`request-review`、`receive-review`、`merge-gate`。
- 运行诊断链：`clowder-agent-runtime-doctor`、`debugging`、`incident-response`。
- 协作链：`cross-cat-handoff`、`cross-thread-sync`、`subagent-dispatch`。

这些 skill 是 Clowder 协作质量的底座。零调用更像是“触发/观测没打通”，不是“应该删”。

## 大文档注入检查

超过 200 行的 refs：

| 文件 | 行数 | 处理建议 |
| --- | ---: | --- |
| `cat-cafe-skills/refs/creator-context.md` | 396 | 禁止 always-on，只能按需读取 |
| `cat-cafe-skills/refs/chatgpt-browser-automation.md` | 321 | 禁止 always-on，只能按需读取 |
| `cat-cafe-skills/refs/ppt-density-playbook.md` | 251 | 仅 `ppt-forge` 命中时读取 |
| `cat-cafe-skills/refs/ppt-slide-authoring.md` | 221 | 仅 PPT 生成/排版任务读取 |
| `cat-cafe-skills/refs/ppt-visual-review.md` | 216 | 仅 PPT 视觉验收任务读取 |

当前代码侧未发现这些大文档被全量 always-on 注入。`shared-rules.md` 仍有摘要级 always-on digest，这是治理底线，不是全文注入。

## 后续改进

1. 给 `SkillRouter` 增加命中 telemetry：记录 `skillRouterMatchedSkills` 到轻量日志。
2. 用“命中次数 + 人工确认价值”决定归档，不只看工具调用日志。
3. 如果要物理归档，先让用户确认候选清单，再移动到 `cat-cafe-skills/_archived/`。
4. 复查 `MAX_MENU_SKILLS=35`：当前 manifest 可用 41 个，菜单上限会隐藏 6 个 skill。
