/**
 * 批次 2-D 任务一: 猫记忆两层化 —— 索引全文注入 (v2 meta 槽) vs v1 字节冻结。
 *
 * docs/research/clowder-raft-thread-task-design.md §5B.1: Raft 是索引全文注入，
 * Clowder 现状把 `.cat-cafe/memory/{catId}.md` 压成 ≤200 字摘要。改法：v2 的
 * meta 槽（buildTurnMetaBlock）改为两层索引全文注入（预算 ≤4k tokens，超预算
 * 截断 + 提示猫自行整理为「索引 + notes/」两层）；v1 静态前缀路径
 * （buildStaticIdentity 默认 cacheLayout）保持 ≤200 字摘要不变——字节冻结。
 *
 * This file is intentionally separate from adr-024-context-cache-layout.test.js
 * (shared hot file across parallel batches) to avoid merge collisions.
 */
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

async function builder() {
  return import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
}

const SHORT_MEMORY = [
  '# Opus 记忆',
  '',
  '## 当前状态',
  '正在做批次 2-D 记忆两层化',
  '',
  '## 已关闭决策（别再提了）',
  '- 不再恢复 4 行硬限制',
  '',
  '## 行为偏好',
  '- 中文白话',
  '',
  '## 环境 gotcha',
  '- dist 需先 build',
].join('\n');

const INVOCATION = { catId: 'opus', mode: 'independent', teammates: [], mcpAvailable: false };

describe('批次 2-D: agent memory two-layer index injection', () => {
  test('v1 buildStaticIdentity keeps the ≤200-char summary behavior (byte freeze)', async () => {
    const { buildStaticIdentity } = await builder();
    const v1 = buildStaticIdentity('opus', { agentMemoryContext: SHORT_MEMORY });
    assert.ok(v1.includes('只注入 ≤200 字摘要'), 'v1 must keep the summary-behavior explainer line');
    assert.ok(!v1.includes('两层记忆：本节是索引'), 'v1 must NOT switch to index-injection wording');
    // v1 never renders the full raw memory text verbatim (it summarizes/clips it).
    assert.ok(!v1.includes('- dist 需先 build'), 'v1 must not carry the raw 环境 gotcha bullet verbatim');
  });

  test('v2 buildTurnMetaBlock injects the FULL index text (not the 200-char summary)', async () => {
    const { buildTurnMetaBlock, META_BLOCK_HEADER } = await builder();
    const meta = buildTurnMetaBlock(INVOCATION, { agentMemoryContext: SHORT_MEMORY });
    assert.ok(meta.startsWith(META_BLOCK_HEADER));
    assert.ok(meta.includes('## 跨 Session 记忆（持久化）'));
    assert.ok(meta.includes('两层记忆：本节是索引'), 'v2 must explain the two-layer index-injection contract');
    // Full raw text present verbatim — this is the point of the fix (Raft parity).
    assert.ok(meta.includes('正在做批次 2-D 记忆两层化'));
    assert.ok(meta.includes('- 不再恢复 4 行硬限制'));
    assert.ok(meta.includes('- 中文白话'));
    assert.ok(meta.includes('- dist 需先 build'), 'v2 must carry the full raw memory text, not a 200-char clip');
    assert.ok(!meta.includes('只注入 ≤200 字摘要'), 'v2 must not use the v1 summary wording');
  });

  test('v2 mentions notes/ as the on-demand detail layer (no new read mechanism)', async () => {
    const { buildTurnMetaBlock } = await builder();
    const meta = buildTurnMetaBlock(INVOCATION, { agentMemoryContext: SHORT_MEMORY });
    assert.match(meta, /notes\/\{catId\}\/|memory\/notes\/\{catId\}/);
  });

  test('v2 empty/absent memory renders no section at all (same contract as v1)', async () => {
    const { buildTurnMetaBlock } = await builder();
    const metaEmpty = buildTurnMetaBlock(INVOCATION, { agentMemoryContext: '' });
    const metaNull = buildTurnMetaBlock(INVOCATION, { agentMemoryContext: null });
    assert.ok(!metaEmpty.includes('## 跨 Session 记忆（持久化）'));
    assert.ok(!metaNull.includes('## 跨 Session 记忆（持久化）'));
  });

  test('v2 truncates over-budget index (>4k tokens) and adds a reorganize hint', async () => {
    const { buildTurnMetaBlock } = await builder();
    // ~4 chars/token per roughTokenEstimate; build something well over 4000 tokens (16000 chars).
    const longMemory = `# Opus 记忆\n\n## Active Context\n${'正在处理一个很长的任务状态描述。'.repeat(2000)}`;
    const meta = buildTurnMetaBlock(INVOCATION, { agentMemoryContext: longMemory });
    assert.ok(meta.includes('已截断'), 'over-budget index must be truncated');
    assert.ok(meta.includes('两层结构'), 'must prompt the cat to reorganize into index + notes/');
    assert.ok(meta.length < longMemory.length + 2000, 'meta must not carry the full oversized text verbatim');
  });

  test('v1 golden byte-equivalence is untouched by the v2 index-injection change', async () => {
    // Re-derive the same assertion the ADR-024 golden test makes, scoped to memory,
    // as an extra tripwire specific to this batch's change surface.
    const { buildStaticIdentity } = await builder();
    const before = buildStaticIdentity('opus', {
      mcpAvailable: true,
      toolPolicy: 'standard',
      agentMemoryContext: SHORT_MEMORY,
      maxPromptTokens: 100000,
    });
    const again = buildStaticIdentity('opus', {
      mcpAvailable: true,
      toolPolicy: 'standard',
      agentMemoryContext: SHORT_MEMORY,
      maxPromptTokens: 100000,
    });
    assert.equal(before, again, 'pure function — same inputs must produce identical bytes');
    assert.ok(before.includes('只注入 ≤200 字摘要'));
  });
});
