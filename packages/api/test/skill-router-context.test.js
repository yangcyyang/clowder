import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PERSONAL_ENV_KEYS = [
  'CAT_CAFE_PERSONAL_SKILLS_ENABLED',
  'CAT_CAFE_PERSONAL_SKILL_ROOTS',
  'CAT_CAFE_PERSONAL_SKILL_VISIBLE_NAMES',
  'CAT_CAFE_PERSONAL_SKILL_INDEX_PATH',
];

async function withPersonalSkillEnv(overrides, fn) {
  const previous = new Map(PERSONAL_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of PERSONAL_ENV_KEYS) {
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

function writePersonalSkill(root, name, frontmatter, body) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter.trim()}\n---\n\n${body}`, 'utf-8');
  return join(dir, 'SKILL.md');
}

function writePersonalIndex(indexPath, skills) {
  mkdirSync(dirname(indexPath), { recursive: true });
  writeFileSync(
    indexPath,
    JSON.stringify(
      {
        version: 1,
        generatedAt: new Date().toISOString(),
        roots: [],
        ignoredGlobs: [],
        visibleNames: skills.filter((skill) => skill.visible).map((skill) => skill.name),
        skills: skills.map((skill) => ({
          id: `personal:${skill.name}`,
          name: skill.name,
          description: skill.description ?? skill.name,
          triggers: skill.triggers ?? [],
          category: skill.category ?? 'personal',
          source: 'personal',
          sourcePath: skill.sourcePath,
          relativePath: `${skill.name}/SKILL.md`,
          visible: skill.visible ?? true,
          contentHash: `${skill.name}-hash`,
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

describe('SkillRouter', () => {
  test('loads cat-cafe skill menu and matches triggers to SKILL.md', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'skill-router-'));
    const skillPath = resolve(REPO_ROOT, 'cat-cafe-skills/debugging/SKILL.md');
    const manifestPath = join(workDir, 'skills-manifest.json');
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          skills: [
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
          ],
        },
        null,
        2,
      ),
    );

    process.env.CAT_CAFE_SKILL_MANIFEST_PATH = manifestPath;
    const moduleUrl = new URL(
      `../dist/domains/cats/services/context/SkillRouter.js?case=${Date.now()}`,
      import.meta.url,
    );
    const { resolveSkillRouterContext } = await import(moduleUrl.href);

    const context = resolveSkillRouterContext('页面报错了，请排查根因并修复');
    assert.ok(context);
    assert.deepEqual(context.matchedSkillNames, ['debugging']);
    assert.ok(context.menuSkillCount >= 1);
    assert.match(context.promptBlock, /## Skill Router/);
    assert.match(context.promptBlock, /本轮根据用户消息命中 skill: debugging/);
    assert.match(context.promptBlock, /cat_cafe_read_skill/);
  });

  test('falls back to repo manifest for project-workflow when external manifest omits it', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'skill-router-repo-manifest-'));
    const manifestPath = join(workDir, 'skills-manifest.json');
    writeFileSync(manifestPath, JSON.stringify({ skills: [] }, null, 2));

    process.env.CAT_CAFE_SKILL_MANIFEST_PATH = manifestPath;
    const moduleUrl = new URL(
      `../dist/domains/cats/services/context/SkillRouter.js?case=repo-${Date.now()}`,
      import.meta.url,
    );
    const { resolveSkillRouterContext } = await import(moduleUrl.href);

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

  test('matches project-workflow slash aliases without fast lane', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'skill-router-slash-alias-'));
    const manifestPath = join(workDir, 'skills-manifest.json');
    writeFileSync(manifestPath, JSON.stringify({ skills: [] }, null, 2));

    process.env.CAT_CAFE_SKILL_MANIFEST_PATH = manifestPath;
    const moduleUrl = new URL(
      `../dist/domains/cats/services/context/SkillRouter.js?case=slash-${Date.now()}`,
      import.meta.url,
    );
    const { resolveSkillRouterContext } = await import(moduleUrl.href);

    const continueContext = resolveSkillRouterContext('/continue-project clowder');
    assert.ok(continueContext);
    assert.deepEqual(continueContext.matchedSkillNames, ['project-workflow']);

    const statusContext = resolveSkillRouterContext('/project-status clowder');
    assert.ok(statusContext);
    assert.deepEqual(statusContext.matchedSkillNames, ['project-workflow']);
  });

  test('injects reuse gate for matched skills and exploration fallback for new work', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'skill-router-reuse-gate-'));
    const manifestPath = join(workDir, 'skills-manifest.json');
    writeFileSync(manifestPath, JSON.stringify({ skills: [] }, null, 2));

    process.env.CAT_CAFE_SKILL_MANIFEST_PATH = manifestPath;
    const moduleUrl = new URL(
      `../dist/domains/cats/services/context/SkillRouter.js?case=reuse-${Date.now()}`,
      import.meta.url,
    );
    const { resolveSkillRouterContext } = await import(moduleUrl.href);

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

  test('routes visible personal skills by intent without injecting personal SKILL.md content', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'skill-router-personal-project-'));
    const personalRoot = mkdtempSync(join(tmpdir(), 'skill-router-personal-root-'));
    const manifestPath = join(projectRoot, 'skills-manifest.json');
    const indexPath = join(projectRoot, '.cat-cafe', 'personal-skills-index.json');
    writeFileSync(manifestPath, JSON.stringify({ skills: [] }, null, 2));
    const createPrdPath = writePersonalSkill(
      personalRoot,
      'create-prd',
      `
name: create-prd
description: Create a PRD from product context
triggers:
  - PRD
`,
      'SECRET FULL PERSONAL BODY SHOULD NEVER ENTER ROUTER PROMPT',
    );
    const hiddenPath = writePersonalSkill(
      personalRoot,
      'hidden-route',
      `
name: hidden-route
description: Hidden personal route
triggers:
  - hidden-intent-token
`,
      'HIDDEN FULL PERSONAL BODY SHOULD NEVER ENTER ROUTER PROMPT',
    );
    writePersonalIndex(indexPath, [
      {
        name: 'create-prd',
        description: 'Create a PRD from product context',
        triggers: ['PRD'],
        sourcePath: createPrdPath,
        visible: true,
      },
      {
        name: 'hidden-route',
        description: 'Hidden personal route',
        triggers: ['hidden-intent-token'],
        sourcePath: hiddenPath,
        visible: false,
      },
    ]);

    try {
      await withPersonalSkillEnv(
        {
          CAT_CAFE_PERSONAL_SKILLS_ENABLED: '1',
          CAT_CAFE_PERSONAL_SKILL_ROOTS: personalRoot,
          CAT_CAFE_PERSONAL_SKILL_VISIBLE_NAMES: 'create-prd',
          CAT_CAFE_PERSONAL_SKILL_INDEX_PATH: indexPath,
        },
        async () => {
          process.env.CAT_CAFE_SKILL_MANIFEST_PATH = manifestPath;
          const moduleUrl = new URL(
            `../dist/domains/cats/services/context/SkillRouter.js?case=personal-${Date.now()}`,
            import.meta.url,
          );
          const { resolveSkillRouterContext } = await import(moduleUrl.href);

          const visible = resolveSkillRouterContext('帮我写一份 PRD');
          assert.ok(visible);
          assert.deepEqual(visible.matchedSkillNames, ['create-prd']);
          assert.match(visible.promptBlock, /create-prd/);
          assert.doesNotMatch(visible.promptBlock, /SECRET FULL PERSONAL BODY/);
          assert.doesNotMatch(visible.promptBlock, /HIDDEN FULL PERSONAL BODY/);

          const hiddenFuzzy = resolveSkillRouterContext('hidden-intent-token');
          assert.ok(hiddenFuzzy);
          assert.deepEqual(hiddenFuzzy.matchedSkillNames, []);

          const hiddenExplicit = resolveSkillRouterContext('/hidden-route');
          assert.ok(hiddenExplicit);
          assert.deepEqual(hiddenExplicit.matchedSkillNames, ['hidden-route']);
          assert.doesNotMatch(hiddenExplicit.promptBlock, /HIDDEN FULL PERSONAL BODY/);
        },
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(personalRoot, { recursive: true, force: true });
    }
  });

  test('keeps personal skill routing disabled by default', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'skill-router-personal-disabled-'));
    const personalRoot = mkdtempSync(join(tmpdir(), 'skill-router-personal-disabled-root-'));
    const manifestPath = join(projectRoot, 'skills-manifest.json');
    const indexPath = join(projectRoot, '.cat-cafe', 'personal-skills-index.json');
    writeFileSync(manifestPath, JSON.stringify({ skills: [] }, null, 2));
    const createPrdPath = writePersonalSkill(
      personalRoot,
      'create-prd',
      'name: create-prd\ntriggers:\n  - PRD',
      'disabled body',
    );
    writePersonalIndex(indexPath, [
      { name: 'create-prd', description: 'Create PRD', triggers: ['PRD'], sourcePath: createPrdPath, visible: true },
    ]);

    try {
      await withPersonalSkillEnv(
        {
          CAT_CAFE_PERSONAL_SKILL_ROOTS: personalRoot,
          CAT_CAFE_PERSONAL_SKILL_INDEX_PATH: indexPath,
        },
        async () => {
          process.env.CAT_CAFE_SKILL_MANIFEST_PATH = manifestPath;
          const moduleUrl = new URL(
            `../dist/domains/cats/services/context/SkillRouter.js?case=personal-disabled-${Date.now()}`,
            import.meta.url,
          );
          const { resolveSkillRouterContext } = await import(moduleUrl.href);
          const context = resolveSkillRouterContext('帮我写 PRD');
          assert.ok(context);
          assert.deepEqual(context.matchedSkillNames, []);
        },
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(personalRoot, { recursive: true, force: true });
    }
  });
});
