/**
 * 票C — Memory promotion review gate (P1-4 closed-loop self-pollution fix).
 *
 * Sentinel corpus:
 *  C-S conflict series (must be HELD, old memory keeps serving):
 *    1. existing "主消息要简短" vs new "用户要求长报告" → held, old memory still served
 *    2. port 3003 vs "端口改 3005" → held
 *    3. contradicting a CLOSED decision → held + flagged
 *    4. no-source subjective guess → low confidence, not promoted
 *    5. well-sourced new fact → candidate queue only, not in static prompt until reviewed
 *    6. exact duplicate write → dedup
 *  C-P positive series:
 *    1. explicit user "记住：以后 X" → fast-track allowed with reviewer=user recorded
 *    2. pure session temp vars → never durable
 *  E2E closed-loop: inject conflict sentinel (1), then build a NEW session static
 *  prompt and assert the held content does NOT appear in it.
 *
 * Mode discipline (same as 票A observe-before-enforce):
 *  off (default) = zero behavior change; shadow = evaluate+log but write as today;
 *  enforce = candidate queue + hold-on-conflict.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const GATE_MODULE = '../dist/domains/cats/services/agents/memory/AgentMemoryPromotionGate.js';
const WRITER_MODULE = '../dist/domains/cats/services/agents/memory/AgentMemoryAutoWriter.js';
const STORE_MODULE = '../dist/domains/cats/services/agents/memory/AgentMemoryStore.js';
const PROMPT_MODULE = '../dist/domains/cats/services/context/SystemPromptBuilder.js';

let tempRoot;
let savedMode;

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
  const { listMemoryCandidates } = await import(GATE_MODULE);
  return listMemoryCandidates(catId, tempRoot);
}

function setMode(mode) {
  if (mode === undefined) delete process.env.CAT_CAFE_MEMORY_PROMOTION_MODE;
  else process.env.CAT_CAFE_MEMORY_PROMOTION_MODE = mode;
}

const BASE_SUMMARY = {
  catId: 'opus',
  invocationId: 'inv-pc-1',
  threadId: 'thread-pc-1',
  currentUserMessageId: 'msg-pc-1',
};

function writerOptions(extra = {}) {
  return { projectRoot: tempRoot, now: () => 1_800_000_000_000, minIntervalMs: 60_000, force: true, ...extra };
}

describe('AgentMemoryPromotionGate', () => {
  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-promotion-gate-'));
    savedMode = process.env.CAT_CAFE_MEMORY_PROMOTION_MODE;
    const mod = await import(WRITER_MODULE);
    mod.resetAgentMemoryAutoWriterForTests();
  });

  afterEach(async () => {
    setMode(savedMode);
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  });

  describe('mode resolution', () => {
    it('defaults to off, accepts shadow/enforce, rejects garbage to off', async () => {
      const { resolveMemoryPromotionMode } = await import(GATE_MODULE);
      setMode(undefined);
      assert.equal(resolveMemoryPromotionMode(), 'off');
      setMode('shadow');
      assert.equal(resolveMemoryPromotionMode(), 'shadow');
      setMode('enforce');
      assert.equal(resolveMemoryPromotionMode(), 'enforce');
      setMode('banana');
      assert.equal(resolveMemoryPromotionMode(), 'off');
    });
  });

  describe('mode discipline', () => {
    it('off mode = zero behavior change: conflict content written as today, no candidate queue', async () => {
      setMode('off');
      await seedMemory('opus', '# Opus 记忆\n\n## 行为偏好（用户纠正过的）\n\n- 主消息要简短。\n');
      const { autoUpdateAgentMemory } = await import(WRITER_MODULE);
      const result = await autoUpdateAgentMemory(
        { ...BASE_SUMMARY, assistantText: '用户要求长报告，以后都输出长报告。' },
        writerOptions(),
      );
      assert.equal(result.status, 'updated');
      assert.match(await readMemory('opus'), /用户要求长报告/);
      assert.deepEqual(await readCandidates('opus'), []);
    });

    it('shadow mode = evaluate + record decision but write as today (observe-first)', async () => {
      setMode('shadow');
      await seedMemory('opus', '# Opus 记忆\n\n## 行为偏好（用户纠正过的）\n\n- 主消息要简短。\n');
      const { autoUpdateAgentMemory } = await import(WRITER_MODULE);
      const result = await autoUpdateAgentMemory(
        { ...BASE_SUMMARY, assistantText: '用户要求长报告，以后都输出长报告。' },
        writerOptions(),
      );
      // Shadow: write happens exactly as today…
      assert.equal(result.status, 'updated');
      assert.match(await readMemory('opus'), /用户要求长报告/);
      // …but the evaluation that WOULD hold it in enforce is surfaced for observation.
      assert.ok(result.evaluation, 'shadow mode must attach the would-be evaluation');
      assert.equal(result.evaluation.action, 'hold');
      assert.equal(result.evaluation.conflict.kind, 'preference');
    });
  });

  describe('C-S conflict series (enforce)', () => {
    it('C-S1: "主消息要简短" vs "用户要求长报告" → held, old memory still served', async () => {
      setMode('enforce');
      const before = '# Opus 记忆\n\n## 行为偏好（用户纠正过的）\n\n- 主消息要简短。\n';
      await seedMemory('opus', before);
      const { autoUpdateAgentMemory } = await import(WRITER_MODULE);
      const result = await autoUpdateAgentMemory(
        { ...BASE_SUMMARY, assistantText: '用户要求长报告，以后都输出长报告。' },
        writerOptions(),
      );
      assert.equal(result.status, 'held');
      assert.equal(result.reason, 'conflict_hold');
      assert.equal(result.evaluation.conflict.kind, 'preference');
      // Old memory keeps serving — file byte-identical.
      assert.equal(await readMemory('opus'), before);
      // Held content lands in the candidate queue with pending_review marker.
      const candidates = await readCandidates('opus');
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].status, 'pending_review');
      assert.match(candidates[0].content, /用户要求长报告/);
      assert.equal(candidates[0].evaluation.conflict.kind, 'preference');
    });

    it('C-S2: port 3003 vs "端口改 3005" → held', async () => {
      setMode('enforce');
      const before = '# Opus 记忆\n\n## 环境 gotcha\n\n- 端口 3003 是 Clowder 常用端口。\n';
      await seedMemory('opus', before);
      const { autoUpdateAgentMemory } = await import(WRITER_MODULE);
      const result = await autoUpdateAgentMemory(
        { ...BASE_SUMMARY, assistantText: '端口改 3005，已验证可连。' },
        writerOptions(),
      );
      assert.equal(result.status, 'held');
      assert.equal(result.reason, 'conflict_hold');
      assert.equal(result.evaluation.conflict.kind, 'fact');
      assert.equal(result.evaluation.conflict.key, 'port');
      assert.equal(await readMemory('opus'), before);
      const candidates = await readCandidates('opus');
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].status, 'pending_review');
    });

    it('C-S3: contradicting a CLOSED decision → held + flagged', async () => {
      setMode('enforce');
      const before = '# Opus 记忆\n\n## 已关闭决策（别再提了）\n\n- 不恢复 4 行主消息硬限制。\n';
      await seedMemory('opus', before);
      const { autoUpdateAgentMemory } = await import(WRITER_MODULE);
      const result = await autoUpdateAgentMemory(
        { ...BASE_SUMMARY, assistantText: '恢复 4 行主消息硬限制。' },
        writerOptions(),
      );
      assert.equal(result.status, 'held');
      assert.equal(result.reason, 'conflict_hold');
      assert.equal(result.evaluation.conflict.kind, 'closed-decision');
      assert.equal(result.evaluation.conflict.flagged, true);
      assert.equal(await readMemory('opus'), before);
      const candidates = await readCandidates('opus');
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].evaluation.conflict.kind, 'closed-decision');
    });

    it('C-S4: no-source subjective guess → low confidence, not promoted', async () => {
      setMode('enforce');
      const before = '# Opus 记忆\n\n## 当前状态\n\n- 最后活跃：2026-07-01\n';
      await seedMemory('opus', before);
      const { autoUpdateAgentMemory } = await import(WRITER_MODULE);
      const result = await autoUpdateAgentMemory(
        { ...BASE_SUMMARY, assistantText: 'cy 大概喜欢暗色主题。' },
        writerOptions(),
      );
      assert.equal(result.status, 'skipped');
      assert.equal(result.reason, 'low_confidence');
      assert.equal(result.evaluation.confidence, 'low');
      assert.equal(result.evaluation.sourceGrade, 'model-guess');
      assert.equal(await readMemory('opus'), before);
      // Dropped — not even queued as a pending candidate.
      assert.deepEqual(await readCandidates('opus'), []);
    });

    it('C-S5: well-sourced new fact → candidate queue only, not durable until reviewed', async () => {
      setMode('enforce');
      const before = '# Opus 记忆\n\n## 当前状态\n\n- 最后活跃：2026-07-01\n';
      await seedMemory('opus', before);
      const { autoUpdateAgentMemory } = await import(WRITER_MODULE);
      const result = await autoUpdateAgentMemory(
        {
          ...BASE_SUMMARY,
          assistantText: '完成了发票模块 Phase 3，测试全部通过。',
          userMessageText: '帮我完成发票模块 Phase 3',
        },
        writerOptions(),
      );
      assert.equal(result.status, 'held');
      assert.equal(result.reason, 'pending_review');
      assert.equal(result.evaluation.action, 'candidate');
      // Durable memory untouched…
      assert.equal(await readMemory('opus'), before);
      // …content sits in the candidate queue pending review…
      const candidates = await readCandidates('opus');
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].status, 'pending_review');
      assert.match(candidates[0].content, /发票模块 Phase 3/);
      // …and does NOT leak into the next session static prompt.
      const { readAgentMemoryForPrompt } = await import(STORE_MODULE);
      const { buildStaticIdentity } = await import(PROMPT_MODULE);
      const memoryContext = await readAgentMemoryForPrompt('opus', tempRoot);
      const prompt = buildStaticIdentity('opus', { agentMemoryContext: memoryContext });
      assert.ok(!prompt.includes('发票模块'), 'held candidate must not appear in static prompt');
    });

    it('C-S6: exact duplicate write → dedup (no duplicate candidate, no durable write)', async () => {
      setMode('enforce');
      const before = '# Opus 记忆\n\n## 当前状态\n\n- 最后活跃：2026-07-01\n';
      await seedMemory('opus', before);
      const { autoUpdateAgentMemory } = await import(WRITER_MODULE);
      const summary = { ...BASE_SUMMARY, assistantText: '完成了发票模块 Phase 3，测试全部通过。' };
      const first = await autoUpdateAgentMemory(summary, writerOptions());
      assert.equal(first.status, 'held');
      const second = await autoUpdateAgentMemory(
        { ...summary, invocationId: 'inv-pc-2' },
        writerOptions({ now: () => 1_800_000_060_000 }),
      );
      assert.equal(second.status, 'skipped');
      assert.equal(second.reason, 'duplicate');
      const candidates = await readCandidates('opus');
      assert.equal(candidates.length, 1, 'identical content must not create duplicate candidates');
      assert.equal(await readMemory('opus'), before);
    });
  });

  describe('C-P positive series (enforce)', () => {
    it('C-P1: explicit user "记住：以后 X" → fast-track promoted with reviewer=user recorded', async () => {
      setMode('enforce');
      const before = '# Opus 记忆\n\n## 当前状态\n\n- 最后活跃：2026-07-01\n';
      await seedMemory('opus', before);
      const { autoUpdateAgentMemory } = await import(WRITER_MODULE);
      const result = await autoUpdateAgentMemory(
        {
          ...BASE_SUMMARY,
          assistantText: '已记住：以后提交前都先跑 pnpm build。',
          userMessageText: '记住：以后提交前都先跑 pnpm build。',
        },
        writerOptions(),
      );
      assert.equal(result.status, 'updated');
      assert.equal(result.evaluation.action, 'promote');
      assert.equal(result.evaluation.sourceGrade, 'user-stated');
      assert.equal(result.evaluation.reviewer, 'user');
      // Fast-tracked into durable memory…
      assert.match(await readMemory('opus'), /提交前都先跑 pnpm build/);
      // …and recorded in the ledger as promoted by the user.
      const candidates = await readCandidates('opus');
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].status, 'promoted');
      assert.equal(candidates[0].reviewer, 'user');
    });

    it('C-P2: pure session temp vars → never durable', async () => {
      setMode('enforce');
      const before = '# Opus 记忆\n\n## 当前状态\n\n- 最后活跃：2026-07-01\n';
      await seedMemory('opus', before);
      const { autoUpdateAgentMemory } = await import(WRITER_MODULE);
      const result = await autoUpdateAgentMemory(
        { ...BASE_SUMMARY, assistantText: '本次会话临时变量 foo=bar，仅暂存用于本轮计算。' },
        writerOptions(),
      );
      assert.equal(result.status, 'skipped');
      assert.equal(result.reason, 'session_temp');
      assert.equal(result.evaluation.contentClass, 'session-temp');
      assert.equal(await readMemory('opus'), before);
      assert.deepEqual(await readCandidates('opus'), []);
    });
  });

  describe('E2E closed-loop (the P1-4 pollution cycle, now cut)', () => {
    it('held conflict sentinel does NOT appear in a NEW session static prompt; old memory still served', async () => {
      setMode('enforce');
      const before = '# Opus 记忆\n\n## 行为偏好（用户纠正过的）\n\n- 主消息要简短。\n';
      await seedMemory('opus', before);

      // Step 1: a successful invocation tries to auto-write contradicting content.
      const { autoUpdateAgentMemory } = await import(WRITER_MODULE);
      const write = await autoUpdateAgentMemory(
        { ...BASE_SUMMARY, assistantText: '用户要求长报告，以后都输出长报告。' },
        writerOptions(),
      );
      assert.equal(write.status, 'held');

      // Step 2: a NEW session builds its static prompt from durable memory.
      const { readAgentMemoryForPrompt } = await import(STORE_MODULE);
      const { buildStaticIdentity } = await import(PROMPT_MODULE);
      const memoryContext = await readAgentMemoryForPrompt('opus', tempRoot);
      const staticPrompt = buildStaticIdentity('opus', { agentMemoryContext: memoryContext });

      // The pollution loop is cut: held content absent, old preference still served.
      assert.ok(!staticPrompt.includes('长报告'), 'held content must not reach the static prompt');
      assert.match(staticPrompt, /主消息要简短/);
    });
  });
});
