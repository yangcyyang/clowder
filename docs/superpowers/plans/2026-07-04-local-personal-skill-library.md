# Local Personal Skill Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 接入本地个人 skill 库，让猫能按意图命中个人库能力，同时保持 prompt 常驻层不膨胀。

**Architecture:** 不把 `~/.claude/skills` 整棵 symlink 到 Clowder。新增只读 personal skill collection：扫描、去重、生成 index，然后让 SkillRouter 和 MCP `cat_cafe_list_skills`/`cat_cafe_read_skill` 读取已注册的 index。默认仅把最多 20 个高频个人 skill 放进可见菜单，完整集合只在 query/read 时按需访问。

**Tech Stack:** Fastify API, TypeScript, Node fs/path, YAML frontmatter parsing, MCP callback tools, existing `cat-cafe-skills/manifest.yaml` and `.cat-cafe` state files.

---

## Current Facts

- Canonical scan of `~/.claude/skills`:
  - 147 canonical `SKILL.md` files when scanning direct entries plus `gstack/*`.
  - 106 unique frontmatter names after dedupe.
  - 40 duplicate names caused mostly by top-level skill plus `gstack/<name>` mirror.
- Full recursive scan is unsafe:
  - 474 physical `SKILL.md` files.
  - 409 are under `gstack/`, including hidden adapter copies such as `.agents`, `.cursor`, `.factory`, `.gbrain`, `.hermes`, `.kiro`, `.openclaw`, `.opencode`, `.slate`.
- Repo live skills:
  - `cat-cafe-skills/*/SKILL.md`: 45.
  - Exact frontmatter-name overlap with personal canonical set: 0.
- Existing runtime paths:
  - API router: `packages/api/src/domains/cats/services/context/SkillRouter.ts`
  - MCP tools: `packages/mcp-server/src/tools/skill-tools.ts`
  - Skills board route: `packages/api/src/routes/skills.ts`
  - Capabilities board route: `packages/api/src/routes/capabilities.ts`
  - Skill sync state: `packages/api/src/config/governance/skills-state.ts`
- Existing constraints:
  - `SkillRouter` currently injects only router instructions and matched skill names, not full skill bodies.
  - `cat_cafe_read_skill` is the progressive-disclosure body loader.
  - MCP server cannot import API source directly because of package rootDir boundaries.

## Design Decisions

1. Use registration, not recursive mounting.
   - Personal roots are read-only.
   - Only indexed and registered skills are exposed.
   - Hidden adapter directories are ignored by default.

2. Use an index file as the contract between scanner and runtime.
   - Write to `.cat-cafe/personal-skills-index.json`.
   - Runtime reads the index; it does not recursively walk personal roots on every prompt.
   - This avoids slow starts and makes review/debug reproducible.

3. Canonical path selection prevents directory explosion.
   - Preferred order:
     1. `~/.claude/skills/<skill>/SKILL.md`
     2. `~/.claude/skills/gstack/<skill>/SKILL.md`
   - Ignore nested hidden copies under `gstack/.*/skills`.
   - Deduplicate by `frontmatter.name`; if missing, use directory name.
   - If two canonical candidates share a name, prefer the top-level file and record the loser in `duplicates[]`.

4. Visible list stays small.
   - Default visible personal skills cap: 20.
   - Full index remains searchable through `cat_cafe_list_skills({ query })`.
   - No full personal skill body enters prompt unless the model explicitly calls `cat_cafe_read_skill`.

5. No destructive cleanup in D1.
   - Do not delete or move `~/.claude/skills`.
   - Do not mass symlink 106 skills into project provider folders.
   - Do not alter existing `cat-cafe-skills` source skills.

6. Do not put YAML/frontmatter scanner code into `@cat-cafe/shared` in the first cut.
   - `@cat-cafe/shared` currently has no `yaml` dependency.
   - Adding scanner logic there would widen package dependencies for both API and MCP.
   - The stable cross-package contract should be the generated JSON index schema, not a shared runtime scanner module.

7. Personal collection must not enter `capabilities.json`.
   - Existing `/api/capabilities` scans user provider dirs such as `~/.claude/skills` and auto-adds discovered names as `source: external`.
   - D1 must explicitly exclude indexed personal skill names from that auto-add path when `CAT_CAFE_PERSONAL_SKILLS_ENABLED=1`.
   - `packages/shared/src/types/capability.ts` should not be widened to `source: 'personal'` in D1. Personal skills are reported by `/api/skills` as a read-only collection section, not as `CapabilityBoardItem`.

