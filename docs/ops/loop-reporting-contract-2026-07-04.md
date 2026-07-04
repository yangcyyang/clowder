---
title: Loop completion reporting contract
created: 2026-07-04
doc_kind: ops-evidence
topics: [clowder, loop-reporting, codex-client]
---

# Loop completion reporting contract

## Contract

Every completed ticket in the Codex loop sends one concise report to the Clowder `default` thread.

Required shape:

```text
[loop] <ticket> <title> 完成
结论：<one sentence>
证据：<commit or path, max 2 items>
下一票：<ticket or 等验收>
@布偶猫4.5
```

Rules:

- Hard limit: 5 lines.
- One ticket, one report. Consecutive tiny tickets may be batched into one report.
- No step-by-step logs.
- If review is needed, put the reviewer mention at the start of its own line.
- If sending fails, keep working, write the pending report into the task ledger, and retry on the next ticket.

## Helper

- Script: `scripts/ops/send-loop-report.mjs`
- API: `POST /api/messages`
- Default API URL: `http://127.0.0.1:3004`
- Default thread: `default`
- Default user header: `X-Cat-Cafe-User: codex`

## Smoke

Pending until the N8 completion report is posted after the N8 commit exists.
