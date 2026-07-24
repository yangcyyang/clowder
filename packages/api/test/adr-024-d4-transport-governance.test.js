/**
 * ADR-024 W2-C tests: D4 transport-product governance + §2.6 unified status bar.
 *
 * Coverage:
 *  ① v1 (default): evidence/coverageMap/navigationHeader/[Agent Inbox Snapshot] stay
 *     inline in contextText exactly as before (regression safety — byte layout unchanged).
 *  ② v2: those four move to the new `metaTransportText` field; contextText keeps only
 *     threadMemory/tombstone/anchors/burst (the deterministic append-only history set).
 *  ③ v2 budget-exhausted early-return paths still route nav+intent to metaTransportText.
 *  ④ formatInboxSnapshotSummary — compact "收件箱" line source.
 *  ⑤ §2.6 [Agent Status] bar: renders first inside META, format + omission rules.
 */

// @ts-check
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

const { assembleIncrementalContext, formatInboxSnapshotSummary } = await import(
  '../dist/domains/cats/services/agents/routing/route-helpers.js'
);
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { DeliveryCursorStore } = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');

function mockMsg(overrides) {
  const ts = overrides.timestamp ?? Date.now();
  return {
    threadId: overrides.threadId ?? 'thread-1',
    userId: overrides.userId ?? 'user-1',
    catId: overrides.catId ?? null,
    content: overrides.content ?? 'test message',
    mentions: overrides.mentions ?? [],
    timestamp: ts,
    origin: overrides.origin ?? undefined,
    toolEvents: overrides.toolEvents ?? undefined,
    extra: overrides.extra ?? undefined,
  };
}

function mockThreadStore(title, threadMemory) {
  return {
    get: async () => ({ id: 'thread-1', title, userId: 'user-1', createdAt: Date.now() }),
    create: async () => ({}),
    list: async () => [],
    listByProject: async () => [],
    addParticipants: async () => {},
    getParticipants: async () => [],
    getParticipantsWithActivity: async () => [],
    updateParticipantActivity: async () => {},
    updateLastActive: async () => {},
    getContextResetBoundary: async () => null,
    getThreadMemory: async () => threadMemory ?? null,
    updateThreadMemory: async () => {},
  };
}

function mockEvidenceStore(results) {
  return {
    search: async () =>
      results.map((r, i) => ({ anchor: `ev-${i}`, kind: 'thread', status: 'active', title: r.title, summary: r.summary, keywords: [] })),
    upsert: async () => {},
    deleteByAnchor: async () => {},
    getByAnchor: async () => null,
    health: async () => true,
    initialize: async () => {},
  };
}

function buildDeps(messageStore, deliveryCursorStore, options = {}) {
  return {
    services: {},
    invocationDeps: { threadStore: options.threadStore ?? null },
    messageStore,
    deliveryCursorStore,
    evidenceStore: options.evidenceStore ?? undefined,
  };
}

/** Seeds a cold-mention-triggering thread with a baton (@opus mention), evidence-worthy
 *  content, and returns the id of the last message (used as currentUserMessageId so
 *  [Agent Inbox Snapshot] is populated). */
function seedRichThread(messageStore) {
  const baseTs = Date.now() - 40 * 60_000;
  messageStore.append(
    mockMsg({
      content: 'Thread opener: ```js\nconst x = 1;\n``` important @opus discussion about Redis config',
      mentions: ['opus'],
      timestamp: baseTs,
    }),
  );
  for (let i = 1; i < 39; i++) {
    messageStore.append(mockMsg({ content: `msg ${i} about Redis config`, timestamp: baseTs + i * 60_000 }));
  }
  const last = messageStore.append(
    mockMsg({ content: '@opus 帮我看看这个方案', mentions: ['opus'], timestamp: baseTs + 39 * 60_000 }),
  );
  return last.id;
}

function buildRichDeps(messageStore, deliveryCursorStore) {
  return buildDeps(messageStore, deliveryCursorStore, {
    threadStore: mockThreadStore('Redis Migration', {
      v: 1,
      summary: 'Session #1: agreed on cluster mode.',
      sessionsIncorporated: 1,
      updatedAt: Date.now(),
    }),
    evidenceStore: mockEvidenceStore([{ title: 'ADR-005: Redis Key Prefix', summary: 'Decision on key prefixing' }]),
  });
}

