/**
 * F-I: "沉淀为知识" modal's 4th type card ("知识库") — vault-inbox target.
 *
 * Writes are only ever allowed under `<vault root>/00待确认/clowder-inbox/`.
 * All fixtures here are temp directories standing in for a vault — the real
 * Obsidian vault (OBSIDIAN_READONLY_ROOTS) is never touched by these tests.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

function createVaultFixture() {
  const vaultRoot = mkdtempSync(join(tmpdir(), 'cc-vault-'));
  // Pre-existing note elsewhere in the vault, to prove we never touch it.
  mkdirSync(join(vaultRoot, '10note域'), { recursive: true });
  const untouchedPath = join(vaultRoot, '10note域', 'existing.md');
  const untouchedContent = '# do not touch me\n';
  writeFileSync(untouchedPath, untouchedContent, 'utf8');
  return { vaultRoot, untouchedPath, untouchedContent };
}

describe('createKnowledgeDoc — type "vault" (F-I inbox capture)', () => {
  test('writes a frontmatter note into 00待确认/clowder-inbox/ with source metadata', async () => {
    const { createKnowledgeDoc } = await import('../dist/routes/knowledge.js');
    const { vaultRoot } = createVaultFixture();
    try {
      const rootsEnv = `domain:test-vault=${vaultRoot}`;
      const result = await createKnowledgeDoc(
        {
          type: 'vault',
          title: '频道精华：会话轮转设计',
          summary: '讨论里定下的会话轮转触发阈值和蒸馏策略。',
          sourceThreadId: 'thread_xyz',
          sourceThreadTitle: '#记忆升级讨论',
          sourceUrl: 'http://localhost:3003/thread/thread_xyz?highlight=msg_1',
        },
        undefined,
        rootsEnv,
      );

      assert.match(result.path, /^00待确认[\\/]clowder-inbox[\\/].*\.md$/);
      const absPath = join(vaultRoot, result.path);
      assert.equal(existsSync(absPath), true);

      const content = readFileSync(absPath, 'utf8');
      assert.match(content, /^---\n/);
      assert.match(content, /created: \d{4}-\d{2}-\d{2}/);
      assert.match(content, /source_thread: "thread:thread_xyz"/);
      assert.match(content, /source_url: "http:\/\/localhost:3003\/thread\/thread_xyz\?highlight=msg_1"/);
      assert.match(content, /topics: \[clowder-inbox\]/);
      assert.match(content, /status: inbox/);
      assert.match(content, /# 频道精华：会话轮转设计/);
      assert.match(content, /讨论里定下的会话轮转触发阈值和蒸馏策略。/);
      assert.match(content, /## 来源/);
      assert.match(content, /- 频道：#记忆升级讨论/);
      assert.match(content, /- 链接：http:\/\/localhost:3003\/thread\/thread_xyz\?highlight=msg_1/);
    } finally {
      rmSync(vaultRoot, { recursive: true, force: true });
    }
  });

  test('never touches any other path in the vault (only writes under the inbox folder)', async () => {
    const { createKnowledgeDoc } = await import('../dist/routes/knowledge.js');
    const { vaultRoot, untouchedPath, untouchedContent } = createVaultFixture();
    try {
      const rootsEnv = `domain:test-vault=${vaultRoot}`;
      await createKnowledgeDoc(
        { type: 'vault', title: '不许碰别的笔记', summary: '只能写收件夹。' },
        undefined,
        rootsEnv,
      );

      assert.equal(readFileSync(untouchedPath, 'utf8'), untouchedContent, 'pre-existing vault note must be untouched');
      // Nothing should have been written directly at the vault root either.
      const rootEntries = readdirSync(vaultRoot);
      assert.deepEqual(rootEntries.sort(), ['00待确认', '10note域']);
    } finally {
      rmSync(vaultRoot, { recursive: true, force: true });
    }
  });

  test('filename collisions never overwrite — bumps a numeric suffix', async () => {
    const { createKnowledgeDoc } = await import('../dist/routes/knowledge.js');
    const { vaultRoot } = createVaultFixture();
    try {
      const rootsEnv = `domain:test-vault=${vaultRoot}`;
      const input = { type: 'vault', title: '重复标题测试', summary: '第一次沉淀。' };

      const first = await createKnowledgeDoc(input, undefined, rootsEnv);
      const second = await createKnowledgeDoc({ ...input, summary: '第二次沉淀，标题相同。' }, undefined, rootsEnv);
      const third = await createKnowledgeDoc({ ...input, summary: '第三次沉淀，标题还是相同。' }, undefined, rootsEnv);

      assert.notEqual(first.path, second.path);
      assert.notEqual(second.path, third.path);
      assert.match(second.path, /-2\.md$/);
      assert.match(third.path, /-3\.md$/);

      // The first file's content must be untouched by the later writes.
      const firstContent = readFileSync(join(vaultRoot, first.path), 'utf8');
      assert.match(firstContent, /第一次沉淀。/);
      assert.doesNotMatch(firstContent, /第二次沉淀/);
    } finally {
      rmSync(vaultRoot, { recursive: true, force: true });
    }
  });

  test('rejects when OBSIDIAN_READONLY_ROOTS-equivalent is unset (VaultUnavailableError)', async () => {
    const { createKnowledgeDoc, VaultUnavailableError } = await import('../dist/routes/knowledge.js');
    await assert.rejects(
      () => createKnowledgeDoc({ type: 'vault', title: 'x', summary: 'y' }, undefined, undefined),
      VaultUnavailableError,
    );
  });

  test('rejects when the configured root does not exist on disk', async () => {
    const { createKnowledgeDoc, VaultUnavailableError } = await import('../dist/routes/knowledge.js');
    await assert.rejects(
      () =>
        createKnowledgeDoc(
          { type: 'vault', title: 'x', summary: 'y' },
          undefined,
          'domain:ghost=/definitely/does/not/exist/anywhere',
        ),
      VaultUnavailableError,
    );
  });
});

describe('getVaultInboxStatus (F-I availability flag for the modal)', () => {
  test('reports unavailable with a reason when env is unset', async () => {
    const { getVaultInboxStatus } = await import('../dist/routes/knowledge.js');
    const status = getVaultInboxStatus(undefined);
    assert.equal(status.available, false);
    assert.match(status.reason, /OBSIDIAN_READONLY_ROOTS/);
  });

  test('reports unavailable when the configured directory does not exist', async () => {
    const { getVaultInboxStatus } = await import('../dist/routes/knowledge.js');
    const status = getVaultInboxStatus('domain:ghost=/definitely/does/not/exist/anywhere');
    assert.equal(status.available, false);
  });

  test('reports available when a usable collection resolves', async () => {
    const { getVaultInboxStatus } = await import('../dist/routes/knowledge.js');
    const vaultRoot = mkdtempSync(join(tmpdir(), 'cc-vault-status-'));
    try {
      const status = getVaultInboxStatus(`domain:test-vault=${vaultRoot}`);
      assert.equal(status.available, true);
      assert.equal(status.reason, undefined);
    } finally {
      rmSync(vaultRoot, { recursive: true, force: true });
    }
  });
});

describe('isPathWithinDir (F-I path-escape guard, unit-tested directly)', () => {
  test('a direct child path is within the directory', async () => {
    const { isPathWithinDir } = await import('../dist/routes/knowledge.js');
    assert.equal(isPathWithinDir('/a/b', '/a/b/c.md'), true);
  });

  test('the directory itself counts as within', async () => {
    const { isPathWithinDir } = await import('../dist/routes/knowledge.js');
    assert.equal(isPathWithinDir('/a/b', '/a/b'), true);
  });

  test('a sibling path is rejected', async () => {
    const { isPathWithinDir } = await import('../dist/routes/knowledge.js');
    assert.equal(isPathWithinDir('/a/b', '/a/bother/c.md'), false);
  });

  test('a ../ escape resolves outside and is rejected', async () => {
    const { isPathWithinDir } = await import('../dist/routes/knowledge.js');
    assert.equal(isPathWithinDir('/a/b', '/a/b/../../etc/passwd'), false);
  });
});

describe('HTTP layer: POST /api/knowledge + GET /api/knowledge/vault-status', () => {
  // These routes read process.env.OBSIDIAN_READONLY_ROOTS via createKnowledgeDoc's
  // default parameter, so we save/restore the real value around each test —
  // never leaving the process env mutated, and never pointing at the real vault.
  const ORIGINAL_ROOTS = process.env.OBSIDIAN_READONLY_ROOTS;

  async function createApp() {
    const Fastify = (await import('fastify')).default;
    const { knowledgeRoutes } = await import('../dist/routes/knowledge.js');
    const app = Fastify();
    await app.register(knowledgeRoutes);
    return app;
  }

  test('GET vault-status reflects env: unavailable when unset, available when a fixture root resolves', async () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), 'cc-vault-http-'));
    try {
      delete process.env.OBSIDIAN_READONLY_ROOTS;
      let app = await createApp();
      let res = await app.inject({ method: 'GET', url: '/api/knowledge/vault-status' });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().available, false);
      await app.close();

      process.env.OBSIDIAN_READONLY_ROOTS = `domain:test-vault=${vaultRoot}`;
      app = await createApp();
      res = await app.inject({ method: 'GET', url: '/api/knowledge/vault-status' });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().available, true);
      await app.close();
    } finally {
      rmSync(vaultRoot, { recursive: true, force: true });
      if (ORIGINAL_ROOTS === undefined) delete process.env.OBSIDIAN_READONLY_ROOTS;
      else process.env.OBSIDIAN_READONLY_ROOTS = ORIGINAL_ROOTS;
    }
  });

  test('POST type=vault returns 409 with a clear message when the fixture root is unset', async () => {
    try {
      delete process.env.OBSIDIAN_READONLY_ROOTS;
      const app = await createApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/knowledge',
        payload: { type: 'vault', title: '未配置时的沉淀', summary: '应当被拒绝。' },
      });
      assert.equal(res.statusCode, 409);
      assert.match(res.json().error, /OBSIDIAN_READONLY_ROOTS/);
      await app.close();
    } finally {
      if (ORIGINAL_ROOTS === undefined) delete process.env.OBSIDIAN_READONLY_ROOTS;
      else process.env.OBSIDIAN_READONLY_ROOTS = ORIGINAL_ROOTS;
    }
  });

  test('POST type=vault writes into the fixture inbox and returns 200 with path/id', async () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), 'cc-vault-http-post-'));
    try {
      process.env.OBSIDIAN_READONLY_ROOTS = `domain:test-vault=${vaultRoot}`;
      const app = await createApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/knowledge',
        payload: {
          type: 'vault',
          title: 'HTTP 层沉淀测试',
          summary: '走完整 Fastify 路由的沉淀请求。',
          sourceThreadId: 'thread_http',
          sourceThreadTitle: '#http测试频道',
          sourceUrl: 'http://localhost:3003/thread/thread_http',
        },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.type, 'vault');
      assert.match(body.path, /^00待确认[\\/]clowder-inbox[\\/].*\.md$/);
      assert.equal(existsSync(join(vaultRoot, body.path)), true);
      await app.close();
    } finally {
      rmSync(vaultRoot, { recursive: true, force: true });
      if (ORIGINAL_ROOTS === undefined) delete process.env.OBSIDIAN_READONLY_ROOTS;
      else process.env.OBSIDIAN_READONLY_ROOTS = ORIGINAL_ROOTS;
    }
  });

  test('POST rejects an unknown extra field (schema stays strict)', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      payload: { type: 'vault', title: 'x', summary: 'y', notAField: 'nope' },
    });
    assert.equal(res.statusCode, 400);
    await app.close();
  });
});
