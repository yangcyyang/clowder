import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

let tempRoot;

async function setupRoot() {
  tempRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-memory-auto-writer-'));
}

async function cleanupRoot() {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
}

describe('AgentMemoryAutoWriter', () => {
  beforeEach(async () => {
    await setupRoot();
    const mod = await import('../dist/domains/cats/services/agents/memory/AgentMemoryAutoWriter.js');
    mod.resetAgentMemoryAutoWriterForTests();
  });

  afterEach(cleanupRoot);

  it('updates current status and recent validation while preserving protected sections', async () => {
    const { autoUpdateAgentMemory } = await import(
      '../dist/domains/cats/services/agents/memory/AgentMemoryAutoWriter.js'
    );
    const memoryDir = join(tempRoot, '.cat-cafe', 'memory');
    await writeFile(
      join(memoryDir, 'gpt52.md'),
      `# Codex 记忆

## 当前状态

- 最后活跃：2026-06-01
- 正在处理：旧任务
- 上次交付：旧交付

## 已关闭决策（别再提了）

- 不恢复 4 行主消息硬限制。

## 行为偏好（用户纠正过的）

- 回复要自然可读。

## 环境 gotcha

- 3003/3004 是 Clowder 常用端口。
`,
      { encoding: 'utf-8' },
    ).catch(async (err) => {
      if (err?.code !== 'ENOENT') throw err;
      await import('node:fs/promises').then((fs) => fs.mkdir(memoryDir, { recursive: true }));
      await writeFile(
        join(memoryDir, 'gpt52.md'),
        `# Codex 记忆

## 当前状态

- 最后活跃：2026-06-01
- 正在处理：旧任务
- 上次交付：旧交付

## 已关闭决策（别再提了）

- 不恢复 4 行主消息硬限制。

## 行为偏好（用户纠正过的）

- 回复要自然可读。

## 环境 gotcha

- 3003/3004 是 Clowder 常用端口。
`,
        'utf-8',
      );
    });

    const result = await autoUpdateAgentMemory(
      {
        catId: 'gpt52',
        invocationId: 'inv-1',
        threadId: 'thread-1',
        currentUserMessageId: 'msg-1',
        assistantText: '完成 Phase 7 auto-writer 接入，并通过测试。',
        completedAt: Date.UTC(2026, 5, 13),
      },
      { projectRoot: tempRoot, now: () => Date.UTC(2026, 5, 13), minIntervalMs: 60_000 },
    );

    assert.equal(result.status, 'updated');
    const content = await readFile(join(memoryDir, 'gpt52.md'), 'utf-8');
    assert.match(content, /最后活跃：2026-06-13/);
    assert.match(content, /上次交付：message msg-1 \/ invocation inv-1/);
    assert.match(content, /## 最近验证/);
    assert.match(content, /auto-writer：成功完成 invocation inv-1/);
    assert.match(content, /不恢复 4 行主消息硬限制/);
    assert.match(content, /回复要自然可读/);
  });

  it('rate limits repeated writes for the same agent', async () => {
    const { autoUpdateAgentMemory } = await import(
      '../dist/domains/cats/services/agents/memory/AgentMemoryAutoWriter.js'
    );
    const first = await autoUpdateAgentMemory(
      {
        catId: 'pi',
        invocationId: 'inv-1',
        threadId: 'thread-1',
        assistantText: '第一次成功回复。',
      },
      { projectRoot: tempRoot, now: () => 100_000, minIntervalMs: 60_000 },
    );
    const second = await autoUpdateAgentMemory(
      {
        catId: 'pi',
        invocationId: 'inv-2',
        threadId: 'thread-1',
        assistantText: '第二次成功回复。',
      },
      { projectRoot: tempRoot, now: () => 120_000, minIntervalMs: 60_000 },
    );

    assert.equal(first.status, 'updated');
    assert.deepEqual(second, { status: 'skipped', reason: 'rate_limited' });
  });

  it('force bypasses rate limiting for mandatory memory writeback', async () => {
    const { autoUpdateAgentMemory } = await import(
      '../dist/domains/cats/services/agents/memory/AgentMemoryAutoWriter.js'
    );
    await autoUpdateAgentMemory(
      {
        catId: 'pi',
        invocationId: 'inv-1',
        threadId: 'thread-1',
        assistantText: '第一次成功回复。',
      },
      { projectRoot: tempRoot, now: () => 100_000, minIntervalMs: 60_000 },
    );
    const forced = await autoUpdateAgentMemory(
      {
        catId: 'pi',
        invocationId: 'inv-critical',
        threadId: 'thread-1',
        assistantText: 'critical 级别强制回写。',
      },
      { projectRoot: tempRoot, now: () => 120_000, minIntervalMs: 60_000, force: true },
    );

    assert.equal(forced.status, 'updated');
    const content = await readFile(join(tempRoot, '.cat-cafe', 'memory', 'pi.md'), 'utf-8');
    assert.match(content, /invocation inv-critical/);
    assert.match(content, /critical 级别强制回写/);
  });

  it('isolates rate limits for the same agent across project roots', async () => {
    const { autoUpdateAgentMemory } = await import(
      '../dist/domains/cats/services/agents/memory/AgentMemoryAutoWriter.js'
    );
    const firstProject = join(tempRoot, 'project-a');
    const secondProject = join(tempRoot, 'project-b');
    const first = await autoUpdateAgentMemory(
      {
        catId: 'codex',
        invocationId: 'inv-a',
        threadId: 'thread-a',
        assistantText: '项目 A 交付。',
      },
      { projectRoot: firstProject, now: () => 100_000, minIntervalMs: 60_000 },
    );
    const second = await autoUpdateAgentMemory(
      {
        catId: 'codex',
        invocationId: 'inv-b',
        threadId: 'thread-b',
        assistantText: '项目 B 交付。',
      },
      { projectRoot: secondProject, now: () => 120_000, minIntervalMs: 60_000 },
    );

    assert.equal(first.status, 'updated');
    assert.equal(second.status, 'updated');
    assert.match(await readFile(join(firstProject, '.cat-cafe', 'memory', 'codex.md'), 'utf-8'), /项目 A 交付/);
    assert.match(await readFile(join(secondProject, '.cat-cafe', 'memory', 'codex.md'), 'utf-8'), /项目 B 交付/);
  });

  it('serializes concurrent forced writes and atomically preserves complete content', async () => {
    const { autoUpdateAgentMemory } = await import(
      '../dist/domains/cats/services/agents/memory/AgentMemoryAutoWriter.js'
    );
    const writes = Array.from({ length: 10 }, (_, index) =>
      autoUpdateAgentMemory(
        {
          catId: 'claude',
          invocationId: `inv-concurrent-${index}`,
          threadId: 'thread-concurrent',
          assistantText: `并发交付 ${index}。`,
        },
        { projectRoot: tempRoot, now: () => 100_000 + index, minIntervalMs: 60_000, force: true },
      ),
    );

    const results = await Promise.all(writes);
    assert.ok(results.every((result) => result.status === 'updated'));

    const memoryDir = join(tempRoot, '.cat-cafe', 'memory');
    const content = await readFile(join(memoryDir, 'claude.md'), 'utf-8');
    for (let index = 0; index < writes.length; index += 1) {
      assert.match(content, new RegExp(`invocation inv-concurrent-${index}(?:\\s|（)`));
    }
    assert.match(content, /上次交付：thread thread-concurrent \/ invocation inv-concurrent-9: 并发交付 9。/);
    assert.deepEqual(await readdir(memoryDir), ['claude.md']);
  });

  it('skips empty assistant summaries', async () => {
    const { autoUpdateAgentMemory } = await import(
      '../dist/domains/cats/services/agents/memory/AgentMemoryAutoWriter.js'
    );
    const result = await autoUpdateAgentMemory(
      { catId: 'kimi', invocationId: 'inv-empty', threadId: 'thread-1', assistantText: '   ' },
      { projectRoot: tempRoot, now: () => 100_000, minIntervalMs: 60_000 },
    );

    assert.deepEqual(result, { status: 'skipped', reason: 'empty_summary' });
  });
});
