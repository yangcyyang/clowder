import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';

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
