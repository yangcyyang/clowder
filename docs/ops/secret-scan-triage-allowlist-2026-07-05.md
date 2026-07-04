---
title: Secret scan triage allowlist
created: 2026-07-05
doc_kind: ops-evidence
topics: [clowder, github-backup, secret-scan, n7]
---

# Secret scan triage allowlist

## Context

Input report:

- Markdown: `docs/ops/secret-scan-full-history-2026-07-04.md`
- JSON: `docs/ops/secret-scan-full-history-2026-07-04.json`
- Findings: 266 masked findings across 21 files

The user confirmed on 2026-07-05 that the target repository is private and
asked to process the scan findings before pushing.

## Method

The triage read the original git blobs referenced by each finding and
classified each line without printing raw secret-like values.

Classification criteria:

- Explicit token patterns inside scanner/security tests are test fixtures.
- `process.env` / `envKey` lines are environment variable references.
- Redis/local-storage/debug key constants are application storage key names.
- Routing threshold hits are variable names containing `token`.
- API key / token lines that reference variables or account config are not
  hard-coded values.

## Result

No finding remained in manual-review state.

| Classification | Count |
| --- | ---: |
| `allowlist:env-var-reference` | 60 |
| `allowlist:routing-threshold-variable` | 30 |
| `allowlist:storage-or-redis-key-name` | 59 |
| `allowlist:test-high-entropy-fixture` | 41 |
| `allowlist:test-placeholder-or-var` | 4 |
| `allowlist:test-secret-scanner-fixture` | 28 |
| `allowlist:variable-or-config-reference` | 44 |
| `review:*` | 0 |

## Decision

The 266 findings are allowlisted as false positives or intentional test
fixtures. No real hard-coded secret was identified during this triage.

No history rewrite, secret rotation, or fixture removal is required before the
first private GitHub push.

## Residual Risk

This is a best-effort local triage using the project's SecretScanner patterns.
The target GitHub repository is private. Future automated scans may still report
the same fixtures unless they consume this allowlist decision.
