import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

function createDocsRoot() {
  const root = mkdtempSync(join(tmpdir(), 'cc-knowledge-'));
  mkdirSync(join(root, 'docs', 'features'), { recursive: true });
  mkdirSync(join(root, 'docs', 'decisions'), { recursive: true });
  writeFileSync(join(root, 'docs', 'features', 'F190-existing.md'), '# existing\n');
  writeFileSync(join(root, 'docs', 'decisions', '023-existing.md'), '# existing\n');
  writeFileSync(join(root, 'docs', 'public-lessons.md'), '### LL-057: Existing\n');
  return root;
}

describe('createKnowledgeDoc', () => {
  test('creates the next feature doc with source thread metadata', async () => {
    const { createKnowledgeDoc } = await import('../dist/routes/knowledge.js');
    const root = createDocsRoot();
    try {
      const result = await createKnowledgeDoc(
        {
          type: 'feature',
          title: '沉淀入口',
          summary: '把聊天内容沉淀为 Feature 文档。',
          sourceThreadId: 'thread_abc',
        },
        root,
      );

      assert.equal(result.id, 'F191');
      assert.equal(result.path, 'docs/features/F191-沉淀入口.md');
      const content = readFileSync(join(root, result.path), 'utf8');
      assert.match(content, /feature_ids: \[F191\]/);
      assert.match(content, /source_refs: \["thread:thread_abc"\]/);
      assert.match(content, /把聊天内容沉淀为 Feature 文档。/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('creates the next decision doc', async () => {
    const { createKnowledgeDoc } = await import('../dist/routes/knowledge.js');
    const root = createDocsRoot();
    try {
      const result = await createKnowledgeDoc(
        { type: 'decision', title: '采用手动沉淀', summary: 'MVP 不做 AI 自动总结。' },
        root,
      );

      assert.equal(result.id, 'ADR-024');
      assert.equal(result.path, 'docs/decisions/024-采用手动沉淀.md');
      assert.equal(existsSync(join(root, result.path)), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('appends the next lesson entry', async () => {
    const { createKnowledgeDoc } = await import('../dist/routes/knowledge.js');
    const root = createDocsRoot();
    try {
      const result = await createKnowledgeDoc(
        { type: 'lesson', title: '重复踩坑要入库', summary: '同类事故复现后必须写入 lessons。' },
        root,
      );

      assert.equal(result.id, 'LL-058');
      assert.equal(result.path, 'docs/public-lessons.md');
      const content = readFileSync(join(root, result.path), 'utf8');
      assert.match(content, /### LL-058: 重复踩坑要入库/);
      assert.match(content, /同类事故复现后必须写入 lessons。/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