describe('ADR-024 D4: transport-product governance (assembleIncrementalContext / assembleSmartWindowContext)', () => {
  const ORIGINAL_LAYOUT = process.env.CONTEXT_CACHE_LAYOUT;
  after(() => {
    if (ORIGINAL_LAYOUT === undefined) delete process.env.CONTEXT_CACHE_LAYOUT;
    else process.env.CONTEXT_CACHE_LAYOUT = ORIGINAL_LAYOUT;
  });

  test('① v1 (default): evidence/coverageMap/navigationHeader/inbox-snapshot stay inline in contextText (unchanged)', async () => {
    delete process.env.CONTEXT_CACHE_LAYOUT;
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const currentUserMessageId = seedRichThread(messageStore);
    const deps = buildRichDeps(messageStore, deliveryCursorStore);

    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', currentUserMessageId);

    assert.ok(result.contextText.includes('智能窗口'), 'should hit the smart-window (cold) path');
    assert.ok(result.contextText.includes('[Related evidence]'), 'v1: evidence stays inline in history');
    assert.ok(result.contextText.includes('[Context Coverage Map]'), 'v1: coverageMap stays inline in history');
    assert.ok(result.contextText.includes('[导航]'), 'v1: navigationHeader stays inline in history');
    assert.ok(result.contextText.includes('[Agent Inbox Snapshot]'), 'v1: inbox snapshot stays inline in history');
    assert.ok(!result.metaTransportText, 'v1: metaTransportText must be empty (nothing relocated)');
  });

  test('② v2: evidence/coverageMap/navigationHeader/inbox-snapshot move to metaTransportText; history keeps threadMemory/burst', async () => {
    process.env.CONTEXT_CACHE_LAYOUT = 'v2';
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const currentUserMessageId = seedRichThread(messageStore);
    const deps = buildRichDeps(messageStore, deliveryCursorStore);

    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', currentUserMessageId);

    assert.ok(result.contextText.includes('智能窗口'), 'should hit the smart-window (cold) path');
    // Relocated to meta:
    assert.ok(!result.contextText.includes('[Related evidence]'), 'v2: evidence must leave history');
    assert.ok(!result.contextText.includes('[Context Coverage Map]'), 'v2: coverageMap must leave history (evidence-contaminated retrievalHints)');
    assert.ok(!result.contextText.includes('[导航]'), 'v2: navigationHeader must leave history');
    assert.ok(!result.contextText.includes('[Agent Inbox Snapshot]'), 'v2: inbox snapshot must leave history');
    // Stayed in history (deterministic append-only):
    assert.ok(result.contextText.includes('[Thread Memory:'), 'v2: threadMemory stays in history (deterministic)');
    assert.ok(result.contextText.includes('Redis config'), 'v2: real burst history stays in place');

    assert.ok(result.metaTransportText, 'v2: metaTransportText must be populated');
    assert.ok(result.metaTransportText.includes('[Related evidence]'), 'meta carries evidence');
    assert.ok(result.metaTransportText.includes('[Context Coverage Map]'), 'meta carries coverageMap');
    assert.ok(result.metaTransportText.includes('[导航]'), 'meta carries navigationHeader');
    assert.ok(result.metaTransportText.includes('[Agent Inbox Snapshot]'), 'meta carries inbox snapshot');
    // And meta must NOT duplicate the deterministic history content.
    assert.ok(!result.metaTransportText.includes('[Thread Memory:'), 'meta does not duplicate threadMemory');
  });

  test('③ v2: budget-exhausted early return still routes nav+intent to metaTransportText, not contextText', async () => {
    process.env.CONTEXT_CACHE_LAYOUT = 'v2';
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const currentUserMessageId = seedRichThread(messageStore);
    const deps = buildRichDeps(messageStore, deliveryCursorStore);

    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', currentUserMessageId, undefined, {
      effectiveMaxContextTokens: 0,
    });

    assert.ok(!result.contextText.includes('[导航]'), 'v2 degraded path: nav excluded from contextText');
    assert.ok(!result.contextText.includes('[Agent Inbox Snapshot]'), 'v2 degraded path: inbox excluded from contextText');
    assert.ok(result.metaTransportText.includes('[导航]'), 'v2 degraded path: nav still reaches meta');
    assert.ok(result.metaTransportText.includes('[Agent Inbox Snapshot]'), 'v2 degraded path: inbox still reaches meta');
  });

  test('v1: budget-exhausted early return keeps legacy nav+intent inline in contextText', async () => {
    delete process.env.CONTEXT_CACHE_LAYOUT;
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const currentUserMessageId = seedRichThread(messageStore);
    const deps = buildRichDeps(messageStore, deliveryCursorStore);

    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', currentUserMessageId, undefined, {
      effectiveMaxContextTokens: 0,
    });

    assert.ok(result.contextText.includes('[导航]'), 'v1 degraded path: nav stays inline (unchanged)');
    assert.ok(!result.metaTransportText, 'v1: metaTransportText stays empty');
  });

  test('④ formatInboxSnapshotSummary: compact count summary for the §2.6 status bar', () => {
    assert.equal(formatInboxSnapshotSummary(undefined), '无');
    assert.equal(
      formatInboxSnapshotSummary({
        surface: 'thread',
        messageCount: 3,
        intentType: 'action',
        latestInstruction: 'go',
        supersededMessageIds: [],
        requiresTask: true,
        requiresUserConfirmation: false,
        toolPolicyHint: 'standard',
        recentMessages: [],
      }),
      '3 条 (action/待认领)',
    );
    assert.equal(
      formatInboxSnapshotSummary({
        surface: 'thread',
        messageCount: 1,
        intentType: 'stage-input',
        latestInstruction: 'draft',
        supersededMessageIds: [],
        requiresTask: false,
        requiresUserConfirmation: true,
        toolPolicyHint: 'full',
        recentMessages: [],
      }),
      '1 条 (stage-input/待确认)',
    );
  });
});