## Initial Visible Personal Skill Set

Use this as the first `visibleNames` list. It is intentionally capped at 20 and biased toward reusable product/design/dev workflows:

```text
create-prd
product-strategy
business-model
competitor-analysis
competitive-battlecard
customer-journey-map
market-sizing
pricing-strategy
user-personas
value-proposition
design-review
high-end-visual-design
image-to-code
opencli-usage
opencli-browser
gstack
investigate
qa
review
make-pdf
```

## Proposed Index Schema

```ts
export interface PersonalSkillIndex {
  version: 1;
  generatedAt: string;
  roots: string[];
  ignoredGlobs: string[];
  visibleNames: string[];
  skills: PersonalSkillIndexEntry[];
  duplicates: Array<{
    name: string;
    keptPath: string;
    skippedPaths: string[];
  }>;
}

export interface PersonalSkillIndexEntry {
  id: string; // personal:<name>
  name: string;
  description: string;
  triggers: string[];
  category: string;
  source: 'personal';
  sourcePath: string;
  relativePath: string;
  visible: boolean;
  contentHash: string;
}
```

## Task 1: Scanner And Index Writer

**Files:**
- Create: `packages/api/src/config/skills/personal-skill-scanner.ts`
- Create: `packages/api/src/scripts/rebuild-personal-skills.ts`
- Create: `packages/api/test/personal-skill-scanner.test.js`
- Modify: `packages/api/src/config/env-registry.ts`

- [ ] **Step 1: Write failing scanner tests**

Create fixture directories in a temp root:

```text
skills/
├── create-prd/SKILL.md
├── gstack/create-prd/SKILL.md
├── gstack/review/SKILL.md
└── gstack/.agents/skills/gstack-review/SKILL.md
```

Expected assertions:

```js
assert.equal(index.skills.length, 2);
assert.deepEqual(index.skills.map((s) => s.name).sort(), ['create-prd', 'review']);
assert.equal(index.skills.find((s) => s.name === 'create-prd').relativePath, 'create-prd/SKILL.md');
assert.equal(index.duplicates[0].name, 'create-prd');
assert.ok(index.duplicates[0].skippedPaths.includes('gstack/create-prd/SKILL.md'));
assert.ok(index.skills.every((s) => !s.sourcePath.includes('/.agents/')));
```

Run:

```bash
./node_modules/.bin/tsc -p packages/api/tsconfig.json
node --test packages/api/test/personal-skill-scanner.test.js
```

Expected RED:

```text
Cannot find module '../dist/config/skills/personal-skill-scanner.js'
```

- [ ] **Step 2: Implement scanner**

Implementation requirements:

- Use `realpath`/`resolve` to ensure every `sourcePath` is inside one configured root.
- Expand `~` to `homedir()` before resolving roots; Node `resolve('~/.claude/skills')` is not shell expansion.
- Parse YAML frontmatter with existing `yaml` dependency in API package.
- Ignore directory segments that start with `.` below the first skill level.
- Read only `SKILL.md`; do not follow arbitrary extra files.
- Compute `contentHash = sha256(content).slice(0, 16)`.
- Default roots:

```ts
const DEFAULT_PERSONAL_SKILL_ROOTS = ['~/.claude/skills'];
const DEFAULT_IGNORED_SEGMENTS = new Set([
  '.agents',
  '.cursor',
  '.factory',
  '.gbrain',
  '.hermes',
  '.kiro',
  '.openclaw',
  '.opencode',
  '.slate',
]);
```

- [ ] **Step 3: Add CLI rebuild script**

Create `packages/api/src/scripts/rebuild-personal-skills.ts`:

```ts
import { rebuildPersonalSkillIndexFromEnv } from '../config/skills/personal-skill-scanner.js';

const result = await rebuildPersonalSkillIndexFromEnv(process.cwd(), process.env);
console.log(
  `total=${result.total} visible=${result.visible} duplicates=${result.duplicates} ignoredHiddenDirs=${result.ignoredHiddenDirs}`,
);
```

The script writes the same index file as the route in Task 2. It exists so operators can rebuild the personal collection without starting the API server.

