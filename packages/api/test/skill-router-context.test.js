import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { dirname } from 'node:path';
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
    const moduleUrl = new URL(`../dist/domains/cats/services/context/SkillRouter.js?case=${Date.now()}`, import.meta.url);
    const { resolveSkillRouterContext } = await import(moduleUrl.href);

    const context = resolveSkillRouterContext('页面报错了，请排查根因并修复');
    assert.ok(context);
    assert.deepEqual(context.matchedSkillNames, ['debugging']);
    assert.equal(context.menuSkillCount, 1);
    assert.match(context.promptBlock, /Skill Router（可用 Skill 菜单）/);
    assert.match(context.promptBlock, /本轮根据用户消息命中 skill: debugging/);
    assert.match(context.promptBlock, /### SKILL: debugging/);
    assert.match(context.promptBlock, /系统化 bug 定位/);
  });
});
