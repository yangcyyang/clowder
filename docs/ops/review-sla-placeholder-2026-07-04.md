---
title: Review SLA placeholder evidence
created: 2026-07-04
doc_kind: ops-evidence
topics: [clowder, review-sla, board-reconciliation]
---

# Review SLA placeholder evidence

## Scope

N3 is a placeholder ticket that depends on D6 for precise day-level reminders.
The only executable half-step now is to ensure the weekly board reconciliation report includes a fixed `in_review > 48h` section.

## Evidence

- Source report: `docs/ops/board-reconciliation-2026-07-04.md`
- Summary count: `in_review 超 48h：205`
- Fixed rule: `in_review > 48h` items require a reviewer decision within 24h
- Report section: `## in_review 超 48h（205）`
- One-click action: `收口 review`

## Current State

- Weekly coarse SLA is active through scheduled task `dyn-1783177855467-5jpo67`
- Daily precise review reminder remains deferred until D6 lands
- No platform/API code was changed for N3

## Future Activation

When D6 is available, request-review flow should set a 24h reminder for the requesting reviewer or owner.
The skill/rule update should point back to this evidence and the weekly report format.
