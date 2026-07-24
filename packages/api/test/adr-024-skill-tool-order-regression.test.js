/**
 * ADR-024 D6 W2-D: tool-definition ordering regression gate.
 *
 * docs/decisions/024-kv-cache-friendly-context-layout.md D6:
 *   "MCP 工具列表相邻调用间字节稳定（现状：SkillRouter 按字母序 `localeCompare`，
 *    已合规），加回归测试防退化。"
 *
 * The prompt-visible "tool menu" (Skill Router catalog, rendered into the
 * `## Skill Router` / `## Skill Router 命中` block) is produced by
 * `loadSkillRouterCatalog()` → `mergeSkillEntries()` in SkillRouter.ts, which
 * sorts by `entry.name.localeCompare(other.name, 'zh-Hans-CN')`. If this
 * ordering were unstable (Map iteration order, filesystem readdir order,
 * etc.) or a future edit dropped/changed the comparator, the rendered block's
 * bytes would churn turn-over-turn even with no actual skill catalog change —
 * breaking the KV-cache-stable prefix D6 exists to protect.
 *
 * This file locks in two properties:
 *   ① two adjacent calls to loadSkillRouterCatalog() (same process, unchanged
 *      underlying files) produce byte-identical output.
 *   ② the returned order is exactly `zh-Hans-CN` locale-compare ascending by
 *      name — not codepoint order, not insertion order — so a regression to
 *      e.g. a bare `.sort()` (which sorts by UTF-16 code unit and would
 *      reorder mixed-case names differently) is caught.
 *
 * Fixture entries are injected via the PERSONAL skill index
 * (`normalizePersonalIndexEntry` in SkillRouter.ts), which does not require a
 * real on-disk SKILL.md — unlike the cat-cafe external manifest path
 * (`normalizeCatalogEntry`), which hard-validates `source_path` against the
 * real skills root (`isSafeCatCafeSkillPath`) and would silently drop any
 * fixture pointed at a tmp directory.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';

const PERSONAL_ENV_KEYS = [
  'CAT_CAFE_PERSONAL_SKILLS_ENABLED',
  'CAT_CAFE_PERSONAL_SKILL_ROOTS',
  'CAT_CAFE_PERSONAL_SKILL_VISIBLE_NAMES',
  'CAT_CAFE_PERSONAL_SKILL_VISIBLE_ALL',
  'CAT_CAFE_PERSONAL_SKILL_INDEX_PATH',
];

function writePersonalIndex(indexPath, names) {
  mkdirSync(dirname(indexPath), { recursive: true });
  writeFileSync(
    indexPath,
    JSON.stringify(
      {
        version: 1,
        generatedAt: new Date().toISOString(),
        roots: [],
        ignoredGlobs: [],
        visibleNames: names,
        skills: names.map((name) => ({
          id: `personal:${name}`,
          name,
          description: `fixture skill ${name}`,
          triggers: [`${name}-trigger`],
          category: 'personal',
          source: 'personal',
          sourcePath: `/fixture/${name}/SKILL.md`,
          relativePath: `${name}/SKILL.md`,
          visible: true,
          contentHash: `${name}-hash`,
        })),
        duplicates: [],
        ignoredPaths: [],
      },
      null,
      2,
    ),
    'utf-8',
  );
}

async function withScopedEnv(overrides, fn) {
  const previous = new Map(PERSONAL_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of PERSONAL_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('ADR-024 D6: SkillRouter tool-list ordering regression gate', () => {
  test('loadSkillRouterCatalog() output is deterministic and localeCompare(zh-Hans-CN)-sorted across two adjacent calls', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'skill-order-regression-'));
    const indexPath = join(workDir, 'personal-skill-index.json');

    // Deliberately scrambled + mixed-case so codepoint order and locale order
    // diverge (see verification below) — a real regression-catcher, not a
    // fixture that would pass under either sort.
    const fixtureNames = ['zeta-fixture-skill', 'alpha-fixture-skill', 'Mango-fixture-skill', 'Bravo-fixture-skill'];
    writePersonalIndex(indexPath, fixtureNames);

    await withScopedEnv(
      { CAT_CAFE_PERSONAL_SKILLS_ENABLED: 'true', CAT_CAFE_PERSONAL_SKILL_INDEX_PATH: indexPath },
      async () => {
        // Cache-bust the module import (SkillRouter.ts keeps an internal
        // catalogCache keyed by file fingerprints) so this test starts fresh,
        // matching the pattern used in test/skill-router-context.test.js.
        const moduleUrl = new URL(
          `../dist/domains/cats/services/context/SkillRouter.js?case=${Date.now()}-${Math.random()}`,
          import.meta.url,
        );
        const { loadSkillRouterCatalog } = await import(moduleUrl.href);

        const first = loadSkillRouterCatalog();
        const second = loadSkillRouterCatalog();

        // ① byte-stability: two adjacent generations produce identical bytes.
        assert.equal(
          JSON.stringify(first),
          JSON.stringify(second),
          'two adjacent loadSkillRouterCatalog() calls must be byte-identical when nothing changed on disk',
        );

        const names = first.map((s) => s.name);
        assert.ok(
          fixtureNames.every((n) => names.includes(n)),
          `all fixture names must be present in the catalog, got: ${JSON.stringify(names)}`,
        );

        // ② whole-array sortedness: the ENTIRE merged catalog (fixture + real
        // repo/external skills) must already be in localeCompare(zh-Hans-CN)
        // ascending order — not just our fixture slice.
        const expectedFullOrder = [...names].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
        assert.deepEqual(names, expectedFullOrder, 'catalog must be sorted by name.localeCompare(other, "zh-Hans-CN")');

        // Regression-catcher: prove locale-compare order is NOT the same as a
        // bare codepoint `.sort()` for this exact fixture — i.e. this test
        // would actually fail to distinguish a regression if the two orders
        // happened to coincide.
        const codepointOrderOfFixture = [...fixtureNames].sort();
        const localeOrderOfFixture = names.filter((n) => fixtureNames.includes(n));
        assert.notDeepEqual(
          localeOrderOfFixture,
          codepointOrderOfFixture,
          'fixture is only a useful regression-catcher if locale-compare and codepoint order diverge for it',
        );

        // The fixture skills, in isolation, must appear in exactly the
        // locale-compare order (subsequence check — other real skills may be
        // interleaved around them alphabetically, that's fine and expected).
        const expectedFixtureOrder = [...fixtureNames].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
        assert.deepEqual(
          localeOrderOfFixture,
          expectedFixtureOrder,
          'fixture skills must appear in zh-Hans-CN locale-compare order relative to each other',
        );
      },
    );

    rmSync(workDir, { recursive: true, force: true });
  });

  test('resolveSkillRouterContext() promptBlock is byte-identical across two adjacent calls with the same (unmatched) message', async () => {
    // Sub-invariant of D6: when nothing about the catalog or the user message
    // changes, the rendered tool-menu block itself (not just the raw catalog
    // array) must be byte-stable — this is the text that actually sits in the
    // prompt.
    const moduleUrl = new URL(
      `../dist/domains/cats/services/context/SkillRouter.js?case=${Date.now()}-${Math.random()}`,
      import.meta.url,
    );
    const { resolveSkillRouterContext } = await import(moduleUrl.href);

    const first = resolveSkillRouterContext('随便说点没有命中任何 skill 触发词的话');
    const second = resolveSkillRouterContext('随便说点没有命中任何 skill 触发词的话');

    assert.equal(first?.promptBlock, second?.promptBlock, 'promptBlock must be byte-identical across adjacent calls');
  });
});
