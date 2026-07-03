---
doc_kind: reference
topics: [project-workflow, project-context, takeover]
created: "2026-07-03"
---

# Project Context Contract Quick Ref

## 接手读取顺序

```text
1. .cat-cafe/projects/<projectId>/brief.md
2. .cat-cafe/projects/<projectId>/progress.md
3. .cat-cafe/projects/<projectId>/decisions.md
4. .cat-cafe/projects/<projectId>/handoff-index.md
5. only if relevant: concrete handoff / task thread / evidence
```

## 接手摘要

```markdown
我接手到的项目状态：
- 当前目标：
- 最近完成：
- 当前阻塞：
- 下一步建议：
- 需要先确认：
```

## 写入边界

- `progress.md`：阶段、完成项、进行中、待办、验收状态变化。
- `decisions.md`：用户或 reviewer 已拍板、会影响后续工作的长期决策。
- `handoff-index.md`：新增 durable handoff，或当前接手入口发生变化。
- `handoff-log.md`：自动追加交接流水，不作为默认接手入口。

## Prompt Budget

默认注入只允许四件套。不要默认注入全部 handoff、完整 task history 或完整聊天历史。