- [ ] **Step 4: Register env vars**

Add env definitions:

```text
CAT_CAFE_PERSONAL_SKILLS_ENABLED default 0
CAT_CAFE_PERSONAL_SKILL_ROOTS default ~/.claude/skills
CAT_CAFE_PERSONAL_SKILL_VISIBLE_NAMES default first 20 list
CAT_CAFE_PERSONAL_SKILL_INDEX_PATH default .cat-cafe/personal-skills-index.json
```

Run:

```bash
node scripts/check-env-registry.test.mjs
node scripts/check-env-example.test.mjs
```

Expected GREEN: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/config/skills/personal-skill-scanner.ts \
  packages/api/src/scripts/rebuild-personal-skills.ts \
  packages/api/test/personal-skill-scanner.test.js \
  packages/api/src/config/env-registry.ts
git commit -m "feat: add personal skill collection scanner"
```

## Task 2: Rebuild Route And State File

**Files:**
- Modify: `packages/api/src/routes/skills.ts`
- Test: `packages/api/test/skills-route.test.js`

- [ ] **Step 1: Write failing route tests**

Add tests for:

- `POST /api/skills/personal/rebuild` requires identity.
- When `CAT_CAFE_PERSONAL_SKILLS_ENABLED=0`, returns `{ enabled:false }` and writes nothing.
- When enabled, writes `.cat-cafe/personal-skills-index.json`.
- Response includes `total`, `visible`, `duplicates`, `ignored`.

Expected command:

```bash
./node_modules/.bin/tsc -p packages/api/tsconfig.json
node --test packages/api/test/skills-route.test.js
```

- [ ] **Step 2: Implement route**

Route contract:

```http
POST /api/skills/personal/rebuild
```

Response:

```json
{
  "enabled": true,
  "total": 106,
  "visible": 20,
  "duplicates": 40,
  "indexPath": ".cat-cafe/personal-skills-index.json"
}
```

The route must validate `projectPath` with `validateProjectPath` if provided.

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/routes/skills.ts packages/api/test/skills-route.test.js
git commit -m "feat: add personal skill rebuild route"
```

## Task 3: SkillRouter Reads Personal Index

**Files:**
- Modify: `packages/api/src/domains/cats/services/context/SkillRouter.ts`
- Test: `packages/api/test/skill-router-context.test.js`

- [ ] **Step 1: Write failing router tests**

Add fixtures with a personal index containing `create-prd` and `review`.

Assertions:

```js
const context = resolveSkillRouterContext('帮我写一个 PRD');
assert.ok(context.promptBlock.includes('Skill Router'));
assert.ok(context.matchedSkillNames.includes('create-prd'));
assert.ok(context.promptBlock.length < 2500);
assert.equal(context.promptBlock.includes('完整 SKILL.md 内容'), false);
```

Also test disabled mode:

```js
process.env.CAT_CAFE_PERSONAL_SKILLS_ENABLED = '0';
assert.equal(resolveSkillRouterContext('帮我写一个 PRD')?.matchedSkillNames.includes('create-prd'), false);
```

Also test cache invalidation:

```js
writePersonalIndex({ skills: [{ name: 'create-prd', visible: true }] });
assert.ok(resolveSkillRouterContext('帮我写 PRD')?.matchedSkillNames.includes('create-prd'));

writePersonalIndex({ skills: [{ name: 'review', visible: true }] });
assert.equal(resolveSkillRouterContext('帮我写 PRD')?.matchedSkillNames.includes('create-prd'), false);
assert.ok(resolveSkillRouterContext('帮我 review')?.matchedSkillNames.includes('review'));

process.env.CAT_CAFE_PERSONAL_SKILLS_ENABLED = '0';
assert.equal(resolveSkillRouterContext('帮我 review')?.matchedSkillNames.includes('review'), false);
```

- [ ] **Step 2: Implement index loader**

Requirements:

- Load repo skills first.
- Load personal index only when `CAT_CAFE_PERSONAL_SKILLS_ENABLED` is truthy.
- Merge by skill name:
  - repo `cat-cafe` wins over personal if names collide.
  - personal entries use `id = personal:<name>`.
