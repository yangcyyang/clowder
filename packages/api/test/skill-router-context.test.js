import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

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
});
