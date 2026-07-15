---
feature_ids: [ci-test-lanes]
topics: [testing, ci, web, quarantine]
doc_kind: guide
created: 2026-07-15
owner: "@yangcyyang"
expiry: 2026-07-29
---
# Web product-contract quarantine

The Web quarantine is a temporary, required ratchet for known product-contract debt. It is not a skip list. The
manifest contains exact test paths and exact `{ relativeFile, fullName, failureKind }` signatures; glob patterns and
full error text are forbidden.

Current accountability is owned by `@yangcyyang`, and every entry expires on `2026-07-29`. An expired entry fails
validation and must not be extended without an explicit owner decision.

## Required commands

Run these from `packages/web`:

```bash
# Schema, ownership, expiry, duplicates, exact paths, and aggregate counts.
node scripts/run-test-quarantine.mjs validate

# Required blocking lane: discovers Vitest files, then excludes only the 15 exact manifest paths.
node scripts/run-test-quarantine.mjs blocking

# Debt lane: accepts Vitest exit 1 only when all failure signatures match exactly.
node scripts/run-test-quarantine.mjs quarantine

# Runner and comparison self-tests.
node --test test/test-quarantine.test.mjs
```

The quarantine lane fails when a failure is added, disappears, changes kind, duplicates another identity, or when
Vitest has an infrastructure failure. It does not use `continue-on-error` or `passWithNoTests`.

## Paying down debt

1. Fix the product contract or its test on a focused branch.
2. Run the affected test file directly and confirm the intended behavior.
3. Run the quarantine lane. A fixed test deliberately reports as `Resolved failures still present in manifest`.
4. Remove that exact failure from `test/quarantine-manifest.json`. Remove the whole file entry only after all of its
   failures are fixed; keep `testCount` as the file's baseline test count while the entry exists.
5. Update `expectedTotals`, run validator, blocking lane, quarantine lane, and runner self-tests.
6. Ask the named owner to review the debt reduction. Never replace a resolved signature with newer error text.
