/**
 * F-F（批次 3，PRD-memory-upgrade.md）— 猫主动写记忆工具。
 *
 * 覆盖：
 *  A. routeMemoryWriteEvaluation — 给定已计算好的 evaluation，验证四个 action
 *     分支（promote/candidate/hold/skip）各自的落盘行为。
 *  B. evaluateAndRouteMemoryWrite — 端到端，走真实 evaluateMemoryPromotion，
 *     覆盖 duplicate/session-temp/candidate/conflict-hold 四种真实判定结果，
 *     并证明本工具的 schema（content/type/why，没有 userMessageText）天然无法
 *     触发 user-stated 快速通道——不会绕过晋级门。
 *  C. 同门锁死：给定完全相同的 (candidateText, existingMemory) 输入，本工具
 *     的判定路径 与 AgentMemoryAutoWriter.autoUpdateAgentMemory（shadow 模式）
 *     的判定路径必须产生一致的 action/conflict/suggestion——两条路径共享同一
 *     个 evaluateMemoryPromotion 导入，不是各自实现的两套标准。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, before, beforeEach, describe, it } from 'node:test';

const GATE_MODULE = '../../dist/domains/cats/services/agents/memory/AgentMemoryPromotionGate.js';
const WRITER_MODULE = '../../dist/domains/cats/services/agents/memory/AgentMemoryAutoWriter.js';
const ROUTE_MODULE = '../../dist/routes/callback-agent-memory-write-routes.js';

let gate;
let writer;
let route;

before(async () => {
  gate = await import(GATE_MODULE);
  writer = await import(WRITER_MODULE);
  route = await import(ROUTE_MODULE);
});

let tempRoot;

function memoryDir() {
  return join(tempRoot, '.cat-cafe', 'memory');
}

async function seedMemory(catId, content) {
  await mkdir(memoryDir(), { recursive: true });
  await writeFile(join(memoryDir(), `${catId}.md`), content, 'utf-8');
}

async function readMemory(catId) {
  return readFile(join(memoryDir(), `${catId}.md`), 'utf-8');
}

async function readCandidates(catId) {
  return gate.listMemoryCandidates(catId, tempRoot);
}

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-write-memory-tool-'));
  writer.resetAgentMemoryAutoWriterForTests();
});

afterEach(async () => {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

// A minimal, valid MemoryPromotionEvaluation-shaped fixture for direct
// action-routing tests (the heuristics that PRODUCE these are gate's own
// job/tests — this file drives the routing behavior for each action directly).
function fakeEvaluation(overrides) {
  return {
    sourceGrade: 'observed-behavior',
    contentClass: 'fact',
    confidence: 'medium',
    rules: ['test-fixture'],
    lintWarnings: [],
    ...overrides,
  };
}

describe('F-F A: routeMemoryWriteEvaluation — action routing (fixture-driven)', () => {
  it('skip → no durable write, no candidate-queue entry, reports skipReason', async () => {
    const result = await route.routeMemoryWriteEvaluation({
      evaluation: fakeEvaluation({ action: 'skip', skipReason: 'duplicate' }),
      content: '这条内容应该被丢弃',
      catId: 'opus',
      invocationId: 'inv-1',
      threadId: 'thread-1',
      projectRoot: tempRoot,
      now: 1_800_000_000_000,
    });
    assert.deepEqual(result, { status: 'skipped', reason: 'duplicate', action: 'skip' });
    assert.deepEqual(await readCandidates('opus'), []);
    assert.ok(
      !(await readFile(join(memoryDir(), 'opus.md'), 'utf-8').catch(() => null)),
      'skip must not create a durable memory file',
    );
  });

  it('candidate → appendMemoryCandidate with status=pending_review, durable memory untouched', async () => {
    await seedMemory('opus', '# Opus 记忆\n\n## 当前状态\n\n- 最后活跃：2026-07-01\n');
    const evaluation = fakeEvaluation({ action: 'candidate' });
    const result = await route.routeMemoryWriteEvaluation({
      evaluation,
      content: '项目 API 服务运行在 3004 端口',
      catId: 'opus',
      invocationId: 'inv-2',
      threadId: 'thread-1',
      projectRoot: tempRoot,
      now: 1_800_000_000_000,
    });
    assert.deepEqual(result, { status: 'queued', reason: 'pending_review', action: 'candidate' });
    const candidates = await readCandidates('opus');
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].status, 'pending_review');
    assert.match(candidates[0].content, /3004 端口/);
    assert.match(await readMemory('opus'), /最后活跃：2026-07-01/);
    assert.doesNotMatch(await readMemory('opus'), /3004/);
  });

  it('hold → appendMemoryCandidate with status=pending_review, preserves the batch-2 suggestion field verbatim', async () => {
    await seedMemory('opus', '# Opus 记忆\n\n## 硬约束\n\n- 本地开发环境统一使用端口 3003\n');
    const suggestion = {
      kind: 'mergeable',
      existingLine: '本地开发环境统一使用端口 3003',
      similarity: 0.83,
      mergedText: '本地开发环境统一使用端口 3003（更新：改为 3009）',
    };
    const evaluation = fakeEvaluation({
      action: 'hold',
      conflict: { kind: 'fact', key: 'port', existingLine: '本地开发环境统一使用端口 3003', flagged: false },
      suggestion,
    });
    const result = await route.routeMemoryWriteEvaluation({
      evaluation,
      content: '本地开发环境统一使用端口 3009',
      catId: 'opus',
      invocationId: 'inv-3',
      threadId: 'thread-1',
      projectRoot: tempRoot,
      now: 1_800_000_000_000,
    });
    assert.equal(result.status, 'held');
    assert.equal(result.reason, 'conflict_hold');
    assert.deepEqual(result.suggestion, suggestion);
    const candidates = await readCandidates('opus');
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].status, 'pending_review');
    assert.deepEqual(candidates[0].evaluation.suggestion, suggestion);
    assert.doesNotMatch(await readMemory('opus'), /3009/, 'hold must never touch durable memory');
  });

  it('promote → writes durable memory via the existing read/write path AND records a promoted ledger entry', async () => {
    await seedMemory('opus', '# Opus 记忆\n\n## 当前状态\n\n- 最后活跃：2026-07-01\n');
    const evaluation = fakeEvaluation({ action: 'promote', sourceGrade: 'user-stated', reviewer: 'user' });
    const result = await route.routeMemoryWriteEvaluation({
      evaluation,
      content: '以后周报默认发给我和运营同事两个人',
      catId: 'opus',
      invocationId: 'inv-4',
      threadId: 'thread-1',
      projectRoot: tempRoot,
      now: Date.UTC(2026, 6, 25),
    });
    assert.deepEqual(result, { status: 'written', action: 'promote' });
    const content = await readMemory('opus');
    assert.match(content, /最后活跃：2026-07-01/, 'existing content preserved');
    assert.match(content, /以后周报默认发给我和运营同事两个人/);
    assert.match(content, /2026-07-25/);
    const candidates = await readCandidates('opus');
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].status, 'promoted');
    assert.equal(candidates[0].reviewer, 'user');
  });

  it('promote → also works when no durable memory file exists yet', async () => {
    const evaluation = fakeEvaluation({ action: 'promote' });
    await route.routeMemoryWriteEvaluation({
      evaluation,
      content: '第一次沉淀的记忆',
      catId: 'brand-new-cat',
      invocationId: 'inv-5',
      threadId: 'thread-1',
      projectRoot: tempRoot,
      now: Date.UTC(2026, 6, 25),
    });
    const content = await readFile(join(memoryDir(), 'brand-new-cat.md'), 'utf-8');
    assert.match(content, /第一次沉淀的记忆/);
  });
});

describe('F-F B: evaluateAndRouteMemoryWrite — end-to-end via the REAL gate', () => {
  it('exact duplicate content → skip/duplicate, durable memory untouched', async () => {
    const before = '# Opus 记忆\n\n## 当前状态\n\n- 最后活跃：2026-07-01\n';
    await seedMemory('opus', before);
    await route.evaluateAndRouteMemoryWrite({
      catId: 'opus',
      invocationId: 'inv-1',
      threadId: 'thread-1',
      content: '完成了发票模块 Phase 3，测试全部通过。',
      projectRoot: tempRoot,
      now: 1_800_000_000_000,
    });
    const second = await route.evaluateAndRouteMemoryWrite({
      catId: 'opus',
      invocationId: 'inv-2',
      threadId: 'thread-1',
      content: '完成了发票模块 Phase 3，测试全部通过。',
      projectRoot: tempRoot,
      now: 1_800_000_060_000,
    });
    assert.equal(second.status, 'skipped');
    assert.equal(second.reason, 'duplicate');
    assert.equal(await readMemory('opus'), before);
    const candidates = await readCandidates('opus');
    assert.equal(candidates.length, 1, 'the duplicate must not create a second candidate');
  });

  it('session-temp content → skip/session_temp', async () => {
    const result = await route.evaluateAndRouteMemoryWrite({
      catId: 'opus',
      invocationId: 'inv-1',
      threadId: 'thread-1',
      content: '本次会话临时变量 foo=bar，仅暂存用于本轮计算。',
      projectRoot: tempRoot,
      now: 1_800_000_000_000,
    });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'session_temp');
  });

  it('clean new fact, no conflicts → queued/pending_review, with type/why carried into frontmatter for lint', async () => {
    const result = await route.evaluateAndRouteMemoryWrite({
      catId: 'opus',
      invocationId: 'inv-1',
      threadId: 'thread-1',
      content: '项目 API 服务运行在 3004 端口',
      type: 'project',
      projectRoot: tempRoot,
      now: 1_800_000_000_000,
    });
    assert.equal(result.status, 'queued');
    assert.equal(result.reason, 'pending_review');
    assert.equal(result.action, 'candidate');
  });

  it('port conflict with existing durable memory → held/conflict_hold, batch-2 suggestion attached', async () => {
    await seedMemory('opus', '# Opus 记忆\n\n## 硬约束\n\n- 本地开发环境统一使用端口 3003 启动前端服务，禁止改动\n');
    const result = await route.evaluateAndRouteMemoryWrite({
      catId: 'opus',
      invocationId: 'inv-1',
      threadId: 'thread-1',
      content: '本地开发环境统一使用端口 3009 启动前端服务，禁止改动',
      type: 'project',
      projectRoot: tempRoot,
      now: 1_700_000_000_000,
    });
    assert.equal(result.status, 'held');
    assert.equal(result.reason, 'conflict_hold');
    assert.equal(result.action, 'hold');
    assert.equal(result.conflict.kind, 'fact');
    assert.equal(result.conflict.key, 'port');
    assert.ok(result.suggestion, 'F-B suggestion must flow through this new entry point too');
    assert.equal(result.suggestion.kind, 'mergeable');
  });

  it('no bypass: embedding the literal "记住：" trigger phrase in `content` does NOT fast-track to promote ' +
    '(this tool never supplies userMessageText, so rule 4 of evaluateMemoryPromotion can never fire here)', async () => {
    const result = await route.evaluateAndRouteMemoryWrite({
      catId: 'opus',
      invocationId: 'inv-1',
      threadId: 'thread-1',
      content: '记住：以后周报默认发给我和运营同事两个人',
      projectRoot: tempRoot,
      now: 1_800_000_000_000,
    });
    assert.notEqual(result.action, 'promote', 'a cat cannot self-fast-track by quoting the trigger phrase');
    assert.equal(result.status, 'queued');
    assert.equal(result.action, 'candidate');
  });
});

describe('F-F C: 同门锁死 — this tool and AgentMemoryAutoWriter share evaluateMemoryPromotion', () => {
  // AutoWriter's own evaluation only runs when CAT_CAFE_MEMORY_PROMOTION_MODE is
  // shadow/enforce (its 'off' default is a legacy zero-behavior-change switch for
  // the PRE-EXISTING auto-writer — see AgentMemoryAutoWriter.ts's own docs). This
  // tool's evaluateAndRouteMemoryWrite has NO such mode toggle — it always
  // evaluates ("强制走同一个晋级门", PRD F-F) since it is brand-new functionality
  // with no legacy behavior to preserve. Force 'shadow' here purely so
  // AutoWriter's SIDE of this parity comparison actually produces an
  // `evaluation` to compare against; this does not change the tool's own posture.
  let savedMode;
  beforeEach(() => {
    savedMode = process.env.CAT_CAFE_MEMORY_PROMOTION_MODE;
    process.env.CAT_CAFE_MEMORY_PROMOTION_MODE = 'shadow';
  });
  afterEach(() => {
    if (savedMode === undefined) delete process.env.CAT_CAFE_MEMORY_PROMOTION_MODE;
    else process.env.CAT_CAFE_MEMORY_PROMOTION_MODE = savedMode;
  });

  function writerOptions(extra = {}) {
    return { projectRoot: tempRoot, now: () => 1_800_000_000_000, minIntervalMs: 60_000, force: true, ...extra };
  }

  // Compare the STABLE parts of the decision only — `suggestion.proposedFrontmatterPatch.invalid_at`
  // is timestamped from AutoWriter's own internal Date.now() (it does not thread
  // its injectable `now` option through to evaluateMemoryPromotion — a
  // pre-existing AutoWriter characteristic this file must not paper over by
  // reaching into AutoWriter internals). Everything else must match exactly.
  function stableFields(evaluation) {
    if (!evaluation) return undefined;
    const { action, conflict, suggestion } = evaluation;
    const stableSuggestion = suggestion
      ? {
          kind: suggestion.kind,
          ...(suggestion.kind === 'mergeable'
            ? { existingLine: suggestion.existingLine, similarity: suggestion.similarity, mergedText: suggestion.mergedText }
            : { staleLine: suggestion.staleLine, similarity: suggestion.similarity }),
        }
      : undefined;
    return { action, conflict, suggestion: stableSuggestion };
  }

  it('duplicate content: both paths agree on skip/duplicate', async () => {
    const before = '# Opus 记忆\n\n## 当前状态\n\n- 最后活跃：2026-07-01\n';
    await seedMemory('opus', before);
    const content = '完成了发票模块 Phase 3，测试全部通过。';

    await writer.autoUpdateAgentMemory({ catId: 'opus', invocationId: 'inv-a', threadId: 't', assistantText: content }, writerOptions());
    const autoWriterSecond = await writer.autoUpdateAgentMemory(
      { catId: 'opus', invocationId: 'inv-b', threadId: 't', assistantText: content },
      writerOptions({ now: () => 1_800_000_060_000 }),
    );
    // Shadow mode always writes ("observe-first" — see AgentMemoryAutoWriter.ts);
    // the WOULD-BE decision rides along on `.evaluation`, which is the part this
    // parity test cares about.
    assert.equal(autoWriterSecond.status, 'updated');
    assert.equal(autoWriterSecond.evaluation.action, 'skip');
    assert.equal(autoWriterSecond.evaluation.skipReason, 'duplicate');

    // Reset the on-disk state so the tool's own dedup baseline starts fresh,
    // then reproduce the identical two-write sequence through the tool path.
    await rm(memoryDir(), { recursive: true, force: true });
    await seedMemory('opus', before);
    await route.evaluateAndRouteMemoryWrite({
      catId: 'opus',
      invocationId: 'inv-a2',
      threadId: 't',
      content,
      projectRoot: tempRoot,
      now: 1_800_000_000_000,
    });
    const toolSecond = await route.evaluateAndRouteMemoryWrite({
      catId: 'opus',
      invocationId: 'inv-b2',
      threadId: 't',
      content,
      projectRoot: tempRoot,
      now: 1_800_000_060_000,
    });

    assert.equal(toolSecond.status, 'skipped');
    assert.equal(toolSecond.reason, 'duplicate');
    assert.equal(toolSecond.action, 'skip');
    assert.equal(autoWriterSecond.evaluation.action, toolSecond.action);
    assert.equal(autoWriterSecond.evaluation.skipReason, toolSecond.reason);
  });

  it('port conflict: both paths agree on hold/fact/port WITH matching (non-timestamp) suggestion fields', async () => {
    const before = '# Opus 记忆\n\n## 硬约束\n\n- 本地开发环境统一使用端口 3003 启动前端服务，禁止改动\n';
    const content = '本地开发环境统一使用端口 3009 启动前端服务，禁止改动';

    await seedMemory('opus', before);
    const autoWriterResult = await writer.autoUpdateAgentMemory(
      { catId: 'opus', invocationId: 'inv-a', threadId: 't', assistantText: content },
      writerOptions(),
    );

    await rm(memoryDir(), { recursive: true, force: true });
    await seedMemory('opus', before);
    const toolResult = await route.evaluateAndRouteMemoryWrite({
      catId: 'opus',
      invocationId: 'inv-a2',
      threadId: 't',
      content,
      projectRoot: tempRoot,
      now: 1_800_000_000_000,
    });

    assert.equal(autoWriterResult.status, 'updated');
    assert.equal(autoWriterResult.evaluation.action, 'hold');
    assert.equal(toolResult.status, 'held');
    assert.deepEqual(stableFields(autoWriterResult.evaluation), stableFields(toolResult));
  });

  it('clean new fact, no conflicts: both paths agree on candidate/pending_review', async () => {
    const before = '# Opus 记忆\n\n## 当前状态\n\n- 最后活跃：2026-07-01\n';
    const content = '项目 API 服务运行在 3004 端口';

    await seedMemory('opus', before);
    const autoWriterResult = await writer.autoUpdateAgentMemory(
      { catId: 'opus', invocationId: 'inv-a', threadId: 't', assistantText: content, userMessageText: '帮我看看端口' },
      writerOptions(),
    );

    await rm(memoryDir(), { recursive: true, force: true });
    await seedMemory('opus', before);
    const toolResult = await route.evaluateAndRouteMemoryWrite({
      catId: 'opus',
      invocationId: 'inv-a2',
      threadId: 't',
      content,
      projectRoot: tempRoot,
      now: 1_800_000_000_000,
    });

    assert.equal(autoWriterResult.status, 'updated');
    assert.equal(autoWriterResult.evaluation.action, 'candidate');
    assert.equal(toolResult.status, 'queued');
    assert.equal(toolResult.action, 'candidate');
  });
});
