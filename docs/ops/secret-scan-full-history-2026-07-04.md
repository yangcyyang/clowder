---
title: Full-history secret scan
created: 2026-07-04
doc_kind: ops-evidence
topics: [clowder, github-backup, secret-scan]
---

# Full-history secret scan

## Summary

- Commits scanned: 567
- Tree entries visited: 1587963
- Unique blobs observed: 12150
- Text blobs scanned: 12061
- Skipped paths: 0
- Skipped binary blobs: 88
- Skipped large blobs over 1 MiB: 1
- Findings: 266

## Finding Counts

- `high-entropy-secret`: 238
- `github-token`: 12
- `aws-access-key`: 10
- `openai-key`: 5
- `private-key`: 1

## Initial Triage

Most visible samples are test fixtures, placeholder-like examples, environment variable names, or code variables that contain words such as `token`, `secret`, or `key`.
However, this is still a non-clean scan report. Per N7, the first GitHub push remains frozen until the owner/reviewer explicitly decides whether to allowlist false positives, remove fixtures, or rewrite history.

## Result

Findings were detected. Do not push history until owner/reviewer decides remediation. Snippets below are masked.

| Type | Commit | File | Line | Snippet |
|------|--------|------|------|---------|
| high-entropy-secret | 28b10d266431 | `bin/clowder` | 210 | `const agen******cret = proc****************CRET;` |
| high-entropy-secret | 28b10d266431 | `bin/clowder` | 220 | `const call*****oken = proc****************OKEN;` |
| high-entropy-secret | 28b10d266431 | `packages/api/src/domains/cats/services/agents/providers/ClaudeAgentService.ts` | 47 | `const ANTH****************_KEY = 'CAT_****************RIDE';` |
| high-entropy-secret | 28b10d266431 | `packages/api/src/domains/cats/services/agents/routing/route-helpers.ts` | 1245 | `thresholds: { count: hcCo****************hold, token: hcCo****************hold },` |
| high-entropy-secret | 28b10d266431 | `packages/api/src/domains/cats/services/game/LlmAIProvider.ts` | 146 | `https://ge****************els/${this.model}:gene*******tent?key=${apiKey},` |
| high-entropy-secret | 28b10d266431 | `packages/api/src/domains/cats/services/stores/redis/RedisThreadStore.ts` | 424 | `const feedbackKey = Thre****************back(threadId);` |
| high-entropy-secret | 28b10d266431 | `packages/api/src/domains/cats/services/stores/redis/RedisThreadStore.ts` | 432 | `const feedbackKey = Thre****************back(threadId);` |
| high-entropy-secret | 28b10d266431 | `packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts` | 205 | `feis***************oken: proc****************OKEN ?? pers****************OKEN,` |
| high-entropy-secret | 28b10d266431 | `packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts` | 218 | `weco***********sKey: proc****************_KEY ?? pers****************_KEY,` |
| high-entropy-secret | 28b10d266431 | `packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts` | 597 | `const ghWe*******cret = proc****************CRET;` |
| high-entropy-secret | 28b10d266431 | `packages/api/src/routes/connector-hub.ts` | 437 | `const veri*********oken = proc****************OKEN;` |
| high-entropy-secret | 28b10d266431 | `packages/api/src/routes/quota.ts` | 997 | `accessToken: pars****************oken,` |
| high-entropy-secret | 28b10d266431 | `packages/api/src/routes/quota.ts` | 998 | `refr****oken: pars****************oken,` |
| high-entropy-secret | 28b10d266431 | `packages/api/test/capability-orchestrator.test.js` | 1576 | `const orig**************cret = proc****************CRET;` |
| high-entropy-secret | 28b10d266431 | `packages/api/test/mcp-config-adapters.test.js` | 581 | `orig**************cret = proc****************CRET;` |
| github-token | 28b10d266431 | `packages/api/test/memory/binding-dry-run.test.js` | 31 | `writ*****Sync(join(dir, 'danger.md'), '# Danger\n\ntoken: ghp_****************ghij\n');` |
| aws-access-key | 28b10d266431 | `packages/api/test/memory/binding-dry-run.test.js` | 51 | `writ*****Sync(join(dir, 'private', 'secret.md'), '# Secret\n\nkey: AKIA************MPLE');` |
| openai-key | 28b10d266431 | `packages/api/test/memory/binding-dry-run.test.js` | 64 | `'# Config\n\ntoken: sk-p****************90ab',` |
| aws-access-key | 28b10d266431 | `packages/api/test/memory/collection-index-builder-security.test.js` | 51 | `writ*****Sync(join(dir, 'dang****s.md'), '# Config\n\naws_key: AKIA************MPLE\n');` |
| github-token | 28b10d266431 | `packages/api/test/memory/collection-index-builder-security.test.js` | 79 | `writ*****Sync(join(dir, 'a.md'), '# A\n\ntoken = ghp_****************ghij\n');` |
| aws-access-key | 28b10d266431 | `packages/api/test/memory/collection-index-builder-security.test.js` | 80 | `writ*****Sync(join(dir, 'b.md'), '# B\n\naws: AKIA************MPLE\n');` |
| openai-key | 28b10d266431 | `packages/api/test/memory/collection-index-builder-security.test.js` | 94 | `writ*****Sync(join(dir, 'dirty.md'), '# Dirty\n\nsk-****************90ab\n');` |
| github-token | 28b10d266431 | `packages/api/test/memory/collection-index-builder-security.test.js` | 140 | `writ*****Sync(join(dir, 'leaked.md'), '# Leaked\n\ntoken: ghp_****************ghij\n');` |
| aws-access-key | 28b10d266431 | `packages/api/test/memory/collection-index-builder-security.test.js` | 151 | `writ*****Sync(join(dir, 'dirty.md'), '# Dirty\n\naws_key: AKIA************MPLE\n');` |
| github-token | 28b10d266431 | `packages/api/test/memory/collection-index-builder-security.test.js` | 182 | `writ*****Sync(join(dir, 'late******y.md'), '# Dirty\n\ntoken: ghp_****************ghij\n');` |
| aws-access-key | 28b10d266431 | `packages/api/test/memory/secret-scanner.test.js` | 12 | `const content = 'config:\n  aws_key: AKIA************MPLE\n';` |
| github-token | 28b10d266431 | `packages/api/test/memory/secret-scanner.test.js` | 19 | `const content = 'token = ghp_****************ghij\n';` |
| github-token | 28b10d266431 | `packages/api/test/memory/secret-scanner.test.js` | 26 | `const ghs = 'GITH****************ghij\n';` |
| github-token | 28b10d266431 | `packages/api/test/memory/secret-scanner.test.js` | 27 | `const ghu = 'token: ghu_****************ghij\n';` |
| github-token | 28b10d266431 | `packages/api/test/memory/secret-scanner.test.js` | 28 | `const ghr = 'refresh = ghr_****************ghij\n';` |
| high-entropy-secret | 28b10d266431 | `packages/api/test/memory/secret-scanner.test.js` | 35 | `const content = 'api_key = "a8f3****************f8a9"\n';` |
| aws-access-key | 28b10d266431 | `packages/api/test/memory/secret-scanner.test.js` | 48 | `const content = '# Tutorial\n\n\nAKI*************MPLE\n\n';` |
| aws-access-key | 28b10d266431 | `packages/api/test/memory/secret-scanner.test.js` | 54 | `const content = 'line1\nline2\naws_key: AKIA************MPLE\n';` |
| openai-key | 28b10d266431 | `packages/api/test/memory/secret-scanner.test.js` | 61 | `const content = 'openai_key: sk-p****************3456\n';` |
| private-key | 28b10d266431 | `packages/api/test/memory/secret-scanner.test.js` | 68 | `const content = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpA...\n';` |
| github-token | 28b10d266431 | `packages/api/test/memory/secret-scanner.test.js` | 77 | `{ path: 'dirty.md', content: '# Dirty\n\ntoken: ghp_****************ghij\n' },` |
| aws-access-key | 28b10d266431 | `packages/api/test/memory/secret-scanner.test.js` | 78 | `{ path: 'also*****y.md', content: '# Also\n\nkey: AKIA************MPLE\n' },` |
| github-token | 28b10d266431 | `packages/api/test/memory/secret-scanner.test.js` | 86 | `const content = 'token: ghp_****************ghij # TODO rotate this\n';` |
| high-entropy-secret | 28b10d266431 | `packages/web/src/debug/__tests__/invocationEventDebug.test.ts` | 254 | `const sess******Item = vi.fn((key: string) => (key === invo****************_KEY ? '1' : null));` |
| high-entropy-secret | 28b10d266431 | `packages/web/src/debug/__tests__/invocationEventDebug.test.ts` | 282 | `const sess******Item = vi.fn((key: string) => (key === invo****************_KEY ? '1' : null));` |
| high-entropy-secret | 28b10d266431 | `packages/web/src/debug/__tests__/invocationEventDebug.test.ts` | 307 | `const sess******Item = vi.fn((key: string) => (key === invo****************_KEY ? '1' : null));` |
| high-entropy-secret | 28b10d266431 | `packages/web/src/debug/__tests__/invocationEventDebug.test.ts` | 374 | `getItem: (key: string) => (key === invo****************_KEY ? sess****alue : null),` |
| high-entropy-secret | 28b10d266431 | `packages/web/src/debug/__tests__/invocationEventDebug.test.ts` | 414 | `getItem: (key: string) => (key === invo****************_KEY ? localValue : null),` |
| high-entropy-secret | 28b10d266431 | `packages/web/src/debug/__tests__/invocationEventDebug.test.ts` | 453 | `getItem: (key: string) => (key === invo****************_KEY ? '1' : null),` |
| high-entropy-secret | 28b10d266431 | `packages/web/src/debug/__tests__/invocationEventDebug.test.ts` | 476 | `getItem: (key: string) => (key === invo****************_KEY ? '{bad-json' : null),` |
| high-entropy-secret | 28b10d266431 | `packages/web/src/debug/__tests__/invocationEventDebug.test.ts` | 482 | `getItem: (key: string) => (key === invo****************_KEY ? '1' : null),` |
| high-entropy-secret | 28b10d266431 | `packages/web/src/stores/chatStore.ts` | 247 | `const UI_T****************_KEY = 'catc****************ault';` |
| high-entropy-secret | 9f516874c4ed | `packages/api/src/domains/cats/services/agents/routing/route-helpers.ts` | 1294 | `thresholds: { count: hcCo****************hold, token: hcCo****************hold },` |
| high-entropy-secret | 29a565b97b97 | `packages/api/src/domains/cats/services/agents/routing/route-helpers.ts` | 1843 | `thresholds: { count: hcCo****************hold, token: hcCo****************hold },` |
| high-entropy-secret | 29a565b97b97 | `packages/api/src/infrastructure/image/OpenAIImageGenerationService.ts` | 268 | `const apiKey = this****************_KEY?.trim() || account?.apiKey || this***************_KEY?.trim();` |
| high-entropy-secret | 29a565b97b97 | `packages/api/test/callback-routes.test.js` | 1813 | `const previousKey = proc****************_KEY;` |
| high-entropy-secret | 29a565b97b97 | `packages/api/test/callback-routes.test.js` | 1869 | `const previousKey = proc****************_KEY;` |
| high-entropy-secret | 29a565b97b97 | `packages/api/test/capability-orchestrator.test.js` | 1598 | `const orig**************cret = proc****************CRET;` |
| openai-key | 29a565b97b97 | `packages/api/test/memory/library-rebuild-route-no-sqlite.test.js` | 21 | `writ*****Sync(join(root, 'secret.md'), '# Secret\n\napi_key = sk-a****************3456');` |
| high-entropy-secret | 29a565b97b97 | `packages/api/test/run-ledger-route.test.js` | 62 | `content: 'Done. Secret should not echo: ANTH****************alue',` |
| high-entropy-secret | 29a565b97b97 | `packages/api/test/run-ledger-route.test.js` | 247 | `sessionId: 'sess****************alue',` |
| high-entropy-secret | 29a565b97b97 | `packages/web/src/stores/chatStore.ts` | 248 | `const UI_T****************_KEY = 'catc****************ault';` |
| high-entropy-secret | 928884cb3f20 | `packages/api/src/domains/cats/services/agents/routing/route-helpers.ts` | 1761 | `thresholds: { count: hcCo****************hold, token: hcCo****************hold },` |
| high-entropy-secret | 928884cb3f20 | `packages/api/test/run-ledger-route.test.js` | 62 | `content: 'Done. Secret should not echo: ANTH****************alue',` |
| high-entropy-secret | 90eebb6b4a46 | `packages/api/src/domains/cats/services/agents/routing/route-helpers.ts` | 1602 | `thresholds: { count: hcCo****************hold, token: hcCo****************hold },` |
| high-entropy-secret | a0010f8efd62 | `packages/api/src/domains/cats/services/agents/routing/route-helpers.ts` | 1341 | `thresholds: { count: hcCo****************hold, token: hcCo****************hold },` |
| high-entropy-secret | 97c40c1f9671 | `packages/api/src/domains/cats/services/agents/routing/route-helpers.ts` | 1246 | `thresholds: { count: hcCo****************hold, token: hcCo****************hold },` |
| high-entropy-secret | 2859c6631346 | `packages/api/test/run-ledger-route.test.js` | 62 | `content: 'Done. Secret should not echo: ANTH****************alue',` |
| high-entropy-secret | 1a6916d25779 | `packages/api/src/domains/cats/services/agents/routing/route-helpers.ts` | 1177 | `thresholds: { count: hcCo****************hold, token: hcCo****************hold },` |
| aws-access-key | b57cd49b6156 | `packages/api/test/memory/collection-index-builder-security.test.js` | 43 | `writ*****Sync(join(dir, 'dang****s.md'), '# Config\n\naws_key: AKIA************MPLE\n');` |
| github-token | b57cd49b6156 | `packages/api/test/memory/collection-index-builder-security.test.js` | 71 | `writ*****Sync(join(dir, 'a.md'), '# A\n\ntoken = ghp_****************ghij\n');` |
| aws-access-key | b57cd49b6156 | `packages/api/test/memory/collection-index-builder-security.test.js` | 72 | `writ*****Sync(join(dir, 'b.md'), '# B\n\naws: AKIA************MPLE\n');` |
| openai-key | b57cd49b6156 | `packages/api/test/memory/collection-index-builder-security.test.js` | 86 | `writ*****Sync(join(dir, 'dirty.md'), '# Dirty\n\nsk-****************90ab\n');` |
| github-token | b57cd49b6156 | `packages/api/test/memory/collection-index-builder-security.test.js` | 132 | `writ*****Sync(join(dir, 'leaked.md'), '# Leaked\n\ntoken: ghp_****************ghij\n');` |
| high-entropy-secret | 34c9e1569c5a | `packages/api/src/domains/cats/services/agents/providers/ClaudeAgentService.ts` | 47 | `const ANTH****************_KEY = 'CAT_****************RIDE';` |
| high-entropy-secret | 30689a855fbf | `packages/web/src/stores/chatStore.ts` | 247 | `const UI_T****************_KEY = 'catc****************ault';` |
| high-entropy-secret | 65ad47fcfe6a | `packages/api/src/domains/cats/services/agents/providers/ClaudeAgentService.ts` | 47 | `const ANTH****************_KEY = 'CAT_****************RIDE';` |
| high-entropy-secret | 0c5a0c2d4cfe | `packages/api/src/domains/cats/services/agents/providers/ClaudeAgentService.ts` | 42 | `const ANTH****************_KEY = 'CAT_****************RIDE';` |
| high-entropy-secret | 3c072565fb59 | `packages/api/src/domains/cats/services/agents/routing/route-helpers.ts` | 1172 | `thresholds: { count: hcCo****************hold, token: hcCo****************hold },` |
| high-entropy-secret | 78e1f3fe8fff | `packages/api/src/domains/cats/services/agents/routing/route-helpers.ts` | 1172 | `thresholds: { count: hcCo****************hold, token: hcCo****************hold },` |
| high-entropy-secret | 723f4c9f7a34 | `packages/api/src/domains/cats/services/agents/routing/route-helpers.ts` | 1157 | `thresholds: { count: hcCo****************hold, token: hcCo****************hold },` |
| high-entropy-secret | a3743ca4a545 | `packages/api/src/domains/cats/services/stores/redis/RedisThreadStore.ts` | 423 | `const feedbackKey = Thre****************back(threadId);` |
| high-entropy-secret | a3743ca4a545 | `packages/api/src/domains/cats/services/stores/redis/RedisThreadStore.ts` | 431 | `const feedbackKey = Thre****************back(threadId);` |
| high-entropy-secret | fec07f9cacd4 | `packages/api/src/domains/cats/services/agents/providers/ClaudeAgentService.ts` | 45 | `const ANTH****************_KEY = 'CAT_****************RIDE';` |
| high-entropy-secret | 55c310c5e08f | `packages/api/src/domains/cats/services/agents/routing/route-helpers.ts` | 1112 | `thresholds: { count: hcCo****************hold, token: hcCo****************hold },` |
| high-entropy-secret | c77b15e8568c | `packages/api/src/domains/cats/services/agents/routing/route-helpers.ts` | 1112 | `thresholds: { count: hcCo****************hold, token: hcCo****************hold },` |
| high-entropy-secret | cb4a7785d06b | `packages/api/src/domains/cats/services/agents/routing/route-helpers.ts` | 1105 | `thresholds: { count: hcCo****************hold, token: hcCo****************hold },` |
| high-entropy-secret | be9b80782c3d | `bin/clowder` | 210 | `const agen******cret = proc****************CRET;` |
| high-entropy-secret | be9b80782c3d | `bin/clowder` | 220 | `const call*****oken = proc****************OKEN;` |
| high-entropy-secret | 3b3f020c8213 | `packages/api/src/domains/cats/services/agents/routing/route-helpers.ts` | 1062 | `thresholds: { count: hcCo****************hold, token: hcCo****************hold },` |
| high-entropy-secret | 85b189a95bbf | `packages/api/src/domains/cats/services/agents/routing/route-helpers.ts` | 937 | `thresholds: { count: hcCo****************hold, token: hcCo****************hold },` |
| high-entropy-secret | 003c80adfeff | `bin/clowder` | 188 | `const agen******cret = proc****************CRET;` |
| high-entropy-secret | 003c80adfeff | `bin/clowder` | 198 | `const call*****oken = proc****************OKEN;` |
| high-entropy-secret | 003c80adfeff | `packages/api/src/domains/cats/services/agents/routing/route-helpers.ts` | 933 | `thresholds: { count: hcCo****************hold, token: hcCo****************hold },` |
| high-entropy-secret | 35c6ac5c943e | `bin/clowder` | 181 | `const agen******cret = proc****************CRET;` |
| high-entropy-secret | 35c6ac5c943e | `bin/clowder` | 191 | `const call*****oken = proc****************OKEN;` |
| high-entropy-secret | bd2229677c05 | `packages/web/src/stores/chatStore.ts` | 247 | `const UI_T****************_KEY = 'catc****************ault';` |
| high-entropy-secret | bed53819d8f3 | `packages/api/src/domains/cats/services/agents/routing/route-helpers.ts` | 922 | `thresholds: { count: hcCo****************hold, token: hcCo****************hold },` |
| high-entropy-secret | 7df47fbf87da | `packages/api/src/domains/cats/services/agents/routing/route-helpers.ts` | 855 | `thresholds: { count: hcCo****************hold, token: hcCo****************hold },` |
| high-entropy-secret | 745172edb77f | `packages/api/src/domains/cats/services/agents/routing/route-helpers.ts` | 783 | `thresholds: { count: hcCo****************hold, token: hcCo****************hold },` |
| high-entropy-secret | 745172edb77f | `packages/web/src/stores/chatStore.ts` | 247 | `const UI_T****************_KEY = 'catc****************ault';` |
| high-entropy-secret | 282970243ff6 | `packages/web/src/stores/chatStore.ts` | 247 | `const UI_T****************_KEY = 'catc****************ault';` |
| high-entropy-secret | 61c6c28373b0 | `packages/api/src/domains/cats/services/agents/routing/route-helpers.ts` | 782 | `thresholds: { count: hcCo****************hold, token: hcCo****************hold },` |
| high-entropy-secret | a45d3bbe15bd | `packages/web/src/stores/chatStore.ts` | 247 | `const UI_T****************_KEY = 'catc****************ault';` |
| high-entropy-secret | 2738997ab935 | `packages/api/src/domains/cats/services/agents/routing/route-helpers.ts` | 725 | `thresholds: { count: hcCo****************hold, token: hcCo****************hold },` |
| high-entropy-secret | a423a61a5f31 | `packages/web/src/stores/chatStore.ts` | 233 | `const UI_T****************_KEY = 'catc****************ault';` |
| high-entropy-secret | 4cb93b997a32 | `packages/api/src/domains/cats/services/agents/routing/route-helpers.ts` | 723 | `thresholds: { count: hcCo****************hold, token: hcCo****************hold },` |
| high-entropy-secret | 4cb93b997a32 | `packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts` | 203 | `feis***************oken: proc****************OKEN,` |
| high-entropy-secret | 4cb93b997a32 | `packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts` | 216 | `weco***********sKey: proc****************_KEY,` |
| high-entropy-secret | 4cb93b997a32 | `packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts` | 574 | `const ghWe*******cret = proc****************CRET;` |
| high-entropy-secret | 5f0f5b947b7b | `packages/api/src/domains/cats/services/agents/providers/ClaudeAgentService.ts` | 42 | `const ANTH****************_KEY = 'CAT_****************RIDE';` |
| high-entropy-secret | 5f0f5b947b7b | `packages/api/src/domains/cats/services/agents/routing/route-helpers.ts` | 719 | `thresholds: { count: hcCo****************hold, token: hcCo****************hold },` |
| high-entropy-secret | 5f0f5b947b7b | `packages/api/src/domains/cats/services/stores/redis/RedisThreadStore.ts` | 404 | `const feedbackKey = Thre****************back(threadId);` |
| high-entropy-secret | 5f0f5b947b7b | `packages/api/src/domains/cats/services/stores/redis/RedisThreadStore.ts` | 412 | `const feedbackKey = Thre****************back(threadId);` |
| high-entropy-secret | 5f0f5b947b7b | `packages/web/src/stores/chatStore.ts` | 232 | `const UI_T****************_KEY = 'catc****************ault';` |
| high-entropy-secret | 1d880bedfbe5 | `packages/web/src/stores/chatStore.ts` | 232 | `const UI_T****************_KEY = 'catc****************ault';` |
| high-entropy-secret | a64c16089277 | `packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts` | 202 | `feis***************oken: proc****************OKEN,` |
| high-entropy-secret | a64c16089277 | `packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts` | 215 | `weco***********sKey: proc****************_KEY,` |
| high-entropy-secret | a64c16089277 | `packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts` | 573 | `const ghWe*******cret = proc****************CRET;` |
| high-entropy-secret | a64c16089277 | `packages/api/src/routes/connector-hub.ts` | 355 | `const veri*********oken = proc****************OKEN;` |
| high-entropy-secret | a64c16089277 | `packages/web/src/stores/chatStore.ts` | 232 | `const UI_T****************_KEY = 'catc****************ault';` |
| high-entropy-secret | ebd0736ad1fa | `packages/api/src/domains/cats/services/agents/routing/route-helpers.ts` | 715 | `thresholds: { count: hcCo****************hold, token: hcCo****************hold },` |
| high-entropy-secret | ebd0736ad1fa | `packages/web/src/stores/chatStore.ts` | 230 | `const UI_T****************_KEY = 'catc****************ault';` |
| high-entropy-secret | 744c46ff0a75 | `packages/web/src/debug/__tests__/invocationEventDebug.test.ts` | 220 | `const sess******Item = vi.fn((key: string) => (key === invo****************_KEY ? '1' : null));` |
| high-entropy-secret | 744c46ff0a75 | `packages/web/src/debug/__tests__/invocationEventDebug.test.ts` | 248 | `const sess******Item = vi.fn((key: string) => (key === invo****************_KEY ? '1' : null));` |
| high-entropy-secret | 744c46ff0a75 | `packages/web/src/debug/__tests__/invocationEventDebug.test.ts` | 273 | `const sess******Item = vi.fn((key: string) => (key === invo****************_KEY ? '1' : null));` |
| high-entropy-secret | 744c46ff0a75 | `packages/web/src/debug/__tests__/invocationEventDebug.test.ts` | 340 | `getItem: (key: string) => (key === invo****************_KEY ? sess****alue : null),` |
| high-entropy-secret | 744c46ff0a75 | `packages/web/src/debug/__tests__/invocationEventDebug.test.ts` | 380 | `getItem: (key: string) => (key === invo****************_KEY ? localValue : null),` |
| high-entropy-secret | 744c46ff0a75 | `packages/web/src/debug/__tests__/invocationEventDebug.test.ts` | 419 | `getItem: (key: string) => (key === invo****************_KEY ? '1' : null),` |
| high-entropy-secret | 744c46ff0a75 | `packages/web/src/debug/__tests__/invocationEventDebug.test.ts` | 442 | `getItem: (key: string) => (key === invo****************_KEY ? '{bad-json' : null),` |
| high-entropy-secret | 744c46ff0a75 | `packages/web/src/debug/__tests__/invocationEventDebug.test.ts` | 448 | `getItem: (key: string) => (key === invo****************_KEY ? '1' : null),` |
| high-entropy-secret | 744c46ff0a75 | `packages/web/src/stores/chatStore.ts` | 230 | `const UI_T****************_KEY = 'catc****************ault';` |
| high-entropy-secret | b1d26f06712a | `packages/web/src/stores/chatStore.ts` | 230 | `const UI_T****************_KEY = 'catc****************ault';` |
| high-entropy-secret | 62c5b9a92ab4 | `packages/api/src/domains/cats/services/agents/providers/ClaudeAgentService.ts` | 42 | `const ANTH****************_KEY = 'CAT_****************RIDE';` |
| high-entropy-secret | 93f08ada5f0a | `packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts` | 202 | `feis***************oken: proc****************OKEN,` |
| high-entropy-secret | 93f08ada5f0a | `packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts` | 215 | `weco***********sKey: proc****************_KEY,` |
| high-entropy-secret | 93f08ada5f0a | `packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts` | 573 | `const ghWe*******cret = proc****************CRET;` |
| high-entropy-secret | edbe122e8c6c | `packages/api/src/domains/cats/services/agents/routing/route-helpers.ts` | 628 | `thresholds: { count: hcCo****************hold, token: hcCo****************hold },` |
| high-entropy-secret | edbe122e8c6c | `packages/api/src/domains/cats/services/stores/redis/RedisThreadStore.ts` | 372 | `const feedbackKey = Thre****************back(threadId);` |
| high-entropy-secret | edbe122e8c6c | `packages/api/src/domains/cats/services/stores/redis/RedisThreadStore.ts` | 380 | `const feedbackKey = Thre****************back(threadId);` |
| high-entropy-secret | edbe122e8c6c | `packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts` | 200 | `feis***************oken: proc****************OKEN,` |
| high-entropy-secret | edbe122e8c6c | `packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts` | 213 | `weco***********sKey: proc****************_KEY,` |
| high-entropy-secret | edbe122e8c6c | `packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts` | 566 | `const ghWe*******cret = proc****************CRET;` |
| high-entropy-secret | edbe122e8c6c | `packages/api/src/routes/connector-hub.ts` | 348 | `const veri*********oken = proc****************OKEN;` |
| high-entropy-secret | edbe122e8c6c | `packages/web/src/stores/chatStore.ts` | 144 | `const UI_T****************_KEY = 'catc****************ault';` |
| high-entropy-secret | 16ddb6767196 | `packages/api/src/domains/cats/services/agents/providers/ClaudeAgentService.ts` | 42 | `const ANTH****************_KEY = 'CAT_****************RIDE';` |
| high-entropy-secret | 16ddb6767196 | `packages/api/src/domains/cats/services/agents/routing/route-helpers.ts` | 618 | `thresholds: { count: hcCo****************hold, token: hcCo****************hold },` |
| high-entropy-secret | 16ddb6767196 | `packages/api/src/domains/cats/services/game/LlmAIProvider.ts` | 146 | `https://ge****************els/${this.model}:gene*******tent?key=${apiKey},` |
| high-entropy-secret | 16ddb6767196 | `packages/api/src/domains/cats/services/stores/redis/RedisThreadStore.ts` | 372 | `const feedbackKey = Thre****************back(threadId);` |
| high-entropy-secret | 16ddb6767196 | `packages/api/src/domains/cats/services/stores/redis/RedisThreadStore.ts` | 380 | `const feedbackKey = Thre****************back(threadId);` |
| high-entropy-secret | 16ddb6767196 | `packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts` | 200 | `feis***************oken: proc****************OKEN,` |
| high-entropy-secret | 16ddb6767196 | `packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts` | 213 | `weco***********sKey: proc****************_KEY,` |
| high-entropy-secret | 16ddb6767196 | `packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts` | 567 | `const ghWe*******cret = proc****************CRET;` |
| high-entropy-secret | 16ddb6767196 | `packages/web/src/stores/chatStore.ts` | 144 | `const UI_T****************_KEY = 'catc****************ault';` |
| high-entropy-secret | 5f61e6cd0d84 | `packages/api/src/domains/cats/services/agents/routing/route-helpers.ts` | 616 | `thresholds: { count: hcCo****************hold, token: hcCo****************hold },` |
| high-entropy-secret | 290f20122ab7 | `packages/api/src/domains/cats/services/stores/redis/RedisThreadStore.ts` | 369 | `const feedbackKey = Thre****************back(threadId);` |
| high-entropy-secret | 290f20122ab7 | `packages/api/src/domains/cats/services/stores/redis/RedisThreadStore.ts` | 377 | `const feedbackKey = Thre****************back(threadId);` |
| high-entropy-secret | ff92d777dd8d | `packages/web/src/stores/chatStore.ts` | 142 | `const UI_T****************_KEY = 'catc****************ault';` |
| high-entropy-secret | 227dc6b91f71 | `packages/web/src/stores/chatStore.ts` | 142 | `const UI_T****************_KEY = 'catc****************ault';` |
| high-entropy-secret | 7d7eaa3b1102 | `packages/api/src/domains/cats/services/agents/routing/route-helpers.ts` | 513 | `thresholds: { count: hcCo****************hold, token: hcCo****************hold },` |
| high-entropy-secret | 7d7eaa3b1102 | `packages/api/src/domains/cats/services/stores/redis/RedisThreadStore.ts` | 369 | `const feedbackKey = Thre****************back(threadId);` |
| high-entropy-secret | 7d7eaa3b1102 | `packages/api/src/domains/cats/services/stores/redis/RedisThreadStore.ts` | 377 | `const feedbackKey = Thre****************back(threadId);` |
| high-entropy-secret | 7d7eaa3b1102 | `packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts` | 194 | `feis***************oken: proc****************OKEN,` |
| high-entropy-secret | 7d7eaa3b1102 | `packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts` | 207 | `weco***********sKey: proc****************_KEY,` |
| high-entropy-secret | 7d7eaa3b1102 | `packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts` | 561 | `const ghWe*******cret = proc****************CRET;` |
| high-entropy-secret | 7d7eaa3b1102 | `packages/api/src/routes/connector-hub.ts` | 333 | `const veri*********oken = proc****************OKEN;` |
| high-entropy-secret | 7d7eaa3b1102 | `packages/web/src/stores/chatStore.ts` | 141 | `const UI_T****************_KEY = 'catc****************ault';` |
| high-entropy-secret | b3e2d516106f | `packages/api/src/domains/cats/services/game/LlmAIProvider.ts` | 145 | `https://ge****************els/${this.model}:gene*******tent?key=${apiKey},` |
| high-entropy-secret | 755cd1f5c029 | `packages/api/src/domains/cats/services/stores/redis/RedisThreadStore.ts` | 370 | `const feedbackKey = Thre****************back(threadId);` |
| high-entropy-secret | 755cd1f5c029 | `packages/api/src/domains/cats/services/stores/redis/RedisThreadStore.ts` | 378 | `const feedbackKey = Thre****************back(threadId);` |
| high-entropy-secret | 6ec12613a1b2 | `packages/api/src/domains/cats/services/agents/routing/route-helpers.ts` | 384 | `thresholds: { count: hcCo****************hold, token: hcCo****************hold },` |
| high-entropy-secret | 50c0ef62ab0b | `packages/api/src/domains/cats/services/agents/providers/ClaudeAgentService.ts` | 42 | `const ANTH****************_KEY = 'CAT_****************RIDE';` |
| high-entropy-secret | c1d23342dac3 | `packages/web/src/stores/chatStore.ts` | 113 | `const UI_T****************_KEY = 'catc****************ault';` |
| high-entropy-secret | 2938447dadec | `packages/api/src/domains/cats/services/game/LlmAIProvider.ts` | 145 | `https://ge****************els/${this.model}:gene*******tent?key=${apiKey},` |
| high-entropy-secret | 0444f6ef391a | `packages/api/src/domains/cats/services/agents/providers/ClaudeAgentService.ts` | 42 | `const ANTH****************_KEY = 'CAT_****************RIDE';` |
| high-entropy-secret | 0444f6ef391a | `packages/api/src/domains/cats/services/game/LlmAIProvider.ts` | 134 | `https://ge****************els/${this.model}:gene*******tent?key=${apiKey},` |
| high-entropy-secret | 0444f6ef391a | `packages/api/src/domains/cats/services/stores/redis/RedisThreadStore.ts` | 361 | `const feedbackKey = Thre****************back(threadId);` |
| high-entropy-secret | 0444f6ef391a | `packages/api/src/domains/cats/services/stores/redis/RedisThreadStore.ts` | 369 | `const feedbackKey = Thre****************back(threadId);` |
| high-entropy-secret | c13705f37b6f | `packages/api/src/domains/cats/services/game/LlmAIProvider.ts` | 134 | `https://ge****************els/${this.model}:gene*******tent?key=${apiKey},` |
| high-entropy-secret | baea3265b293 | `packages/api/src/domains/cats/services/game/LlmAIProvider.ts` | 132 | `https://ge****************els/${this.model}:gene*******tent?key=${apiKey},` |
| high-entropy-secret | baea3265b293 | `packages/api/src/routes/quota.ts` | 620 | `accessToken: pars****************oken,` |
| high-entropy-secret | baea3265b293 | `packages/api/src/routes/quota.ts` | 621 | `refr****oken: pars****************oken,` |
| high-entropy-secret | baa7c5df5d04 | `packages/api/src/domains/cats/services/game/LlmAIProvider.ts` | 140 | `https://ge****************els/${this.model}:gene*******tent?key=${apiKey},` |
| high-entropy-secret | 4ad89be8b113 | `packages/api/src/routes/quota.ts` | 997 | `accessToken: pars****************oken,` |
| high-entropy-secret | 4ad89be8b113 | `packages/api/src/routes/quota.ts` | 998 | `refr****oken: pars****************oken,` |
| high-entropy-secret | 953a37d5c57c | `packages/api/src/routes/quota.ts` | 840 | `accessToken: pars****************oken,` |
| high-entropy-secret | 953a37d5c57c | `packages/api/src/routes/quota.ts` | 841 | `refr****oken: pars****************oken,` |
| high-entropy-secret | 5d2307e2aca7 | `packages/api/src/domains/cats/services/game/LlmAIProvider.ts` | 141 | `https://ge****************els/${this.model}:gene*******tent?key=${apiKey},` |
| high-entropy-secret | 32e6f78de950 | `packages/api/src/domains/cats/services/game/LlmAIProvider.ts` | 138 | `https://ge****************els/${this.model}:gene*******tent?key=${apiKey},` |
| high-entropy-secret | 43a044336f91 | `packages/api/src/domains/cats/services/agents/providers/ClaudeAgentService.ts` | 42 | `const ANTH****************_KEY = 'CAT_****************RIDE';` |
| high-entropy-secret | 43a044336f91 | `packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts` | 194 | `feis***************oken: proc****************OKEN,` |
| high-entropy-secret | 43a044336f91 | `packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts` | 207 | `weco***********sKey: proc****************_KEY,` |
| high-entropy-secret | 43a044336f91 | `packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts` | 561 | `const ghWe*******cret = proc****************CRET;` |
| high-entropy-secret | 43a044336f91 | `packages/api/src/routes/connector-hub.ts` | 333 | `const veri*********oken = proc****************OKEN;` |
| high-entropy-secret | 43a044336f91 | `packages/web/src/stores/chatStore.ts` | 113 | `const UI_T****************_KEY = 'catc****************ault';` |
| high-entropy-secret | 95e6fdb3aaf0 | `packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts` | 190 | `feis***************oken: proc****************OKEN,` |
| high-entropy-secret | 95e6fdb3aaf0 | `packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts` | 203 | `weco***********sKey: proc****************_KEY,` |
| high-entropy-secret | 95e6fdb3aaf0 | `packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts` | 553 | `const ghWe*******cret = proc****************CRET;` |
| high-entropy-secret | 95e6fdb3aaf0 | `packages/api/src/routes/connector-hub.ts` | 317 | `const veri*********oken = proc****************OKEN;` |
| high-entropy-secret | 82b973f1ee61 | `packages/web/src/stores/chatStore.ts` | 113 | `const UI_T****************_KEY = 'catc****************ault';` |
| high-entropy-secret | 7a7f4e82b0fd | `packages/api/src/domains/cats/services/agents/providers/ClaudeAgentService.ts` | 42 | `const ANTH****************_KEY = 'CAT_****************RIDE';` |
| high-entropy-secret | 7a7f4e82b0fd | `packages/api/src/domains/cats/services/game/LlmAIProvider.ts` | 125 | `https://ge****************els/${this.model}:gene*******tent?key=${apiKey},` |
| high-entropy-secret | 7a7f4e82b0fd | `packages/api/src/domains/cats/services/stores/redis/RedisThreadStore.ts` | 356 | `const feedbackKey = Thre****************back(threadId);` |
| high-entropy-secret | 7a7f4e82b0fd | `packages/api/src/domains/cats/services/stores/redis/RedisThreadStore.ts` | 364 | `const feedbackKey = Thre****************back(threadId);` |
| high-entropy-secret | 7a7f4e82b0fd | `packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts` | 167 | `feis***************oken: proc****************OKEN,` |
| ... | ... | ... | ... | 66 more findings in JSON report |

## Notes

- Scanner source: project SecretScanner pattern set mirrored in this one-off full-history scan.
- Report JSON: `docs/ops/secret-scan-full-history-2026-07-04.json`.
- This scan is read-only and does not modify git history.
