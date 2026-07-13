import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
const { SessionManager } = await import('../dist/domains/cats/services/session/SessionManager.js');
const { FreshnessHoldStore } = await import('../dist/domains/cats/services/stores/ports/FreshnessHoldStore.js');
const { FreshnessEgressGate } = await import('../dist/domains/cats/services/agents/freshness/FreshnessEgressGate.js');
const { resetAgentMemoryAutoWriterForTests } = await import(
  '../dist/domains/cats/services/agents/memory/AgentMemoryAutoWriter.js'
);
const { __resetHistoryGovernanceDecisionStateForTests } = await import(
  '../dist/domains/cats/services/agents/routing/route-helpers.js'
);

const CRITICAL_ENV_KEYS = [
  'CAT_CAFE_HISTORY_GOVERNANCE',
  'CAT_CAFE_HISTORY_GOVERNANCE_CANARY_THREADS',
  'CAT_CAFE_HISTORY_GOVERNANCE_ACTIVE_RATIO',
  'CAT_CAFE_HISTORY_GOVERNANCE_CRITICAL_RATIO',
  'CAT_CAFE_HISTORY_GOVERNANCE_OBSERVE',
  'CAT_CAFE_DISABLE_MEMORY_AUTO_WRITE',
  'CAT_CAFE_CLAUDE_BUDGET_GATE',
  'CAT_OPUS_MAX_PROMPT_TOKENS',
];
const originalEnv = Object.fromEntries(CRITICAL_ENV_KEYS.map((key) => [key, process.env[key]]));
const tempRoots = [];
const CURRENT_REQUEST = '当前用户要求：测试并修复 critical route 验证。';
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