- Match scoring can reuse existing trigger/name scoring.
- `menuSkillCount` counts repo + visible personal skills, not the whole hidden collection.
- Cache key must include:
  - `CAT_CAFE_PERSONAL_SKILLS_ENABLED`
  - resolved index path
  - index file mtime
  - resolved personal roots
  - visible name list
- Rebuilds and env toggles must take effect without restarting the process in tests.

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/domains/cats/services/context/SkillRouter.ts \
  packages/api/test/skill-router-context.test.js
git commit -m "feat: route personal skills on demand"
```

## Task 4: MCP list/read Skill Supports Personal Collection

**Files:**
- Modify: `packages/mcp-server/src/tools/skill-tools.ts`
- Test: `packages/mcp-server/test/skill-tools.test.js`

- [ ] **Step 1: Write failing MCP tests**

Cases:

- `cat_cafe_list_skills({})` renders personal skills in a separate section and includes only visible personal skills in that section.
- `cat_cafe_list_skills({ query: 'opencli' })` can find hidden personal skills matching query.
- `cat_cafe_read_skill({ name: 'personal:create-prd' })` reads only if path is inside registered root.
- A malicious index entry with `sourcePath: '/etc/passwd'` is rejected.
- A root-internal symlink `skills/escape/SKILL.md -> /tmp/outside/SKILL.md` is rejected.
- Rebuilding the index or toggling `CAT_CAFE_PERSONAL_SKILLS_ENABLED` invalidates the MCP catalog cache.
- `cat_cafe_read_skill({ name: 'missing' })` returns a bounded suggestion list, not all 100+ personal names.

- [ ] **Step 2: Implement safe personal path read**

Add safety rules:

```ts
async function isSafePersonalSkillPath(path: string, roots: string[]): Promise<boolean> {
  const realSourcePath = await realpath(path);
  if (!realSourcePath.endsWith('/SKILL.md')) return false;
  for (const root of roots) {
    const realRoot = await realpath(expandTilde(root));
    if (realSourcePath === realRoot || realSourcePath.startsWith(`${realRoot}/`)) return true;
  }
  return false;
}
```

Use the same enabled/index env vars as API.

MCP cache key must include:

- `CAT_CAFE_PERSONAL_SKILLS_ENABLED`
- resolved index path
- index file mtime
- resolved roots
- visible name list

Default list output rules:

- Keep the existing repo skill menu behavior for Cat Cafe skills.
- Add a second heading `## Personal Skills（visible）` with at most 20 visible personal skills.
- Query mode searches both repo skills and the full personal index; hidden personal matches can appear only when query is present.
- `readSkill` not-found output must show at most 35 suggestions total.

- [ ] **Step 3: Commit**

```bash
git add packages/mcp-server/src/tools/skill-tools.ts packages/mcp-server/test/skill-tools.test.js
git commit -m "feat: expose personal skills through mcp"
```

## Task 5: Capability Isolation And Dashboard Visibility

**Files:**
- Modify: `packages/api/src/routes/capabilities.ts`
- Modify: `packages/api/src/routes/skills.ts`
- Test: `packages/api/test/capabilities-route.test.js`
- Test: `packages/api/test/skills-route.test.js`

**Reference Only:**
- `packages/shared/src/types/capability.ts` (confirm no source widening is needed)

- [ ] **Step 1: Write failing capability isolation tests**

Assertions for `/api/capabilities`:

- With `CAT_CAFE_PERSONAL_SKILLS_ENABLED=1` and a personal index containing `create-prd`, a user-level `~/.claude/skills/create-prd/SKILL.md` does not get auto-added to `.cat-cafe/capabilities.json`.
- Existing `source: external` skill entries whose ids are in the personal index are removed or hidden from the capability board when they are not project-level skills.
- Unrelated external skills outside the indexed personal names still behave exactly as before.
- `CapabilityBoardItem.source` remains only `'cat-cafe' | 'external'`; D1 must not add `'personal'` to shared capability types.

Implementation hint:

```ts
const personalSkillNames = await loadEnabledPersonalSkillNameSet(projectRoot, process.env);
for (const skillName of allSkillNames) {
  if (personalSkillNames.has(skillName) && !projectSkillNames.has(skillName)) continue;
  // existing auto-add logic
}
config.capabilities = config.capabilities.filter((cap) => {
  if (cap.type !== 'skill' || cap.source !== 'external') return true;
  return !(personalSkillNames.has(cap.id) && !projectSkillNames.has(cap.id));
});
```

