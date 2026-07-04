import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';

const SKILL_TOOL_ENV_KEYS = [
  'CAT_CAFE_SKILL_MANIFEST_PATH',
  'CAT_CAFE_PERSONAL_SKILLS_ENABLED',
  'CAT_CAFE_PERSONAL_SKILL_INDEX_PATH',
  'CAT_CAFE_PERSONAL_SKILL_ROOTS',
  'CAT_CAFE_PERSONAL_SKILL_VISIBLE_NAMES',
];

async function withSkillToolEnv(overrides, fn) {
  const previous = new Map(SKILL_TOOL_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of SKILL_TOOL_ENV_KEYS) {
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

function importSkillTools(caseName) {
  const moduleUrl = new URL(`../dist/tools/skill-tools.js?case=${caseName}-${Date.now()}`, import.meta.url);
  return import(moduleUrl.href);
}

function writeExternalManifest(workDir) {
  const manifestPath = join(workDir, 'skills-manifest.json');
  writeFileSync(manifestPath, JSON.stringify({ skills: [] }, null, 2));
  return manifestPath;
}

function writeSkill(path, frontmatter, body = '# Skill Body\n') {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'SKILL.md'), `---\n${frontmatter.trim()}\n---\n\n${body}`);
}

function writePersonalIndex(indexPath, roots, skills) {
  mkdirSync(dirname(indexPath), { recursive: true });
  writeFileSync(
    indexPath,
    JSON.stringify(
      {
        version: 1,
        generatedAt: new Date().toISOString(),
        roots,
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
          relativePath: skill.relativePath ?? `${skill.name}/SKILL.md`,
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

function textOf(result) {
  return result.content[0]?.text ?? '';
}

describe('skill tools', { concurrency: false }, () => {
  test('cat_cafe_read_skill falls back to repo manifest for project-workflow', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mcp-skill-tools-'));
    const manifestPath = writeExternalManifest(workDir);

    await withSkillToolEnv({ CAT_CAFE_SKILL_MANIFEST_PATH: manifestPath }, async () => {
      const { handleReadSkill } = await importSkillTools('repo');

      const result = await handleReadSkill({ name: 'project-workflow' });
      const text = textOf(result);
      assert.match(text, /### SKILL: project-workflow/);
      assert.match(text, /项目工作流接手员/);
      assert.match(text, /docs\/project-context-contract\.md/);
    });
    rmSync(workDir, { recursive: true, force: true });
  });

  test('cat_cafe_list_skills renders visible personal skills in a separate section', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mcp-skill-tools-list-'));
    const manifestPath = writeExternalManifest(workDir);
    const personalRoot = join(workDir, 'personal');
    const indexPath = join(workDir, '.cat-cafe', 'personal-skills-index.json');
    writeSkill(join(personalRoot, 'create-prd'), 'name: create-prd\ndescription: Create PRD', '# Create PRD\n');
    writeSkill(join(personalRoot, 'opencli-usage'), 'name: opencli-usage\ndescription: OpenCLI hidden', '# Hidden\n');
    writePersonalIndex(
      indexPath,
      [personalRoot],
      [
        {
          name: 'create-prd',
          description: 'Create a PRD',
          triggers: ['PRD'],
          sourcePath: join(personalRoot, 'create-prd', 'SKILL.md'),
          visible: true,
        },
        {
          name: 'opencli-usage',
          description: 'OpenCLI hidden workflow',
          triggers: ['opencli'],
          sourcePath: join(personalRoot, 'opencli-usage', 'SKILL.md'),
          visible: false,
        },
      ],
    );

    await withSkillToolEnv(
      {
        CAT_CAFE_SKILL_MANIFEST_PATH: manifestPath,
        CAT_CAFE_PERSONAL_SKILLS_ENABLED: '1',
        CAT_CAFE_PERSONAL_SKILL_INDEX_PATH: indexPath,
        CAT_CAFE_PERSONAL_SKILL_ROOTS: personalRoot,
        CAT_CAFE_PERSONAL_SKILL_VISIBLE_NAMES: 'create-prd',
      },
      async () => {
        const { handleListSkills } = await importSkillTools('list-visible');

        const text = textOf(await handleListSkills({}));
        assert.match(text, /## Personal Skills（visible）/);
        assert.match(text, /create-prd/);
        assert.doesNotMatch(text, /opencli-usage/);
      },
    );
    rmSync(workDir, { recursive: true, force: true });
  });

  test('cat_cafe_list_skills query can find hidden personal skills', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mcp-skill-tools-query-'));
    const manifestPath = writeExternalManifest(workDir);
    const personalRoot = join(workDir, 'personal');
    const indexPath = join(workDir, '.cat-cafe', 'personal-skills-index.json');
    writeSkill(join(personalRoot, 'opencli-usage'), 'name: opencli-usage\ndescription: OpenCLI hidden', '# Hidden\n');
    writePersonalIndex(
      indexPath,
      [personalRoot],
      [
        {
          name: 'opencli-usage',
          description: 'OpenCLI hidden workflow',
          triggers: ['opencli'],
          sourcePath: join(personalRoot, 'opencli-usage', 'SKILL.md'),
          visible: false,
        },
      ],
    );

    await withSkillToolEnv(
      {
        CAT_CAFE_SKILL_MANIFEST_PATH: manifestPath,
        CAT_CAFE_PERSONAL_SKILLS_ENABLED: '1',
        CAT_CAFE_PERSONAL_SKILL_INDEX_PATH: indexPath,
        CAT_CAFE_PERSONAL_SKILL_ROOTS: personalRoot,
        CAT_CAFE_PERSONAL_SKILL_VISIBLE_NAMES: '',
      },
      async () => {
        const { handleListSkills } = await importSkillTools('query-hidden');

        const text = textOf(await handleListSkills({ query: 'opencli' }));
        assert.match(text, /opencli-usage/);
        assert.match(text, /Personal Skills/);
      },
    );
    rmSync(workDir, { recursive: true, force: true });
  });

  test('cat_cafe_read_skill reads personal skills only from registered roots', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mcp-skill-tools-read-'));
    const manifestPath = writeExternalManifest(workDir);
    const personalRoot = join(workDir, 'personal');
    const indexPath = join(workDir, '.cat-cafe', 'personal-skills-index.json');
    writeSkill(join(personalRoot, 'create-prd'), 'name: create-prd\ndescription: Create PRD', '# Personal PRD\n');
    writePersonalIndex(
      indexPath,
      [personalRoot],
      [
        {
          name: 'create-prd',
          description: 'Create a PRD',
          triggers: ['PRD'],
          sourcePath: join(personalRoot, 'create-prd', 'SKILL.md'),
          visible: true,
        },
      ],
    );

    await withSkillToolEnv(
      {
        CAT_CAFE_SKILL_MANIFEST_PATH: manifestPath,
        CAT_CAFE_PERSONAL_SKILLS_ENABLED: '1',
        CAT_CAFE_PERSONAL_SKILL_INDEX_PATH: indexPath,
        CAT_CAFE_PERSONAL_SKILL_ROOTS: personalRoot,
        CAT_CAFE_PERSONAL_SKILL_VISIBLE_NAMES: 'create-prd',
      },
      async () => {
        const { handleReadSkill } = await importSkillTools('read-personal');

        const text = textOf(await handleReadSkill({ name: 'personal:create-prd' }));
        assert.match(text, /### SKILL: create-prd/);
        assert.match(text, /# Personal PRD/);
      },
    );
    rmSync(workDir, { recursive: true, force: true });
  });

  test('cat_cafe_read_skill rejects malicious personal source paths', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mcp-skill-tools-malicious-'));
    const manifestPath = writeExternalManifest(workDir);
    const personalRoot = join(workDir, 'personal');
    const indexPath = join(workDir, '.cat-cafe', 'personal-skills-index.json');
    mkdirSync(personalRoot, { recursive: true });
    writePersonalIndex(
      indexPath,
      [personalRoot],
      [
        {
          name: 'create-prd',
          sourcePath: '/etc/passwd',
          visible: true,
        },
      ],
    );

    await withSkillToolEnv(
      {
        CAT_CAFE_SKILL_MANIFEST_PATH: manifestPath,
        CAT_CAFE_PERSONAL_SKILLS_ENABLED: '1',
        CAT_CAFE_PERSONAL_SKILL_INDEX_PATH: indexPath,
        CAT_CAFE_PERSONAL_SKILL_ROOTS: personalRoot,
        CAT_CAFE_PERSONAL_SKILL_VISIBLE_NAMES: 'create-prd',
      },
      async () => {
        const { handleReadSkill } = await importSkillTools('malicious-personal');

        const text = textOf(await handleReadSkill({ name: 'personal:create-prd' }));
        assert.match(text, /拒绝读取不安全的 personal skill 路径/);
      },
    );
    rmSync(workDir, { recursive: true, force: true });
  });

  test('cat_cafe_read_skill rejects root-internal symlinks that escape the root', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mcp-skill-tools-symlink-'));
    const manifestPath = writeExternalManifest(workDir);
    const personalRoot = join(workDir, 'personal');
    const outsideRoot = join(workDir, 'outside');
    const escapeDir = join(personalRoot, 'escape');
    const indexPath = join(workDir, '.cat-cafe', 'personal-skills-index.json');
    writeSkill(join(outsideRoot, 'escape'), 'name: escape\ndescription: Outside', '# Outside\n');
    mkdirSync(escapeDir, { recursive: true });
    symlinkSync(join(outsideRoot, 'escape', 'SKILL.md'), join(escapeDir, 'SKILL.md'));
    writePersonalIndex(
      indexPath,
      [personalRoot],
      [
        {
          name: 'escape',
          sourcePath: join(escapeDir, 'SKILL.md'),
          visible: true,
        },
      ],
    );

    await withSkillToolEnv(
      {
        CAT_CAFE_SKILL_MANIFEST_PATH: manifestPath,
        CAT_CAFE_PERSONAL_SKILLS_ENABLED: '1',
        CAT_CAFE_PERSONAL_SKILL_INDEX_PATH: indexPath,
        CAT_CAFE_PERSONAL_SKILL_ROOTS: personalRoot,
        CAT_CAFE_PERSONAL_SKILL_VISIBLE_NAMES: 'escape',
      },
      async () => {
        const { handleReadSkill } = await importSkillTools('symlink-personal');

        const text = textOf(await handleReadSkill({ name: 'personal:escape' }));
        assert.match(text, /拒绝读取不安全的 personal skill 路径/);
      },
    );
    rmSync(workDir, { recursive: true, force: true });
  });

  test('personal catalog cache invalidates when index changes or feature toggles', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mcp-skill-tools-cache-'));
    const manifestPath = writeExternalManifest(workDir);
    const personalRoot = join(workDir, 'personal');
    const indexPath = join(workDir, '.cat-cafe', 'personal-skills-index.json');
    writeSkill(join(personalRoot, 'create-prd'), 'name: create-prd', '# PRD\n');
    writeSkill(join(personalRoot, 'cache-only-skill'), 'name: cache-only-skill', '# Cache Only\n');
    writePersonalIndex(
      indexPath,
      [personalRoot],
      [
        {
          name: 'create-prd',
          triggers: ['PRD'],
          sourcePath: join(personalRoot, 'create-prd', 'SKILL.md'),
          visible: true,
        },
      ],
    );

    await withSkillToolEnv(
      {
        CAT_CAFE_SKILL_MANIFEST_PATH: manifestPath,
        CAT_CAFE_PERSONAL_SKILLS_ENABLED: '1',
        CAT_CAFE_PERSONAL_SKILL_INDEX_PATH: indexPath,
        CAT_CAFE_PERSONAL_SKILL_ROOTS: personalRoot,
        CAT_CAFE_PERSONAL_SKILL_VISIBLE_NAMES: 'create-prd',
      },
      async () => {
        const { handleListSkills } = await importSkillTools('cache-personal');

        assert.match(textOf(await handleListSkills({ query: 'create-prd' })), /create-prd/);

        writePersonalIndex(
          indexPath,
          [personalRoot],
          [
            {
              name: 'cache-only-skill',
              triggers: ['cache-only-skill'],
              sourcePath: join(personalRoot, 'cache-only-skill', 'SKILL.md'),
              visible: true,
            },
          ],
        );
        assert.match(textOf(await handleListSkills({ query: 'create-prd' })), /没有匹配 "create-prd" 的 skill/);
        assert.match(textOf(await handleListSkills({ query: 'cache-only-skill' })), /cache-only-skill/);

        process.env.CAT_CAFE_PERSONAL_SKILLS_ENABLED = '0';
        assert.match(
          textOf(await handleListSkills({ query: 'cache-only-skill' })),
          /没有匹配 "cache-only-skill" 的 skill/,
        );
      },
    );
    rmSync(workDir, { recursive: true, force: true });
  });

  test('cat_cafe_read_skill not-found suggestions are bounded', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mcp-skill-tools-suggestions-'));
    const manifestPath = writeExternalManifest(workDir);
    const personalRoot = join(workDir, 'personal');
    const indexPath = join(workDir, '.cat-cafe', 'personal-skills-index.json');
    const skills = Array.from({ length: 60 }, (_, index) => {
      const name = `personal-${String(index).padStart(2, '0')}`;
      writeSkill(join(personalRoot, name), `name: ${name}`, `# ${name}\n`);
      return {
        name,
        sourcePath: join(personalRoot, name, 'SKILL.md'),
        visible: true,
      };
    });
    writePersonalIndex(indexPath, [personalRoot], skills);

    await withSkillToolEnv(
      {
        CAT_CAFE_SKILL_MANIFEST_PATH: manifestPath,
        CAT_CAFE_PERSONAL_SKILLS_ENABLED: '1',
        CAT_CAFE_PERSONAL_SKILL_INDEX_PATH: indexPath,
        CAT_CAFE_PERSONAL_SKILL_ROOTS: personalRoot,
        CAT_CAFE_PERSONAL_SKILL_VISIBLE_NAMES: skills.map((skill) => skill.name).join(','),
      },
      async () => {
        const { handleReadSkill } = await importSkillTools('bounded-suggestions');

        const text = textOf(await handleReadSkill({ name: 'missing' }));
        const suggestions = text
          .replace(/^.*可用 skills:\s*/s, '')
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
        assert.ok(suggestions.length <= 35, `expected at most 35 suggestions, got ${suggestions.length}`);
      },
    );
    rmSync(workDir, { recursive: true, force: true });
  });
});
