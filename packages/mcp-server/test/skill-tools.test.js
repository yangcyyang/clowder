import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

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
});
