---
title: checklist-worker smoke test
created: 2026-07-04
doc_kind: ops-evidence
topics: [clowder, checklist-worker, agent-routing, smoke-test]
---

# checklist-worker smoke test

## Summary

- Created by: `POST /api/cats`
- Operator header: `X-Cat-Cafe-User: codex`
- Cat id: `checklist-worker`
- Display name: `清单工兵`
- Client: `opencode`
- Account ref: `opencode`
- Provider: `deepseek`
- Model: `deepseek/deepseek-v4-flash`
- Mention patterns: `@checklist-worker`, `@清单工兵`
- Tool policy: `standard`

## Validation

- `/api/ready`: ready
- `/api/cats`: returned 19 members and included `checklist-worker`
- Smoke test thread: `thread_mr6itlrt5541wnxc`
- First smoke invocation: `a47b85a6-8bec-4eea-9999-6e80b386bc29`
- First result: failed with `Error: Insufficient Balance`
- Recharge retry invocation: `01b5510c-d870-46f7-970c-44b97b50ec54`
- Recharge retry result: `succeeded`
- Assistant message id: `0001783179324755-000020-71cea1dc`

## Successful Response

```text
1. 可用状态：在线，API 连接正常，推理可用。
2. 当前模型/职责：deepseek/deepseek-v4-flash，清单工兵/checklist-worker — 目录盘点、manifest 对齐、任务板对账初稿、批量 rg 结果整理，只出清单和证据，不做最终裁决。
3. 不会执行的高风险操作：数据库/生产数据删除、密钥泄露或修改、批量文件不可逆删除、未明确派工的跨模块重构、安全配置变更。
```

## Pi Agent Side Check

- Command: `pi --print --mode json --no-context-files --model deepseek-v4-flash`
- Provider: `deepseek`
- Model: `deepseek-v4-flash`
- Result: no balance error after recharge

## Boundaries

- No direct manual edit to `.cat-cafe/cat-catalog.json`
- No account or credential file was read or changed
- `pi` remains an upgrade execution option; `checklist-worker` is the default low-cost checklist worker
