---
title: GitHub repository private visibility gate
created: 2026-07-05
doc_kind: ops-evidence
topics: [clowder, github-backup, private-repo, n7]
---

# GitHub repository private visibility gate

## Context

- N7 target repository: `yangcyyang/clowder-ai-cy`
- Previous read-only check: `visibility=PUBLIC`, `isPrivate=false`
- User confirmation: on 2026-07-05, the user explicitly confirmed changing the repository to private.

## Action

Command executed:

```bash
gh repo edit yangcyyang/clowder-ai-cy --visibility private --accept-visibility-change-consequences
```

The command returned successfully.

## Verification

Verification command:

```bash
gh repo view yangcyyang/clowder-ai-cy --json nameWithOwner,visibility,isPrivate,url,defaultBranchRef,pushedAt
```

Verified result:

```json
{
  "defaultBranchRef": {
    "name": "feature/slock-like-webui"
  },
  "isPrivate": true,
  "nameWithOwner": "yangcyyang/clowder-ai-cy",
  "pushedAt": "2026-06-16T03:28:18Z",
  "url": "https://github.com/yangcyyang/clowder-ai-cy",
  "visibility": "PRIVATE"
}
```

## Gate Status

- Private repository requirement: satisfied.
- Secret scan gate: not satisfied yet.
- Push status: no push was performed.

N7 remains frozen until the full-history scan findings in
`docs/ops/secret-scan-full-history-2026-07-04.md` are triaged and either
allowlisted as false positives or remediated.