describe('ADR-024 §2.6: [Agent Status] unified status bar', () => {
  async function builder() {
    return import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
  }

  test('renders first inside META, right after META_BLOCK_HEADER', async () => {
    const { buildTurnMetaBlock, META_BLOCK_HEADER } = await builder();
    const meta = buildTurnMetaBlock({ catId: 'opus', mode: 'serial', teammates: [], mcpAvailable: true });
    const lines = meta.split('\n');
    assert.equal(lines[0], META_BLOCK_HEADER);
    assert.equal(lines[1], '[Agent Status]');
  });

  test('时间/模式 line always present; 模式 reflects mode + voiceMode', async () => {
    const { buildTurnMetaBlock } = await builder();
    const metaVoiceOn = buildTurnMetaBlock({
      catId: 'opus',
      mode: 'parallel',
      teammates: [],
      mcpAvailable: true,
      voiceMode: true,
    });
    assert.match(metaVoiceOn, /时间: \d{2}-\d{2} \d{2}:\d{2} · 模式: parallel\/voice-on/);

    const metaVoiceOff = buildTurnMetaBlock({ catId: 'opus', mode: 'independent', teammates: [], mcpAvailable: true });
    assert.match(metaVoiceOff, /模式: independent\/voice-off/);
  });

  test('上下文 line: shown with percentage when contextUsageWarning present, omitted otherwise', async () => {
    const { buildTurnMetaBlock } = await builder();
    const withWarning = buildTurnMetaBlock({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: true,
      contextUsageWarning: { ratio: 0.82, estimatedTokens: 82000, maxPromptTokens: 100000, level: 'high', action: 'memory-writeback' },
    });
    assert.ok(withWarning.includes('上下文: 82%（黄线 70%）'));

    const withoutWarning = buildTurnMetaBlock({ catId: 'opus', mode: 'independent', teammates: [], mcpAvailable: true });
    assert.ok(!withoutWarning.includes('上下文:'), '上下文 line must be omitted entirely when no warning fired');
  });

  test('任务门 line: "无" without threadId/currentUserMessageId, surface summary otherwise', async () => {
    const { buildTurnMetaBlock } = await builder();
    const noGate = buildTurnMetaBlock({ catId: 'opus', mode: 'independent', teammates: [], mcpAvailable: true });
    assert.ok(noGate.includes('任务门: 无'));

    const withGate = buildTurnMetaBlock({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: true,
      threadId: 'thread-9',
      currentUserMessageId: 'msg-9',
      currentTask: { id: 'task-1', parentThreadId: 'thread-parent', ownerCatId: 'opus', status: 'doing' },
    });
    assert.ok(withGate.includes('任务门: thread=thread-9 msg=msg-9 taskId=task-1 owner=opus status=doing'));
  });

  test('收件箱 line: renders "无" by default, or the pre-formatted extras summary', async () => {
    const { buildTurnMetaBlock } = await builder();
    const noExtras = buildTurnMetaBlock({ catId: 'opus', mode: 'independent', teammates: [], mcpAvailable: true });
    assert.ok(noExtras.includes('收件箱: 无'));

    const withExtras = buildTurnMetaBlock(
      { catId: 'opus', mode: 'independent', teammates: [], mcpAvailable: true },
      { inboxSnapshotSummary: '3 条 (action/待认领)' },
    );
    assert.ok(withExtras.includes('收件箱: 3 条 (action/待认领)'));
  });

  test('rest of turnMetaLines content (Task Gate full text / A2A source) still renders after the status bar', async () => {
    const { buildTurnMetaBlock } = await builder();
    const meta = buildTurnMetaBlock({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: true,
      threadId: 'thread-9',
      currentUserMessageId: 'msg-9',
    });
    const statusIdx = meta.indexOf('[Agent Status]');
    const taskGateIdx = meta.indexOf('## Clowder Task Gate（本轮动态）');
    assert.ok(statusIdx >= 0 && taskGateIdx > statusIdx, 'full Task Gate text still renders, after the status bar');
  });

  test('buildV2TransportDispatch threads inboxSnapshotSummary through to the meta slot', async () => {
    const { buildV2TransportDispatch } = await import(
      '../dist/domains/cats/services/agents/transport/build-v2-transport-dispatch.js'
    );
    const d = buildV2TransportDispatch({
      catId: 'opus',
      context: { catId: 'opus', mode: 'independent', teammates: [], mcpAvailable: true },
      staticIdentityOptions: { mcpAvailable: true, packBlocks: null, toolPolicy: 'standard' },
      historyText: 'H',
      userMsg: 'U',
      inboxSnapshotSummary: '2 条 (discussion/已读)',
    });
    assert.ok(d.transportPayload.meta.includes('收件箱: 2 条 (discussion/已读)'));
  });
});
