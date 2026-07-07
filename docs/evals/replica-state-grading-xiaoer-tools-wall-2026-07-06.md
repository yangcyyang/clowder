---
feature_ids:
  - replica-state-grading
topics:
  - eval
  - quality-gate
  - website-clone
doc_kind: report
created: 2026-07-06
---

# Replica State Grading: xiaoer-tools-wall

## Scope

This is the first narrow B2/B4 eval slice: **website clone + outcome/state grading** only.
It does not cover generic coding assertions or review-style LLM judging.

Target case:
- Clone repo: `/Users/cy/Projects/website-clones/xiaoer-tools-wall-clone/app`
- Live page: `http://localhost:4173/`
- Reference HTML: `/Users/cy/Documents/03 life/AI design/产品项目/clowder/tmp/xiaoer-tools-wall-data/index.html`

## Grader

Script:

```text
scripts/evals/replica-state-grade.mjs
```

Pass/fail checks:
- target page or file can be read
- target is bound to the supplied clean git commit:
  - local URL: listening process cwd must be inside `--repo`
  - file target: file path must be inside `--repo`
- target contains at least 80% of reference tool names
- target contains expected total `505`
- target contains required smoke signals: `GitButler`, `Bruno`, `design-dna`, `Slideland`

Guardrail:
- if the reference parses zero tool names, the script exits with an input error instead of silently returning a clone-quality FAIL.

## Current Clone Result

Verdict: **PASS**

Evidence:
- page reachable: `status=200`, `bytes=251179`
- target bound to commit: `localhost:4173 listener cwd=/Users/cy/Projects/website-clones/xiaoer-tools-wall-clone/app; commit=b190adf`
- reference name coverage: `496/496 = 100.0%`
- required signals: all hit

Interpretation:
The current clone passes the first state-grading bar: it is running from the supplied repo, the repo is clean at the checked commit, and its content state matches the reference tool catalog strongly enough to accept this eval slice.

## Scaffold Replay Result

Verdict: **FAIL**

Replay source:
- detached worktree at initial scaffold commit `28eaeec Initial commit from Create Next App`
- target file: `app/page.tsx`

Evidence:
- page/file readable: `bytes=2882`
- target bound to commit: file target is inside the detached repo at `28eaeec`
- reference name coverage: `0/496 = 0.0%`
- expected total: missing `505`
- required signals: all missing

Interpretation:
The grader catches the failure mode this B2 slice is meant to prevent: a repo can have a scaffold commit and still fail the clone outcome check because the actual page state does not contain the reference content.

## Reviewer Hardening Recheck

Two issues found during expert review are now covered:

1. Empty reference:
   - wrong reference example: app `README.md`
   - result: input error, exit `2`
   - message: `Reference parsed zero tool names; check --reference input before grading clone quality.`

2. Fake target with real repo:
   - target: original HTML file outside the clone repo
   - repo: `/Users/cy/Projects/website-clones/xiaoer-tools-wall-clone/app`
   - result: **FAIL**
   - blocking check: `target_bound_to_commit`
   - reason: `target file is outside repo`

## Decision

The first B2 scoring card is valid enough to use as a quality-gate building block for website clone tasks:

```text
website clone done = page runs from the supplied clean repo commit + DOM/HTML state matches reference signals
```

Next expansion should wait until this script is wired into the appropriate quality-gate path. Do not add coding/review scoring dimensions before that integration is reviewed.
