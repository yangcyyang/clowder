import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ROUTER_ENV_KEYS = [
  'CAT_CAFE_SKILL_MANIFEST_PATH',
  'CAT_CAFE_PERSONAL_SKILLS_ENABLED',
  'CAT_CAFE_PERSONAL_SKILL_INDEX_PATH',
  'CAT_CAFE_PERSONAL_SKILL_ROOTS',
  'CAT_CAFE_PERSONAL_SKILL_VISIBLE_NAMES',
];

async function withRouterEnv(overrides, fn) {
  const previous = new Map(ROUTER_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ROUTER_ENV_KEYS) {
    if (Object.hasOwn(overrides, key)) process.env[key] = overrides[key];
    else delete process.env[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function importSkillRouter(caseName) {
  const moduleUrl = new URL(
    `../dist/domains/cats/services/context/SkillRouter.js?case=${caseName}-${Date.now()}`,
    import.meta.url,
  );
  return import(moduleUrl.href);
}

function writeExternalManifest(workDir, skills = []) {
  const manifestPath = join(workDir, 'skills-manifest.json');
  writeFileSync(manifestPath, JSON.stringify({ skills }, null, 2));
  return manifestPath;
}

function writePersonalIndex(indexPath, skills) {
  mkdirSync(dirname(indexPath), { recursive: true });
  writeFileSync(
    indexPath,
    JSON.stringify(
      {
        version: 1,
        generatedAt: new Date().toISOString(),
        roots: [dirname(indexPath)],
        ignoredGlobs: [],
        visibleNames: skills.filter((skill) => skill.visible).map((skill) => skill.name),
        skills: skills.map((skill) => ({
          id: `personal:${skill.name}`,
          name: skill.name,
          description: skill.description ?? skill.name,
          triggers: skill.triggers ?? [],
          category: skill.category ?? 'personal',
          source: 'personal',
          sourcePath: join(dirname(indexPath), `${skill.name}.md`),
          relativePath: `${skill.name}/SKILL.md`,
          visible: skill.visible ?? true,
          contentHash: skill.contentHash ?? `${skill.name}-hash`,
        })),
        duplicates: [],
        ignoredPaths: [],
      },
      null,
      2,
    ),
  );
}

describe('SkillRouter', { concurrency: false }, () => {
  test('loads cat-cafe skill menu and matches triggers to SKILL.md', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'skill-router-'));
    const skillPath = resolve(REPO_ROOT, 'cat-cafe-skills/debugging/SKILL.md');
    const manifestPath = writeExternalManifest(workDir, [
      {
        id: 'cat-cafe:debugging',
        name: 'debugging',
        description: '>',
        triggers: ['报错', '排查'],
        source: 'cat-cafe',
        risk_level: '中',
        source_path: skillPath,
        clowder_available: true,
      },
    ]);

    await withRouterEnv({ CAT_CAFE_SKILL_MANIFEST_PATH: manifestPath }, async () => {
      const { resolveSkillRouterContext } = await importSkillRouter('debugging');

      const context = resolveSkillRouterContext('页面报错了，请排查根因并修复');
      assert.ok(context);
      assert.deepEqual(context.matchedSkillNames, ['debugging']);
      assert.ok(context.menuSkillCount >= 1);
      assert.match(context.promptBlock, /## Skill Router/);
      assert.match(context.promptBlock, /本轮根据用户消息命中 skill: debugging/);
      assert.match(context.promptBlock, /cat_cafe_read_skill/);
    });
  });

  test('falls back to repo manifest for project-workflow when external manifest omits it', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'skill-router-repo-manifest-'));
    const manifestPath = writeExternalManifest(workDir);

    await withRouterEnv({ CAT_CAFE_SKILL_MANIFEST_PATH: manifestPath }, async () => {
      const { resolveSkillRouterContext } = await importSkillRouter('repo');

      const context = resolveSkillRouterContext('继续推进 Clowder，先接手项目状态');
      assert.ok(context);
      assert.ok(context.matchedSkillNames.includes('project-workflow'));
      assert.match(context.promptBlock, /本轮根据用户消息命中 skill: project-workflow/);

      const progressContext = resolveSkillRouterContext('看下当前进度，再判断下一步');
      assert.ok(progressContext);
      assert.ok(progressContext.matchedSkillNames.includes('project-workflow'));

      const statusContext = resolveSkillRouterContext('项目状态现在是什么？');
      assert.ok(statusContext);
      assert.ok(statusContext.matchedSkillNames.includes('project-workflow'));
    });
  });

  test('matches project-workflow slash aliases without fast lane', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'skill-router-slash-alias-'));
    const manifestPath = writeExternalManifest(workDir);

    await withRouterEnv({ CAT_CAFE_SKILL_MANIFEST_PATH: manifestPath }, async () => {
      const { resolveSkillRouterContext } = await importSkillRouter('slash');

      const continueContext = resolveSkillRouterContext('/continue-project clowder');
      assert.ok(continueContext);
      assert.deepEqual(continueContext.matchedSkillNames, ['project-workflow']);

      const statusContext = resolveSkillRouterContext('/project-status clowder');
      assert.ok(statusContext);
      assert.deepEqual(statusContext.matchedSkillNames, ['project-workflow']);
    });
  });

  test('injects reuse gate for matched skills and exploration fallback for new work', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'skill-router-reuse-gate-'));
    const manifestPath = writeExternalManifest(workDir);

    await withRouterEnv({ CAT_CAFE_SKILL_MANIFEST_PATH: manifestPath }, async () => {
      const { resolveSkillRouterContext } = await importSkillRouter('reuse');

      const matched = resolveSkillRouterContext('继续推进 Clowder，先接手项目状态');
      assert.ok(matched);
      assert.match(matched.promptBlock, /优先复用已命中的 workflow\/skill/);
      assert.match(matched.promptBlock, /project-workflow/);

      const exploratory = resolveSkillRouterContext('实现一个从未沉淀过的水晶球排班玩法');
      assert.ok(exploratory);
      assert.deepEqual(exploratory.matchedSkillNames, []);
      assert.match(exploratory.promptBlock, /未命中明确 skill/);
      assert.match(exploratory.promptBlock, /探索模式/);
      assert.match(exploratory.promptBlock, /重复、高频、步骤稳定、异常可枚举/);
    });
  });

  test('loads enabled personal index without injecting full skill bodies', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'skill-router-personal-'));
    const manifestPath = writeExternalManifest(workDir);
    const indexPath = join(workDir, '.cat-cafe', 'personal-skills-index.json');
    writePersonalIndex(indexPath, [
      {
        name: 'create-prd',
        description: '完整 SKILL.md 内容 should not appear in prompt',
        triggers: ['PRD', '需求文档'],
        visible: true,
      },
      { name: 'review', description: 'Review work before shipping', triggers: ['review'], visible: false },
    ]);

    await withRouterEnv(
      {
        CAT_CAFE_SKILL_MANIFEST_PATH: manifestPath,
        CAT_CAFE_PERSONAL_SKILLS_ENABLED: '1',
        CAT_CAFE_PERSONAL_SKILL_INDEX_PATH: indexPath,
        CAT_CAFE_PERSONAL_SKILL_ROOTS: dirname(indexPath),
        CAT_CAFE_PERSONAL_SKILL_VISIBLE_NAMES: 'create-prd',
      },
      async () => {
        const { resolveSkillRouterContext } = await importSkillRouter('personal');

        const context = resolveSkillRouterContext('帮我写一个 PRD');
        assert.ok(context);
        assert.ok(context.promptBlock.includes('Skill Router'));
        assert.ok(context.matchedSkillNames.includes('create-prd'));
        assert.ok(context.promptBlock.length < 2500);
        assert.equal(context.promptBlock.includes('完整 SKILL.md 内容'), false);

        process.env.CAT_CAFE_PERSONAL_SKILLS_ENABLED = '0';
        const disabled = resolveSkillRouterContext('帮我写一个 PRD');
        assert.ok(disabled);
        assert.equal(context.menuSkillCount, disabled.menuSkillCount + 1);
      },
    );
    rmSync(workDir, { recursive: true, force: true });
  });

  test('ignores personal index when disabled', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'skill-router-personal-disabled-'));
    const manifestPath = writeExternalManifest(workDir);
    const indexPath = join(workDir, '.cat-cafe', 'personal-skills-index.json');
    writePersonalIndex(indexPath, [{ name: 'create-prd', triggers: ['PRD'], visible: true }]);

    await withRouterEnv(
      {
        CAT_CAFE_SKILL_MANIFEST_PATH: manifestPath,
        CAT_CAFE_PERSONAL_SKILLS_ENABLED: '0',
        CAT_CAFE_PERSONAL_SKILL_INDEX_PATH: indexPath,
      },
      async () => {
        const { resolveSkillRouterContext } = await importSkillRouter('personal-disabled');

        const context = resolveSkillRouterContext('帮我写一个 PRD');
        assert.ok(context);
        assert.equal(context.matchedSkillNames.includes('create-prd'), false);
      },
    );
    rmSync(workDir, { recursive: true, force: true });
  });

  test('invalidates personal catalog cache when index and env change', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'skill-router-personal-cache-'));
    const manifestPath = writeExternalManifest(workDir);
    const indexPath = join(workDir, '.cat-cafe', 'personal-skills-index.json');
    writePersonalIndex(indexPath, [{ name: 'create-prd', triggers: ['PRD'], visible: true }]);

    await withRouterEnv(
      {
        CAT_CAFE_SKILL_MANIFEST_PATH: manifestPath,
        CAT_CAFE_PERSONAL_SKILLS_ENABLED: '1',
        CAT_CAFE_PERSONAL_SKILL_INDEX_PATH: indexPath,
        CAT_CAFE_PERSONAL_SKILL_ROOTS: dirname(indexPath),
        CAT_CAFE_PERSONAL_SKILL_VISIBLE_NAMES: 'create-prd',
      },
      async () => {
        const { resolveSkillRouterContext } = await importSkillRouter('personal-cache');

        const first = resolveSkillRouterContext('帮我写 PRD');
        assert.ok(first);
        assert.ok(first.matchedSkillNames.includes('create-prd'));

        writePersonalIndex(indexPath, [{ name: 'review', triggers: ['review'], visible: true }]);
        const second = resolveSkillRouterContext('帮我写 PRD');
        assert.ok(second);
        assert.equal(second.matchedSkillNames.includes('create-prd'), false);

        const third = resolveSkillRouterContext('帮我 review');
        assert.ok(third);
        assert.ok(third.matchedSkillNames.includes('review'));

        process.env.CAT_CAFE_PERSONAL_SKILLS_ENABLED = '0';
        const disabled = resolveSkillRouterContext('帮我 review');
        assert.ok(disabled);
        assert.equal(disabled.matchedSkillNames.includes('review'), false);
      },
    );
    rmSync(workDir, { recursive: true, force: true });
  });
});
