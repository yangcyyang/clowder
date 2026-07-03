---
doc_kind: checklist
topics: [project-workflow, review, quality-gate]
created: "2026-07-03"
---

# Review Checklist

## 起点

```bash
git status --short
git diff HEAD
```

## Findings First

```markdown
## Findings

### [P0] <title>
- File: <file>:<line>
- Problem:
- Suggestion:

## Risk Score
- Total: x/10
- Reason:

## Verification
- Passed:
- Not verified:
```

## 严重级别

- P0：阻塞合并或交付，必须先修。
- P1：严重风险，应在本轮修。
- P2：改进建议，可排期。

## 必查项

- 任务验收标准是否真实满足。
- 事实源是否按需更新，且没有把流水账写进 `progress.md`。
- 高风险操作是否有确认记录。
- 测试、构建、lint 或人工证据是否覆盖改动面。
- 是否存在同一人自审问题；需要时走 `request-review` / `receive-review`。
