import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getMethodologyTemplates } from '../../dist/config/governance/methodology-templates.js';

describe('methodology-templates', () => {
  it('returns all required template files', () => {
    const templates = getMethodologyTemplates();
    const paths = templates.map((t) => t.relativePath);
    assert.ok(paths.includes('BACKLOG.md'));
    assert.ok(paths.includes('docs/SOP.md'));
    assert.ok(paths.includes('docs/features/.gitkeep'));
    assert.ok(paths.includes('docs/decisions/.gitkeep'));
    assert.ok(paths.includes('docs/discussions/.gitkeep'));
    assert.ok(paths.includes('docs/features/TEMPLATE.md'));
    assert.ok(paths.includes('.cat-cafe/memory/_TEMPLATE.md'));
    assert.ok(paths.includes('.cat-cafe/LESSONS.md'));
    assert.ok(paths.includes('.cat-cafe/projects/_TEMPLATE-progress.md'));
    assert.ok(paths.includes('.cat-cafe/context-index.md'));
    assert.ok(paths.includes('.cat-cafe/handoff/current.md'));
    assert.ok(paths.includes('.cat-cafe/handoff/.gitkeep'));
  });

  it('BACKLOG template has frontmatter', () => {
    const templates = getMethodologyTemplates();
    const backlog = templates.find((t) => t.relativePath === 'BACKLOG.md');
    assert.ok(backlog);
    assert.ok(backlog.content.includes('---'));
    assert.ok(backlog.content.includes('doc_kind:'));
  });

  it('SOP template has workflow table', () => {
    const templates = getMethodologyTemplates();
    const sop = templates.find((t) => t.relativePath === 'docs/SOP.md');
    assert.ok(sop);
    assert.ok(sop.content.includes('worktree'));
    assert.ok(sop.content.includes('quality-gate'));
  });

  it('Feature template has standard sections', () => {
    const templates = getMethodologyTemplates();
    const feat = templates.find((t) => t.relativePath === 'docs/features/TEMPLATE.md');
    assert.ok(feat);
    assert.ok(feat.content.includes('## Why'));
    assert.ok(feat.content.includes('## Acceptance Criteria'));
  });

  it('runtime continuity templates cover memory, lessons, progress, context, and handoff', () => {
    const templates = getMethodologyTemplates();
    const byPath = new Map(templates.map((t) => [t.relativePath, t.content]));

    assert.match(byPath.get('.cat-cafe/memory/_TEMPLATE.md'), /## 当前状态/);
    assert.match(byPath.get('.cat-cafe/memory/_TEMPLATE.md'), /## 已关闭决策/);
    assert.match(byPath.get('.cat-cafe/LESSONS.md'), /公共踩坑记录/);
    assert.match(byPath.get('.cat-cafe/projects/_TEMPLATE-progress.md'), /## 关键决策/);
    assert.match(byPath.get('.cat-cafe/context-index.md'), /## 默认跳过/);
    assert.match(byPath.get('.cat-cafe/handoff/current.md'), /## 交接内容/);
  });

  it('templates have today date filled in', () => {
    const templates = getMethodologyTemplates();
    const today = new Date().toISOString().slice(0, 10);
    const backlog = templates.find((t) => t.relativePath === 'BACKLOG.md');
    assert.ok(backlog);
    assert.ok(backlog.content.includes(today));
  });

  it('non-gitkeep templates have content', () => {
    const templates = getMethodologyTemplates();
    for (const t of templates) {
      if (!t.relativePath.endsWith('.gitkeep')) {
        assert.ok(t.content.length > 10, `${t.relativePath} should have content`);
      }
    }
  });
});