This is config cleanup, not filesystem cleanup. It must not delete personal skill files or symlinks.

- [ ] **Step 2: Write failing dashboard tests**

Assertions:

- `/api/skills` response includes `source: 'personal'` for personal entries.
- Summary includes `personalTotal`, `personalVisible`, `personalHidden`.
- Personal skills do not affect `registrationConsistent` for built-in `cat-cafe-skills`.
- No symlink mount requirement is shown for personal skills.
- Personal skills are returned only from `/api/skills`, not `/api/capabilities` `CapabilityBoardItem`.

- [ ] **Step 3: Implement response shape**

Add optional fields:

```ts
interface SkillsSummary {
  total: number;
  allMounted: boolean;
  registrationConsistent: boolean;
  personalTotal?: number;
  personalVisible?: number;
  personalHidden?: number;
}
```

For personal skills:

```ts
mounts: { claude: false, codex: false, gemini: false, kimi: false }
source: 'personal'
```

The `/api/skills` UI can display them as read-only collection items instead of mount-health items. Do not reuse `CapabilityBoardItem` for personal skills in D1; extending shared capability source types would be a separate feature spec.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/routes/capabilities.ts packages/api/src/routes/skills.ts \
  packages/api/test/capabilities-route.test.js packages/api/test/skills-route.test.js
git commit -m "feat: isolate personal skill collection"
```

## Task 6: Final Verification

- [ ] **Step 1: Run targeted tests**

```bash
./node_modules/.bin/tsc -p packages/api/tsconfig.json --noEmit
./node_modules/.bin/tsc -p packages/mcp-server/tsconfig.json --noEmit
node --test packages/api/test/personal-skill-scanner.test.js \
  packages/api/test/skill-router-context.test.js \
  packages/api/test/skills-route.test.js \
  packages/api/test/capabilities-route.test.js
node --test packages/mcp-server/test/skill-tools.test.js \
  packages/mcp-server/test/tool-registration.test.js
node scripts/check-env-registry.test.mjs
node scripts/check-env-example.test.mjs
git diff --check
```

- [ ] **Step 2: Manual smoke**

With a temp index path:

```bash
CAT_CAFE_PERSONAL_SKILLS_ENABLED=1 \
CAT_CAFE_PERSONAL_SKILL_ROOTS="$HOME/.claude/skills" \
CAT_CAFE_PERSONAL_SKILL_INDEX_PATH="$(pwd)/.cat-cafe/personal-skills-index.json" \
node packages/api/dist/scripts/rebuild-personal-skills.js
```

Expected:

```text
total=106 visible=20 duplicates=40 ignoredHiddenDirs>=9
```

- [ ] **Step 3: Review checklist**

Confirm:

- No personal skill content is injected always-on.
- `cat_cafe_read_skill` refuses paths outside registered roots.
- `cat_cafe_read_skill` refuses root-internal symlinks that resolve outside registered roots.
- Visible personal skills are capped at 20.
- Full personal collection is searchable by query.
- Existing repo skills still win if names collide.
- Personal indexed names are not written to `.cat-cafe/capabilities.json` as `source: external`.
- SkillRouter and MCP cache invalidate on index mtime/env changes.

## Risks And Mitigations

- Risk: personal skill prompt injection.
  - Mitigation: registration required, read-only source, explicit `cat_cafe_read_skill`, no auto body injection.
- Risk: directory explosion from generated adapter copies.
  - Mitigation: hidden adapter dirs ignored and duplicate names recorded.
- Risk: MCP/API catalog drift.
  - Mitigation: index schema is the shared contract; both sides read the same JSON.
- Risk: user expects all 106 skills visible.
  - Mitigation: visible cap is deliberate; query searches full collection.

## Acceptance Criteria

- `~/.claude/skills` canonical scan yields a stable personal index.
- At most 20 personal skills appear in default list/menu.
- Query can find hidden personal skills.
- `cat_cafe_read_skill` can read a registered personal skill and rejects unsafe paths.
- A user prompt such as “帮我写 PRD” can match `create-prd` without injecting the full skill body.
- No physical cleanup, deletion, or mass symlink of personal skills is performed.
- `/api/capabilities` does not classify personal collection entries as ordinary external skills.
