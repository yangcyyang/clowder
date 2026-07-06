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

describe('skill tools', () => {
  test('cat_cafe_read_skill falls back to repo manifest for project-workflow', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mcp-skill-tools-'));
    const manifestPath = join(workDir, 'skills-manifest.json');
    writeFileSync(manifestPath, JSON.stringify({ skills: [] }, null, 2));
    process.env.CAT_CAFE_SKILL_MANIFEST_PATH = manifestPath;

    const moduleUrl = new URL(`../dist/tools/skill-tools.js?case=${Date.now()}`, import.meta.url);
    const { handleReadSkill } = await import(moduleUrl.href);

    const result = await handleReadSkill({ name: 'project-workflow' });
    const text = result.content[0]?.text ?? '';
    assert.match(text, /### SKILL: project-workflow/);
    assert.match(text, /项目工作流接手员/);
    assert.match(text, /docs\/project-context-contract\.md/);
  });

  test('cat_cafe_list_skills shows visible personal skills by default and hidden skills by query', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'mcp-personal-project-'));
    const personalRoot = mkdtempSync(join(tmpdir(), 'mcp-personal-root-'));
    const manifestPath = join(projectRoot, 'skills-manifest.json');
    const indexPath = join(projectRoot, '.cat-cafe', 'personal-skills-index.json');
    writeFileSync(manifestPath, JSON.stringify({ skills: [] }, null, 2));
    const visiblePath = writePersonalSkill(
      personalRoot,
      'create-prd',
      'name: create-prd\ndescription: Create PRD\ntriggers:\n  - PRD',
      'VISIBLE PERSONAL BODY',
    );
    const hiddenPath = writePersonalSkill(
      personalRoot,
      'hidden-route',
      'name: hidden-route\ndescription: Hidden route\ntriggers:\n  - hidden-intent-token',
      'HIDDEN PERSONAL BODY',
    );
    writePersonalIndex(indexPath, [
      { name: 'create-prd', description: 'Create PRD', triggers: ['PRD'], sourcePath: visiblePath, visible: true },
      {
        name: 'hidden-route',
        description: 'Hidden route',
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
          const moduleUrl = new URL(`../dist/tools/skill-tools.js?case=personal-list-${Date.now()}`, import.meta.url);
          const { handleListSkills, handleReadSkill } = await import(moduleUrl.href);

          const defaultText = (await handleListSkills({})).content[0]?.text ?? '';
          assert.match(defaultText, /create-prd/);
          assert.doesNotMatch(defaultText, /hidden-route/);

          const queryText = (await handleListSkills({ query: 'hidden-intent-token' })).content[0]?.text ?? '';
          assert.match(queryText, /hidden-route/);

          const readText = (await handleReadSkill({ name: 'create-prd' })).content[0]?.text ?? '';
          assert.match(readText, /### SKILL: create-prd/);
          assert.match(readText, /VISIBLE PERSONAL BODY/);
        },
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(personalRoot, { recursive: true, force: true });
    }
  });

  test('cat_cafe_read_skill refuses personal skill paths outside configured roots', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'mcp-personal-guard-project-'));
    const personalRoot = mkdtempSync(join(tmpdir(), 'mcp-personal-guard-root-'));
    const outsideRoot = mkdtempSync(join(tmpdir(), 'mcp-personal-outside-'));
    const manifestPath = join(projectRoot, 'skills-manifest.json');
    const indexPath = join(projectRoot, '.cat-cafe', 'personal-skills-index.json');
    writeFileSync(manifestPath, JSON.stringify({ skills: [] }, null, 2));
    const outsidePath = writePersonalSkill(
      outsideRoot,
      'outside-skill',
      'name: outside-skill\ndescription: Outside skill',
      'OUTSIDE PERSONAL BODY',
    );
    writePersonalIndex(indexPath, [
      {
        name: 'outside-skill',
        description: 'Outside skill',
        triggers: ['outside-skill'],
        sourcePath: outsidePath,
        visible: true,
      },
    ]);

    try {
      await withPersonalSkillEnv(
        {
          CAT_CAFE_PERSONAL_SKILLS_ENABLED: '1',
          CAT_CAFE_PERSONAL_SKILL_ROOTS: personalRoot,
          CAT_CAFE_PERSONAL_SKILL_VISIBLE_NAMES: 'outside-skill',
          CAT_CAFE_PERSONAL_SKILL_INDEX_PATH: indexPath,
        },
        async () => {
          process.env.CAT_CAFE_SKILL_MANIFEST_PATH = manifestPath;
          const moduleUrl = new URL(`../dist/tools/skill-tools.js?case=personal-guard-${Date.now()}`, import.meta.url);
          const { handleReadSkill } = await import(moduleUrl.href);

          const text = (await handleReadSkill({ name: 'outside-skill' })).content[0]?.text ?? '';
          assert.match(text, /outside configured personal skill roots|找不到 skill/);
          assert.doesNotMatch(text, /OUTSIDE PERSONAL BODY/);
        },
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(personalRoot, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });
});
