/**
 * Skills route tests
 * GET /api/skills — Clowder AI 共享 Skills 看板数据
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { writeCapabilitiesConfig } from '../dist/config/capabilities/capability-orchestrator.js';
import { skillsRoutes } from '../dist/routes/skills.js';

const AUTH_HEADERS = { 'x-cat-cafe-user': 'test-user' };
const PERSONAL_ENV_KEYS = [
  'CAT_CAFE_PERSONAL_SKILLS_ENABLED',
  'CAT_CAFE_PERSONAL_SKILL_ROOTS',
  'CAT_CAFE_PERSONAL_SKILL_VISIBLE_NAMES',
  'CAT_CAFE_PERSONAL_SKILL_INDEX_PATH',
];

async function withPersonalSkillEnv(overrides, fn) {
  const previous = new Map(PERSONAL_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
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

async function writeSkill(path, frontmatter, body = '# Skill Body\n') {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'SKILL.md'), `---\n${frontmatter.trim()}\n---\n\n${body}`, 'utf-8');
}

async function writePersonalIndex(indexPath, skills) {
  await mkdir(dirname(indexPath), { recursive: true });
  await writeFile(
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
          sourcePath: skill.sourcePath ?? join(dirname(indexPath), `${skill.name}.md`),
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

function resolveMainRepoForTest() {
  return execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
    .split('\n')[0]
    .replace(/^worktree\s+/, '')
    .trim();
}

describe('Skills Route', () => {
  it('returns 401 when no identity header is provided', async () => {
    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/skills',
    });

    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('Identity required'));

    await app.close();
  });

  it('GET /api/skills returns skills array and summary', async () => {
    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/skills',
      headers: AUTH_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);

    // Response structure
    assert.ok(Array.isArray(body.skills), 'skills should be an array');
    assert.ok(body.summary, 'should have summary');
    assert.equal(typeof body.summary.total, 'number');
    assert.equal(typeof body.summary.allMounted, 'boolean');
    assert.equal(typeof body.summary.registrationConsistent, 'boolean');

    await app.close();
  });

  it('POST /api/skills/personal/rebuild returns 401 without identity', async () => {
    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/skills/personal/rebuild',
    });

    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('Identity required'));

    await app.close();
  });

  it('POST /api/skills/personal/rebuild returns disabled without writing an index', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'skills-route-personal-disabled-'));
    const indexPath = join(projectDir, '.cat-cafe', 'personal-skills-index.json');
    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    try {
      await withPersonalSkillEnv(
        {
          CAT_CAFE_PERSONAL_SKILLS_ENABLED: '0',
          CAT_CAFE_PERSONAL_SKILL_INDEX_PATH: '.cat-cafe/personal-skills-index.json',
        },
        async () => {
          const res = await app.inject({
            method: 'POST',
            url: '/api/skills/personal/rebuild',
            headers: AUTH_HEADERS,
            payload: { projectPath: projectDir },
          });

          assert.equal(res.statusCode, 200);
          assert.deepEqual(JSON.parse(res.body), {
            enabled: false,
            total: 0,
            visible: 0,
            duplicates: 0,
            ignored: 0,
            indexPath: '.cat-cafe/personal-skills-index.json',
          });
          await assert.rejects(readFile(indexPath, 'utf-8'), /ENOENT/);
        },
      );
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('POST /api/skills/personal/rebuild writes the configured personal skill index', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'skills-route-personal-project-'));
    const personalRoot = await mkdtemp(join(tmpdir(), 'skills-route-personal-root-'));
    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    try {
      await writeSkill(
        join(personalRoot, 'create-prd'),
        `
name: create-prd
description: Create a PRD from product context
triggers:
  - PRD
`,
      );

      await withPersonalSkillEnv(
        {
          CAT_CAFE_PERSONAL_SKILLS_ENABLED: '1',
          CAT_CAFE_PERSONAL_SKILL_ROOTS: personalRoot,
          CAT_CAFE_PERSONAL_SKILL_VISIBLE_NAMES: 'create-prd',
          CAT_CAFE_PERSONAL_SKILL_INDEX_PATH: '.cat-cafe/personal-skills-index.json',
        },
        async () => {
          const res = await app.inject({
            method: 'POST',
            url: '/api/skills/personal/rebuild',
            headers: AUTH_HEADERS,
            payload: { projectPath: projectDir },
          });

          assert.equal(res.statusCode, 200);
          assert.deepEqual(JSON.parse(res.body), {
            enabled: true,
            total: 1,
            visible: 1,
            duplicates: 0,
            ignored: 0,
            indexPath: '.cat-cafe/personal-skills-index.json',
          });

          const raw = await readFile(join(projectDir, '.cat-cafe', 'personal-skills-index.json'), 'utf-8');
          const index = JSON.parse(raw);
          assert.equal(index.skills[0].name, 'create-prd');
          assert.equal(index.skills[0].visible, true);
        },
      );
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      await rm(personalRoot, { recursive: true, force: true });
    }
  });

  it('POST /api/skills/personal/rebuild rejects invalid projectPath', async () => {
    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/skills/personal/rebuild',
        headers: AUTH_HEADERS,
        payload: { projectPath: join(tmpdir(), `missing-project-${Date.now()}`) },
      });

      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('Invalid project path'));
    } finally {
      await app.close();
    }
  });

  it('GET /api/skills exposes indexed personal skills without requiring provider mounts', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'skills-route-personal-board-'));
    const personalRoot = await mkdtemp(join(tmpdir(), 'skills-route-personal-board-root-'));
    const indexPath = join(projectDir, '.cat-cafe', 'personal-skills-index.json');
    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    try {
      await writePersonalIndex(indexPath, [
        {
          name: 'create-prd',
          description: 'Create a PRD from product context',
          triggers: ['PRD'],
          category: 'product',
          visible: true,
        },
        {
          name: 'opencli-usage',
          description: 'OpenCLI usage notes',
          triggers: ['opencli'],
          category: 'tooling',
          visible: false,
        },
      ]);

      await withPersonalSkillEnv(
        {
          CAT_CAFE_PERSONAL_SKILLS_ENABLED: '1',
          CAT_CAFE_PERSONAL_SKILL_ROOTS: personalRoot,
          CAT_CAFE_PERSONAL_SKILL_VISIBLE_NAMES: 'create-prd',
          CAT_CAFE_PERSONAL_SKILL_INDEX_PATH: '.cat-cafe/personal-skills-index.json',
        },
        async () => {
          const res = await app.inject({
            method: 'GET',
            url: `/api/skills?projectPath=${encodeURIComponent(projectDir)}`,
            headers: AUTH_HEADERS,
          });

          assert.equal(res.statusCode, 200);
          const body = JSON.parse(res.body);
          const createPrd = body.skills.find((skill) => skill.name === 'create-prd');
          const opencliUsage = body.skills.find((skill) => skill.name === 'opencli-usage');

          assert.ok(createPrd, 'visible personal skill should be listed');
          assert.ok(opencliUsage, 'hidden personal skill should still be listed in the skills dashboard');
          assert.equal(createPrd.source, 'personal');
          assert.equal(opencliUsage.source, 'personal');
          assert.equal(createPrd.visible, true);
          assert.equal(opencliUsage.visible, false);
          assert.deepEqual(createPrd.mounts, { claude: false, codex: false, gemini: false, kimi: false });
          assert.deepEqual(opencliUsage.mounts, { claude: false, codex: false, gemini: false, kimi: false });
          assert.equal(body.summary.personalTotal, 2);
          assert.equal(body.summary.personalVisible, 1);
          assert.equal(body.summary.personalHidden, 1);
          assert.equal(typeof body.summary.registrationConsistent, 'boolean');
        },
      );
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      await rm(personalRoot, { recursive: true, force: true });
    }
  });

  it('each skill entry has required fields', async () => {
    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/skills',
      headers: AUTH_HEADERS,
    });

    const body = JSON.parse(res.body);
    if (body.skills.length === 0) {
      // No skills found (possible in CI), skip field checks
      await app.close();
      return;
    }

    for (const skill of body.skills) {
      assert.equal(typeof skill.name, 'string', 'name should be string');
      assert.equal(typeof skill.category, 'string', 'category should be string');
      assert.equal(typeof skill.trigger, 'string', 'trigger should be string');
      assert.ok(skill.mounts, 'should have mounts');
      assert.equal(typeof skill.mounts.claude, 'boolean');
      assert.equal(typeof skill.mounts.codex, 'boolean');
      assert.equal(typeof skill.mounts.gemini, 'boolean');
      assert.equal(typeof skill.mounts.kimi, 'boolean');
    }

    await app.close();
  });

  it('skills follow BOOTSTRAP ordering (registered before unregistered)', async () => {
    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/skills',
      headers: AUTH_HEADERS,
    });

    const body = JSON.parse(res.body);
    if (body.skills.length === 0) {
      await app.close();
      return;
    }

    // Skills with a category (from BOOTSTRAP) should come before '未分类'
    let seenUnregistered = false;
    for (const skill of body.skills) {
      if (skill.category === '未分类') {
        seenUnregistered = true;
      } else if (seenUnregistered) {
        assert.fail(`Registered skill "${skill.name}" appeared after unregistered skill — ordering violated`);
      }
    }

    await app.close();
  });

  it('summary.total matches skills array length', async () => {
    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/skills',
      headers: AUTH_HEADERS,
    });

    const body = JSON.parse(res.body);
    assert.equal(body.summary.total, body.skills.length);

    await app.close();
  });

  it('treats directory-level project skills symlinks as mounted for all providers', async () => {
    const projectDir = join('/tmp', `skills-route-test-dir-symlink-${Date.now()}`);
    const homeDir = join('/tmp', `skills-route-test-home-${Date.now()}`);
    const sourceSkillsDir = join(resolveMainRepoForTest(), 'cat-cafe-skills');
    const prevHome = process.env.HOME;

    await Promise.all([
      mkdir(join(projectDir, '.claude'), { recursive: true }),
      mkdir(join(projectDir, '.codex'), { recursive: true }),
      mkdir(join(projectDir, '.gemini'), { recursive: true }),
      mkdir(join(projectDir, '.kimi'), { recursive: true }),
      mkdir(homeDir, { recursive: true }),
    ]);
    await Promise.all([
      symlink(sourceSkillsDir, join(projectDir, '.claude', 'skills')),
      symlink(sourceSkillsDir, join(projectDir, '.codex', 'skills')),
      symlink(sourceSkillsDir, join(projectDir, '.gemini', 'skills')),
      symlink(sourceSkillsDir, join(projectDir, '.kimi', 'skills')),
    ]);

    process.env.HOME = homeDir;

    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/skills?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.summary.allMounted, true, 'project-level directory symlinks should count as mounted');

      const debugging = body.skills.find((skill) => skill.name === 'debugging');
      assert.ok(debugging, 'debugging skill should be present');
      assert.deepEqual(debugging.mounts, { claude: true, codex: true, gemini: true, kimi: true });
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('accepts HOME-level fallback symlinks that still point to the main repo skills tree', async () => {
    const projectDir = join('/tmp', `skills-route-test-fallback-project-${Date.now()}`);
    const homeDir = join('/tmp', `skills-route-test-fallback-home-${Date.now()}`);
    const prevHome = process.env.HOME;
    const mainRepo = resolveMainRepoForTest();
    const mainSkillsDir = join(mainRepo, 'cat-cafe-skills');

    await Promise.all([
      mkdir(projectDir, { recursive: true }),
      mkdir(join(homeDir, '.claude'), { recursive: true }),
      mkdir(join(homeDir, '.codex'), { recursive: true }),
      mkdir(join(homeDir, '.gemini'), { recursive: true }),
      mkdir(join(homeDir, '.kimi'), { recursive: true }),
    ]);
    await Promise.all([
      symlink(mainSkillsDir, join(homeDir, '.claude', 'skills')),
      symlink(mainSkillsDir, join(homeDir, '.codex', 'skills')),
      symlink(mainSkillsDir, join(homeDir, '.gemini', 'skills')),
      symlink(mainSkillsDir, join(homeDir, '.kimi', 'skills')),
    ]);

    process.env.HOME = homeDir;

    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/skills?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.summary.allMounted, true, 'main-repo fallback skills symlink should still count as mounted');
      const debugging = body.skills.find((skill) => skill.name === 'debugging');
      assert.ok(debugging, 'debugging skill should be present');
      assert.deepEqual(debugging.mounts, { claude: true, codex: true, gemini: true, kimi: true });
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('resolves required MCP status from the selected project capabilities config', async () => {
    const projectDir = join('/tmp', `skills-route-test-project-mcp-${Date.now()}`);
    await mkdir(projectDir, { recursive: true });
    await writeCapabilitiesConfig(projectDir, {
      version: 1,
      capabilities: [
        {
          id: 'pencil',
          type: 'mcp',
          enabled: false,
          source: 'external',
          mcpServer: { resolver: 'pencil', command: '', args: [] },
        },
      ],
    });

    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/skills?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      const pencilDesign = body.skills.find((skill) => skill.name === 'pencil-design');
      assert.ok(pencilDesign, 'pencil-design should be present');
      assert.deepEqual(pencilDesign.requiresMcp, [
        {
          id: 'pencil',
          status: 'missing',
        },
      ]);
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('exposes required MCP dependency status for routed skills', async () => {
    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/skills',
      headers: AUTH_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const browserAutomation = body.skills.find((skill) => skill.name === 'browser-automation');
    const pencilDesign = body.skills.find((skill) => skill.name === 'pencil-design');

    assert.ok(browserAutomation, 'browser-automation should be present in skills board');
    assert.ok(pencilDesign, 'pencil-design should be present in skills board');
    assert.deepEqual(
      browserAutomation.requiresMcp?.map((dep) => dep.id),
      ['playwright', 'claude-in-chrome', 'agent-browser', 'pinchtab'],
      'browser-automation should declare all browser backend dependencies',
    );
    assert.deepEqual(
      pencilDesign.requiresMcp?.map((dep) => dep.id),
      ['pencil'],
      'pencil-design should declare pencil dependency',
    );

    for (const dep of [...browserAutomation.requiresMcp, ...pencilDesign.requiresMcp]) {
      assert.match(dep.status, /^(ready|missing|unresolved)$/);
    }

    await app.close();
  });
});
