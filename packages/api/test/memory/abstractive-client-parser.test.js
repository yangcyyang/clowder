import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const baseInput = {
  previousSummary: null,
  messages: [
    { id: 'msg-1', content: 'Hello', catId: 'opus', timestamp: Date.now() - 60000 },
    { id: 'msg-5', content: 'Goodbye', catId: 'user', timestamp: Date.now() },
  ],
  threadId: 'thread_test123',
};

describe('parseNaturalLanguageOutput', () => {
  it('parses title + summary + 2 candidates (explicit + inferred)', async () => {
    const { parseNaturalLanguageOutput } = await import('../../dist/domains/memory/AbstractiveSummaryClient.js');

    const text = `# Memory Architecture Discussion

Discussed the architecture of the memory system, decided to use YAML as truth source, and learned about Redis isolation requirements for development environments.

## Durable Knowledge

[decision!] Knowledge Feed uses YAML as truth source — for git-trackability and audit trail
[lesson] Redis port isolation prevents data corruption — dev on 6398, prod on 6399`;

    const result = parseNaturalLanguageOutput(text, baseInput);
    assert.ok(result);
    assert.equal(result.segments.length, 1);
    assert.equal(result.segments[0].topicLabel, 'Memory Architecture Discussion');
    assert.ok(result.segments[0].summary.includes('architecture'));
    assert.equal(result.segments[0].candidates.length, 2);
    assert.equal(result.segments[0].candidates[0].confidence, 'explicit');
    assert.equal(result.segments[0].candidates[1].confidence, 'inferred');
  });

  it('uses first line as fallback when no # title', async () => {
    const { parseNaturalLanguageOutput } = await import('../../dist/domains/memory/AbstractiveSummaryClient.js');

    const text = `**Redis Isolation Strategy**

Summary of how we handle Redis port isolation in development and production environments.`;

    const result = parseNaturalLanguageOutput(text, baseInput);
    assert.ok(result);
    assert.equal(result.segments[0].topicLabel, 'Redis Isolation Strategy');
  });

  it('caps candidates at MAX_CANDIDATES_PER_SEGMENT', async () => {
    const { parseNaturalLanguageOutput, MAX_CANDIDATES_PER_SEGMENT } = await import(
      '../../dist/domains/memory/AbstractiveSummaryClient.js'
    );

    const text = `# Many Decisions

Made lots of decisions today.

[decision!] First decision about architecture — important
[lesson] Second learning about testing — also important
[method] Third method about deployment — worth keeping`;

    const result = parseNaturalLanguageOutput(text, baseInput);
    assert.ok(result);
    assert.ok(result.segments[0].candidates.length <= MAX_CANDIDATES_PER_SEGMENT);
    // explicit should be kept first
    assert.equal(result.segments[0].candidates[0].confidence, 'explicit');
  });

  it('filters implementation noise candidates', async () => {
    const { parseNaturalLanguageOutput } = await import('../../dist/domains/memory/AbstractiveSummaryClient.js');

    const text = `# Code Changes

Updated several files for the memory system.

[decision] Added mkdirSync before writeFileSync — prevents ENOENT
[lesson!] Silent catch blocks cause invisible data loss — always log errors in catch blocks`;

    const result = parseNaturalLanguageOutput(text, baseInput);
    assert.ok(result);
    // "Added mkdirSync..." should be filtered as implementation noise (starts with code action verb + camelCase)
    // "Silent catch blocks..." should survive (durable lesson, no code identifiers)
    const candidates = result.segments[0].candidates ?? [];
    const titles = candidates.map((c) => c.title);
    assert.ok(!titles.some((t) => t.includes('mkdirSync')), 'implementation noise should be filtered');
    assert.ok(
      titles.some((t) => t.includes('Silent catch blocks')),
      'durable knowledge should survive',
    );
  });

  it('returns null for empty/whitespace input', async () => {
    const { parseNaturalLanguageOutput } = await import('../../dist/domains/memory/AbstractiveSummaryClient.js');

    assert.equal(parseNaturalLanguageOutput('', baseInput), null);
    assert.equal(parseNaturalLanguageOutput('   ', baseInput), null);
    assert.equal(parseNaturalLanguageOutput('short', baseInput), null);
  });

  it('preserves the four recall fields required by delivery-only context', async () => {
    const { parseNaturalLanguageOutput } = await import('../../dist/domains/memory/AbstractiveSummaryClient.js');

    const text = `# F004 context governance

## 当前状态/任务 (Current status)
截至 msg-5，delivery-only 正在 canary 验证。

## 已确认决策/约束 (Decision/constraint)
只在 single-target serial route 启用。

## 下一步 (Next action)
验证 active prompt 不含 raw history window。

## 风险/锚点 (Risk/anchor)
摘要可能遗漏细节；需要时回看 msg-1..msg-5 原文。`;

    const result = parseNaturalLanguageOutput(text, baseInput);
    const summary = result?.segments[0]?.summary ?? '';
    assert.match(summary, /当前状态\/任务/);
    assert.match(summary, /已确认决策\/约束/);
    assert.match(summary, /下一步/);
    assert.match(summary, /风险\/锚点/);
  });
});