afterEach(async () => {
  for (const key of CRITICAL_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  __resetHistoryGovernanceDecisionStateForTests();
  resetAgentMemoryAutoWriterForTests();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function setCriticalEnv(threadId) {
  process.env.CAT_CAFE_HISTORY_GOVERNANCE = 'summary-active';
  process.env.CAT_CAFE_HISTORY_GOVERNANCE_CANARY_THREADS = threadId;
  process.env.CAT_CAFE_HISTORY_GOVERNANCE_OBSERVE = '1';
  process.env.CAT_CAFE_HISTORY_GOVERNANCE_ACTIVE_RATIO = '0.1';
  process.env.CAT_CAFE_HISTORY_GOVERNANCE_CRITICAL_RATIO = '0.5';
  process.env.CAT_CAFE_CLAUDE_BUDGET_GATE = 'off';
  process.env.CAT_OPUS_MAX_PROMPT_TOKENS = '20000';
  delete process.env.CAT_CAFE_DISABLE_MEMORY_AUTO_WRITE;
  __resetHistoryGovernanceDecisionStateForTests();
}

function setLegacyEnv() {
  delete process.env.CAT_CAFE_HISTORY_GOVERNANCE;
  delete process.env.CAT_CAFE_HISTORY_GOVERNANCE_CANARY_THREADS;
  delete process.env.CAT_CAFE_HISTORY_GOVERNANCE_ACTIVE_RATIO;
  delete process.env.CAT_CAFE_HISTORY_GOVERNANCE_CRITICAL_RATIO;
  delete process.env.CAT_CAFE_HISTORY_GOVERNANCE_OBSERVE;
  process.env.CAT_CAFE_CLAUDE_BUDGET_GATE = 'off';
  process.env.CAT_CAFE_DISABLE_MEMORY_AUTO_WRITE = '1';
  __resetHistoryGovernanceDecisionStateForTests();
}

function parseSystemInfo(message) {
  if (message.type !== 'system_info' || typeof message.content !== 'string') return null;
  try {
    return JSON.parse(message.content);
  } catch {
    return null;
  }
}

async function createCriticalHarness({
  routeMode,
  output = 'published stdout',
  callbackDisposition,
  injectFreshnessMessage = false,
  fixedInvocationId = 'critical-route-invocation',
  existingCallbackMessage,
} = {}) {
  const projectPath = await mkdtemp(join(tmpdir(), 'clowder-critical-route-'));
  tempRoots.push(projectPath);
  // Treat the isolated fixture as the same git project so unrelated governance
  // bootstrap checks do not short-circuit the route under test.
  let gitPointer;
  try {
    gitPointer = await readFile(join(REPO_ROOT, '.git'), 'utf-8');
  } catch (error) {
    if (error?.code !== 'EISDIR') throw error;
    gitPointer = `gitdir: ${join(REPO_ROOT, '.git', 'worktrees', 'critical-route-fixture')}`;
  }
  await writeFile(join(projectPath, '.git'), gitPointer, 'utf-8');
  const messageStore = new MessageStore();
  const threadStore = new ThreadStore();
  const thread = threadStore.create('user-1', 'Critical route', projectPath);
  const historyMessages = [];
  for (let index = 0; index < 32; index += 1) {
    historyMessages.push(
      messageStore.append({
        userId: 'user-1',
        catId: index % 2 === 0 ? null : 'opus',
        threadId: thread.id,
        content: `历史消息 ${index}：${'用于制造可观测历史预算。'.repeat(45)}`,
        mentions: [],
        timestamp: Date.now() - 60_000 + index,
      }),
    );
  }
  const current = messageStore.append({
    userId: 'user-1',
    catId: null,
    threadId: thread.id,
    content: CURRENT_REQUEST,
    mentions: ['opus'],
    timestamp: Date.now() - 1000,
  });

  let callbackMessage = existingCallbackMessage;
  const callbackBody = 'CALLBACK-CANONICAL-BODY：只允许这段正文进入 memory。';
  if (callbackDisposition === 'replayed' && !callbackMessage) {
    callbackMessage = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      threadId: thread.id,
      content: callbackBody,
      mentions: [],
      origin: 'callback',
      timestamp: Date.now() - 500,
    });
  }

  const service = {
    async *invoke() {
      yield { type: 'text', catId: 'opus', content: output, timestamp: Date.now() };
      if (callbackDisposition) {
        yield {
          type: 'tool_use',
          catId: 'opus',
          toolName: 'mcp:cat-cafe/cat_cafe_post_message',
          toolInput: { threadId: thread.id, content: 'PRIVATE-CALLBACK-DRAFT' },
          timestamp: Date.now(),
        };
        if (callbackDisposition === 'published') {
          callbackMessage = messageStore.append({
            userId: 'user-1',
            catId: 'opus',
            threadId: thread.id,
            content: callbackBody,
            mentions: [],
            origin: 'callback',
            timestamp: Date.now(),
          });
          yield {
            type: 'tool_result',
            catId: 'opus',
            toolName: 'mcp:cat-cafe/cat_cafe_post_message',
            content: JSON.stringify({
              status: 'ok',
              disposition: 'published',
              threadId: thread.id,
              messageId: callbackMessage.id,
            }),
            timestamp: Date.now(),
          };
        } else if (callbackDisposition === 'replayed') {
          yield {
            type: 'tool_result',
            catId: 'opus',
            toolName: 'mcp:cat-cafe/cat_cafe_post_message',
            content: JSON.stringify({
              status: 'duplicate',
              disposition: 'published',
              threadId: thread.id,
              messageId: callbackMessage.id,
            }),
            timestamp: Date.now(),
          };
        } else {
          yield {
            type: 'tool_result',
            catId: 'opus',
            toolName: 'mcp:cat-cafe/cat_cafe_post_message',
            content: JSON.stringify({
              status: callbackDisposition === 'held' ? 'freshness_held' : 'freshness_discarded',
              disposition: callbackDisposition,
              threadId: thread.id,
              holdId: `hold-${callbackDisposition}`,
            }),
            timestamp: Date.now(),
          };
        }
      }
      if (injectFreshnessMessage) {
        messageStore.append({
          userId: 'user-1',
          catId: null,
          threadId: thread.id,
          content: '生成期间到达的新要求',
          mentions: ['opus'],
          timestamp: Date.now(),
          deliveryStatus: 'queued',
        });
      }
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
    },
  };

  const sessionChainStore = new SessionChainStore();
  const activeSession = sessionChainStore.create({
    cliSessionId: 'cli-critical-route',
    threadId: thread.id,
    catId: 'opus',
    userId: 'user-1',
  });
  const sealRequests = [];
  const sealFinalizations = [];
  const transcriptEvents = [];
  const sessionSealer = {
    async requestSeal(args) {
      sealRequests.push(args);
      sessionChainStore.update(args.sessionId, { status: 'sealing', sealReason: args.reason });
      return { accepted: true, status: 'sealing', sessionId: args.sessionId };
    },
    async finalize(args) {
      sealFinalizations.push(args);
      sessionChainStore.update(args.sessionId, { status: 'sealed', sealedAt: Date.now() });
    },
  };
  const holdStore = new FreshnessHoldStore({ maxReviews: 2 });
  const freshnessGate = new FreshnessEgressGate({ messageStore, holdStore });
  const summaryThrough = historyMessages[7];
  const deps = {
    services: { opus: service },
    messageStore,
    deliveryCursorStore: {
      getCursor: async () => undefined,
      ackCursor: async () => {},
    },
    threadHistorySummaryStore: {
      listLatestByThread: async () => [
        {
          id: 'segment-critical-route',
          threadId: thread.id,
          fromMessageId: historyMessages[0].id,
          toMessageId: summaryThrough.id,
          messageCount: 8,
          summary:
            '范围：旧消息。当前状态：critical route 验证中。已确认决策/约束：仅成功发布可 seal。下一步：检查 memory 与 capsule。风险锚点：freshness verdict。',
          generatedAt: '2026-07-13T00:00:00.000Z',
          modelId: 'test-summary-model',
          promptVersion: 'history-critical-route-v1',
        },
      ],
    },
    ...(routeMode === 'freshness' ? { freshnessGate } : {}),
    invocationDeps: {
      registry: {
        async create() {
          return { invocationId: fixedInvocationId, callbackToken: `token-${fixedInvocationId}` };
        },
        async verify() {
          return { ok: false, reason: 'unused' };
        },
      },
      sessionManager: new SessionManager(),
      threadStore,
      sessionChainStore,
      sessionSealer,
      transcriptWriter: {
        appendEvent(session, event, invocationId) {
          transcriptEvents.push({ session, event, invocationId });
        },
      },
      apiUrl: 'http://127.0.0.1:3004',
    },
  };
  return {
    activeSession,
    callbackBody,
    current,
    deps,
    holdStore,
    messageStore,
    projectPath,
    sealFinalizations,
    sealRequests,
    thread,
    transcriptEvents,
  };
}

async function drainRoute(kind, harness, options = {}) {
  const route =
    kind === 'serial'
      ? (await import('../dist/domains/cats/services/agents/routing/route-serial.js')).routeSerial
      : (await import('../dist/domains/cats/services/agents/routing/route-parallel.js')).routeParallel;
  const yielded = [];
  for await (const message of route(harness.deps, ['opus'], CURRENT_REQUEST, 'user-1', harness.thread.id, {
    currentUserMessageId: harness.current.id,
    parentInvocationId: options.parentInvocationId,
  })) {
    yielded.push(message);
  }
  return yielded;
}

async function readOpusMemory(harness) {
  return readFile(join(harness.projectPath, '.cat-cafe', 'memory', 'opus.md'), 'utf-8');
}

describe('history critical route publication boundary', () => {
  for (const kind of ['serial', 'parallel']) {
    test(`${kind} seals only after an ordinary message is published`, async () => {
      const harness = await createCriticalHarness();
      setCriticalEnv(harness.thread.id);

      const yielded = await drainRoute(kind, harness);

      assert.equal(
        harness.sealRequests.length,
        1,
        `yielded=${JSON.stringify(yielded.map((message) => ({ type: message.type, content: message.content })))}`,
      );
      assert.equal(harness.sealRequests[0].reason, 'history_budget_critical');
      assert.equal(harness.sealFinalizations.length, 1);
      assert.match(await readOpusMemory(harness), /published stdout/);
      assert.ok(
        harness.transcriptEvents.some(({ event }) => parseSystemInfo(event)?.type === 'session_seal_requested'),
      );
      assert.ok(yielded.some((message) => parseSystemInfo(message)?.type === 'session_seal_requested'));
      assert.ok(yielded.some((message) => message.type === 'done'));
    });

    test(`${kind} writes the persisted callback body instead of stdout`, async () => {
      const harness = await createCriticalHarness({ callbackDisposition: 'published', output: 'STDOUT-MUST-NOT-WIN' });
      setCriticalEnv(harness.thread.id);

      const yielded = await drainRoute(kind, harness);
      const memory = await readOpusMemory(harness);

      assert.equal(harness.sealRequests.length, 1);
      assert.match(memory, new RegExp(harness.callbackBody));
      assert.doesNotMatch(memory, /STDOUT-MUST-NOT-WIN/);
      assert.ok(yielded.some((message) => parseSystemInfo(message)?.type === 'session_seal_requested'));
    });

    test(`${kind} defers memory and seal when the persisted callback body cannot be reloaded`, async () => {
      const harness = await createCriticalHarness({
        callbackDisposition: 'published',
        output: 'STDOUT-MUST-NOT-FALLBACK',
      });
      setCriticalEnv(harness.thread.id);
      const originalGetById = harness.messageStore.getById.bind(harness.messageStore);
      harness.messageStore.getById = (id) => {
        const message = originalGetById(id);
        if (message?.origin === 'callback') throw new Error('callback reload unavailable');
        return message;
      };

      const yielded = await drainRoute(kind, harness);

      assert.equal(harness.sealRequests.length, 0);
      await assert.rejects(readOpusMemory(harness), { code: 'ENOENT' });
      assert.ok(!yielded.some((message) => parseSystemInfo(message)?.type === 'session_seal_requested'));
      assert.ok(yielded.some((message) => message.type === 'done'));
    });

    test(`${kind} does not write memory or seal a freshness-held stdout draft`, async () => {
      const harness = await createCriticalHarness({ routeMode: 'freshness', injectFreshnessMessage: true });
      setCriticalEnv(harness.thread.id);

      const yielded = await drainRoute(kind, harness);

      assert.equal(harness.sealRequests.length, 0);
      await assert.rejects(readOpusMemory(harness), { code: 'ENOENT' });
      assert.ok(yielded.some((message) => parseSystemInfo(message)?.type === 'freshness_hold'));
      assert.ok(!yielded.some((message) => parseSystemInfo(message)?.type === 'session_seal_requested'));
    });

    for (const disposition of ['held', 'discarded', 'replayed']) {
      test(`${kind} does not write memory or seal a callback ${disposition} verdict`, async () => {
        const harness = await createCriticalHarness({ callbackDisposition: disposition });
        setCriticalEnv(harness.thread.id);

        const yielded = await drainRoute(kind, harness);

        assert.equal(harness.sealRequests.length, 0);
        await assert.rejects(readOpusMemory(harness), { code: 'ENOENT' });
        assert.ok(!yielded.some((message) => parseSystemInfo(message)?.type === 'session_seal_requested'));
      });
    }
  }

  for (const kind of ['serial', 'parallel']) {
    test(`${kind} reload failure uses published stdout fallback and still reaches done`, async () => {
      const harness = await createCriticalHarness({ output: 'FALLBACK-PUBLISHED-STDOUT' });
      setCriticalEnv(harness.thread.id);
      const originalGetById = harness.messageStore.getById.bind(harness.messageStore);
      harness.messageStore.getById = (id) => {
        const message = originalGetById(id);
        if (message?.catId === 'opus' && message.origin === 'stream') {
          throw new Error('published reload unavailable');
        }
        return message;
      };

      const yielded = await drainRoute(kind, harness);

      assert.equal(harness.sealRequests.length, 1);
      assert.match(await readOpusMemory(harness), /FALLBACK-PUBLISHED-STDOUT/);
      assert.ok(yielded.some((message) => message.type === 'done'));
    });

    test(`${kind} does not write memory or seal when publication append fails`, async () => {
      const harness = await createCriticalHarness({ output: 'APPEND-FAILURE-DRAFT' });
      setCriticalEnv(harness.thread.id);
      const originalAppend = harness.messageStore.append.bind(harness.messageStore);
      harness.messageStore.append = (message) => {
        if (message.catId === 'opus' && message.origin === 'stream') {
          throw new Error('publication append unavailable');
        }
        return originalAppend(message);
      };

      const yielded = await drainRoute(kind, harness);

      assert.equal(harness.sealRequests.length, 0);
      await assert.rejects(readOpusMemory(harness), { code: 'ENOENT' });
      assert.ok(!yielded.some((message) => parseSystemInfo(message)?.type === 'session_seal_requested'));
      assert.ok(yielded.some((message) => message.type === 'done'));
    });

    test(`${kind} ignores an idempotent freshness replay even when critical mode is enabled later`, async () => {
      const harness = await createCriticalHarness({ routeMode: 'freshness', fixedInvocationId: 'fixed-replay-inv' });
      setLegacyEnv();
      await drainRoute(kind, harness, { parentInvocationId: 'fixed-replay-parent' });
      setCriticalEnv(harness.thread.id);

      const yielded = await drainRoute(kind, harness, { parentInvocationId: 'fixed-replay-parent' });

      assert.equal(harness.sealRequests.length, 0);
      await assert.rejects(readOpusMemory(harness), { code: 'ENOENT' });
      assert.ok(!yielded.some((message) => parseSystemInfo(message)?.type === 'session_seal_requested'));
    });
  }
});
