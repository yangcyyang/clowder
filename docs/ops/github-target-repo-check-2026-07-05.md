---
title: GitHub target repository check
created: 2026-07-05
doc_kind: ops-evidence
topics: [clowder, github-backup, target-repo]
---

# GitHub target repository check

## User Decision

User selected:

- Repository: `yangcyyang/clowder-ai-cy`
- URL: `https://github.com/yangcyyang/clowder-ai-cy`

## Read-only Checks

- `gh repo view yangcyyang/clowder-ai-cy --json nameWithOwner,visibility,isPrivate,url,defaultBranchRef,pushedAt`
- `git remote -v`
- `git status --short --branch`

## Result

- GitHub owner/repo: `yangcyyang/clowder-ai-cy`
- URL: `https://github.com/yangcyyang/clowder-ai-cy`
- Visibility: `PUBLIC`
- `isPrivate`: `false`
- Default branch: `feature/slock-like-webui`
- Last pushed at: `2026-06-16T03:28:18Z`
- Local `origin`: `https://github.com/yangcyyang/clowder-ai-cy.git`
- Local branch: `feature/slock-like-webui`
- Local status: ahead of `origin/feature/slock-like-webui` by 117 commits at check time

## Gate Status

N7 remains frozen.

Reasons:

- The selected repository is currently public, while N7 requires a private GitHub repository.
- The full-history secret scan is not clean: `docs/ops/secret-scan-full-history-2026-07-04.md` reported 266 masked findings.

No repository visibility changes, remote changes, or pushes were performed.
