/**
 * ADR-024 D3 W2-D: meta-block persistence-exclusion invariant tests.
 *
 * docs/decisions/024-kv-cache-friendly-context-layout.md D3:
 *   "meta 块是当轮易失产物：每轮由当前状态重新计算，不写入 ThreadStore / 消息存储，
 *    不进入 transcript、摘要、thread memory、session seal。压缩链路（AutoSummarizer /
 *    SessionSealer / TranscriptWriter / buildThreadMemory）必须在摄入侧显式排除 meta
 *    块，而非事后清理。"
 *
 * Three invariants (ADR D3 原文):
 *   ① transcript/seal 产物不得出现 META 头标记
 *   ② 同一 cat 相邻两次组装的 diff 仅存在于 meta 块与当前消息
 *      — covered in test/context-byte-stability.test.js (rewritten against
 *        buildV2TransportDispatch — the un-skipped W1-A tests). Not duplicated
 *        here.
 *   ③ 摘要/记忆生成的输入快照不含 meta 内容
 *
 * This file covers ① and ③, plus unit coverage of the shared filter
 * (meta-persistence-guard.ts) that all four ingestion points call.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

const { META_BLOCK_HEADER, stripMetaBlockSegments, dropMetaTaggedEntries, containsMetaBlockMarker } = await import(
  '../dist/domains/cats/services/context/meta-persistence-guard.js'
);

// ---------------------------------------------------------------------------
// Unit coverage: the shared filter itself
// ---------------------------------------------------------------------------
describe('ADR-024 D3 meta-persistence-guard (unit)', () => {
  test('stripMetaBlockSegments drops only the paragraph carrying the marker', () => {
    const text = [
      '真实历史消息第一段。',
      `${META_BLOCK_HEADER}\n本轮 Task Gate: surface=thread-1 msg=abc\nContext 理智线预警 42%`,
      '真实历史消息第二段。',
    ].join('\n\n');

    const cleaned = stripMetaBlockSegments(text);
    assert.ok(!cleaned.includes(META_BLOCK_HEADER), 'META marker must be gone');
    assert.ok(!cleaned.includes('Task Gate'), 'the whole meta paragraph must be dropped, not just the header line');
    assert.ok(cleaned.includes('真实历史消息第一段'));
    assert.ok(cleaned.includes('真实历史消息第二段'));
  });

  test('stripMetaBlockSegments is a no-op when the marker is absent', () => {
    const text = '普通消息，没有 meta 标记。';
    assert.equal(stripMetaBlockSegments(text), text);
  });

  test('stripMetaBlockSegments handles null/undefined/empty safely', () => {
    assert.equal(stripMetaBlockSegments(null), '');
    assert.equal(stripMetaBlockSegments(undefined), '');
    assert.equal(stripMetaBlockSegments(''), '');
  });

  test('stripMetaBlockSegments drops the entire content when the whole message IS the meta echo', () => {
    // ADR-024 风险 #2: a cat mistakes the meta block for the user message and
    // echoes/replies to it verbatim — the whole message content is one
    // marker-carrying paragraph (no blank-line siblings).
    const wholeEcho = `${META_BLOCK_HEADER}\n收到，本轮 Task Gate 已确认，准备执行。`;
    assert.equal(stripMetaBlockSegments(wholeEcho), '');
  });

  test('containsMetaBlockMarker', () => {
    assert.equal(containsMetaBlockMarker(`${META_BLOCK_HEADER} foo`), true);
    assert.equal(containsMetaBlockMarker('foo'), false);
    assert.equal(containsMetaBlockMarker(undefined), false);
  });

  test('dropMetaTaggedEntries drops only tagged array entries', () => {
    const entries = ['决定采用方案 A', `${META_BLOCK_HEADER} 泄露的元信息`, '还需要确认 B 的边界'];
    const cleaned = dropMetaTaggedEntries(entries);
    assert.deepEqual(cleaned, ['决定采用方案 A', '还需要确认 B 的边界']);
  });

  test('dropMetaTaggedEntries handles undefined', () => {
    assert.deepEqual(dropMetaTaggedEntries(undefined), []);
  });
});

// ---------------------------------------------------------------------------
// ① transcript/seal 产物不得出现 META 头标记 — TranscriptWriter persisted digest
// ---------------------------------------------------------------------------
describe('ADR-024 D3 invariant #1: transcript/seal artifacts never carry the META marker', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'adr024-d3-transcript-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const SESSION_INFO = {
    sessionId: 'sess-d3',
    threadId: 'thread-d3',
    catId: 'opus',
    cliSessionId: 'cli-d3',
    seq: 0,
  };

  test('digest.extractive.json on disk never contains META_BLOCK_HEADER, even if a turn echoed it', async () => {
    const { TranscriptWriter } = await import('../dist/domains/cats/services/session/TranscriptWriter.js');
    const writer = new TranscriptWriter({ dataDir: tmpDir });

    // A cat mistakenly quotes the meta block back as part of its visible reply
    // (ADR-024 风险 #2) — the raw event content carries the marker verbatim.
    writer.appendEvent(SESSION_INFO, {
      type: 'assistant',
      content: [
        {
          type: 'text',
          text: `${META_BLOCK_HEADER}\n本轮 Task Gate: surface=thread-d3 msg=turn-1\nContext 理智线预警 42%`,
        },
      ],
    });
    // A real, substantive reply in the same session.
    writer.appendEvent(SESSION_INFO, {
      type: 'assistant',
      content: [{ type: 'text', text: '真实结论：我们决定采用方案 A，已完成实现。' }],
    });

    const now = Date.now();
    await writer.flush(SESSION_INFO, { createdAt: now - 60_000, sealedAt: now });

    const sessionDir = join(tmpDir, 'threads', SESSION_INFO.threadId, SESSION_INFO.catId, 'sessions', SESSION_INFO.sessionId);
    const digestRaw = await readFile(join(sessionDir, 'digest.extractive.json'), 'utf-8');

    assert.ok(!digestRaw.includes(META_BLOCK_HEADER), 'digest.extractive.json must never contain the META marker');
    assert.ok(!digestRaw.includes('Task Gate'), 'the meta paragraph content must not survive into the persisted digest');
    // Sanity: the real message DID make it through, proving this isn't just an
    // empty/broken digest.
    assert.ok(digestRaw.includes('真实结论'), 'the genuine visible message must still be recorded');

    // events.jsonl is the raw append log, not the compression output D3 gates —
    // sanity-check it round-trips (out of scope for the exclusion invariant,
    // see risk note in the task report).
    const eventsRaw = await readFile(join(sessionDir, 'events.jsonl'), 'utf-8');
    assert.ok(eventsRaw.length > 0);
  });
});

// ---------------------------------------------------------------------------
// ③ 摘要/记忆生成的输入快照不含 meta 内容
// ---------------------------------------------------------------------------
describe('ADR-024 D3 invariant #3: summary/memory generation input snapshots exclude meta content', () => {
  test('AutoSummarizer: a message that is entirely a meta-echo contributes nothing to the summary', async () => {
    const { AutoSummarizer } = await import('../dist/domains/cats/services/orchestration/AutoSummarizer.js');
    const { SummaryStore } = await import('../dist/domains/cats/services/stores/ports/SummaryStore.js');

    const now = Date.now();
    const messages = [];
    // A message that is ENTIRELY a meta echo, seeded with decision-trigger
    // vocabulary that WOULD be picked up by AutoSummarizer's regex if the
    // meta paragraph were not stripped first.
    messages.push({
      id: 'msg-meta-echo',
      content: `${META_BLOCK_HEADER}\n本轮决定采用矢量检索方案，完成了索引重建工作。`,
      catId: 'opus',
      timestamp: now,
      userId: 'user-1',
      threadId: 'thread-d3-summary',
    });
    // Enough real substantive messages to cross MESSAGE_THRESHOLD (20) and
    // produce a real summary.
    for (let i = 0; i < 24; i++) {
      messages.push({
        id: `msg-${i}`,
        content:
          i === 20
            ? '我们决定采用 CLI 子进程模式来实现 agent 调用，已经修复了相关 bug'
            : `这是第 ${i} 条测试消息，内容需要超过二十个字符以通过过滤`,
        catId: 'opus',
        timestamp: now + (i + 1) * 1000,
        userId: 'user-1',
        threadId: 'thread-d3-summary',
      });
    }

    const messageStore = { getByThread: () => messages };
    const summaryStore = new SummaryStore();
    const summarizer = new AutoSummarizer({ messageStore, summaryStore });

    const summary = await summarizer.maybeSummarize('thread-d3-summary');

    assert.ok(summary, 'should have generated a summary from the real messages');
    const serialized = JSON.stringify(summary);
    assert.ok(!serialized.includes(META_BLOCK_HEADER), 'summary must not contain the META marker');
    assert.ok(!serialized.includes('矢量检索方案'), 'the meta-echoed decision text must not leak into the summary');
    // Sanity: real conclusions from genuine messages still made it through.
    assert.ok(serialized.includes('CLI 子进程模式'), 'genuine conclusions must still be extracted');
  });

  test('buildThreadMemory: a meta-tagged signal entry is dropped, sibling entries are preserved', async () => {
    const { buildThreadMemory } = await import('../dist/domains/cats/services/session/buildThreadMemory.js');

    const digest = {
      v: 1,
      sessionId: 'sess-1',
      threadId: 'thread-1',
      catId: 'opus',
      seq: 0,
      time: { createdAt: Date.now() - 60_000, sealedAt: Date.now() },
      invocations: [],
      filesTouched: [],
      errors: [],
    };

    const signals = {
      decisions: ['决定采用方案 A', `${META_BLOCK_HEADER} 泄露的当轮元信息`],
      openQuestions: ['B 的边界还需要确认'],
      artifacts: ['ADR-024'],
    };

    const memory = buildThreadMemory(null, digest, 3000, signals);

    const serialized = JSON.stringify(memory);
    assert.ok(!serialized.includes(META_BLOCK_HEADER), 'ThreadMemory must not contain the META marker');
    assert.ok(memory.decisions?.includes('决定采用方案 A'), 'sibling non-tagged decision must survive');
    assert.ok(
      !memory.decisions?.some((d) => d.includes(META_BLOCK_HEADER)),
      'the meta-tagged decision entry must be dropped',
    );
  });
});
