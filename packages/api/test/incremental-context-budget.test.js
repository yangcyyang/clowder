import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildDeps, mockMsg, seedMessages } from './helpers/incremental-context-helpers.js';

const { assembleIncrementalContext, buildAgentStageGate, buildRuntimeContextBudgetSnapshot } = await import(
  '../dist/domains/cats/services/agents/routing/route-helpers.js'
);
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { DeliveryCursorStore } = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');
const { getCatContextBudget } = await import('../dist/config/cat-budgets.js');

describe('assembleIncrementalContext — GAP-1 budget enforcement', () => {
  test('injects Agent Inbox Snapshot with latest correction intent', async () => {
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    messageStore.append(mockMsg({ content: '开始做这个 PPT Agent 改造' }));
    messageStore.append(mockMsg({ content: '等等，先别做，我们先讨论方案' }));
    const latest = messageStore.append(mockMsg({ content: '先给方案，我确认后再执行' }));

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', latest.id, 'play', {
      contextBudget: {
        maxPromptTokens: 180000,
        maxContextTokens: 2000,
        maxMessages: 10,
        maxContentLengthPerMsg: 1000,
      },
    });

    assert.ok(result.contextText.includes('[Agent Inbox Snapshot]'));
    assert.ok(result.contextText.includes('intentType: correction'));
    assert.ok(result.contextText.includes('latestInstruction: 先给方案，我确认后再执行'));
    assert.ok(result.contextText.includes('requiresTask: no'));
    assert.ok(result.contextText.includes('requiresUserConfirmation: yes'));
    assert.ok(result.contextText.includes('[Agent Stage Gate]'));
    assert.ok(result.contextText.includes('mode: hold-for-confirmation'));
    assert.ok(result.contextText.includes('supersededMessageIds:'));
    assert.equal(result.intentSnapshot?.intentType, 'correction');
    assert.equal(result.intentSnapshot?.latestMessageId, latest.id);
    assert.ok(result.intentSnapshot?.supersededMessageIds.length);
  });

  test('adds stage gate for stage-input messages and holds before execution', async () => {
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const latest = messageStore.append(mockMsg({ content: '大纲里增加一页竞品对比，然后调整章节顺序' }));

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', latest.id, 'play', {
      contextBudget: {
        maxPromptTokens: 180000,
        maxContextTokens: 2000,
        maxMessages: 10,
        maxContentLengthPerMsg: 1000,
      },
    });

    assert.equal(result.intentSnapshot?.intentType, 'stage-input');
    assert.equal(result.intentSnapshot?.requiresUserConfirmation, true);
    assert.equal(result.intentSnapshot?.stage, 'outline');
    assert.ok(result.contextText.includes('[Agent Stage Gate]'));
    assert.ok(result.contextText.includes('mode: hold-for-confirmation'));
    assert.ok(result.contextText.includes('Do not execute the next irreversible stage yet'));
  });

  test('stage gate resumes only after explicit approval intent', async () => {
    const gate = buildAgentStageGate({
      surface: 'thread',
      messageCount: 2,
      intentType: 'approval',
      latestInstruction: '确认',
      latestMessageId: 'msg-2',
      supersededMessageIds: [],
      requiresTask: false,
      requiresUserConfirmation: false,
      stage: 'plan',
      toolPolicyHint: 'minimal',
      recentMessages: [
        { id: 'msg-1', type: 'stage-input', content: '策划稿调整一下' },
        { id: 'msg-2', type: 'approval', content: '确认' },
      ],
    });

    assert.equal(gate?.mode, 'resume-after-approval');
    assert.equal(gate?.stage, 'plan');
  });

  test('keeps Agent Inbox Snapshot when effective context budget is zero', async () => {
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const latest = messageStore.append(mockMsg({ content: '帮我检查一下这个 thread 为什么不回复' }));

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', latest.id, 'play', {
      contextBudget: {
        maxPromptTokens: 180000,
        maxContextTokens: 0,
        maxMessages: 0,
        maxContentLengthPerMsg: 1000,
      },
      effectiveMaxContextTokens: 0,
    });

    assert.ok(result.contextText.includes('[Agent Inbox Snapshot]'));
    assert.ok(result.contextText.includes('intentType: action'));
    assert.ok(result.contextText.includes('requiresTask: yes'));
    assert.ok(!result.contextText.includes('[对话历史增量'), 'Zero budget should not include history block');
    assert.equal(result.degradation, undefined, 'Intentional minimal context should not warn as prompt exhaustion');
    assert.equal(result.includesCurrentUserMessage, false);
  });

  test('runtime context budget snapshot exposes governance tier diagnostics', async () => {
    const budget = getCatContextBudget('opus');
    const snapshot = buildRuntimeContextBudgetSnapshot({
      threadId: 'thread-1',
      toolPolicy: 'minimal',
      toolPolicySource: 'agent-default',
      mode: 'serial',
      prompt: 'hi',
      staticIdentity: 'identity',
      historyCount: 0,
      includedHistoryCount: 0,
      loadStandardContext: false,
      loadFullContext: false,
      hasPackBlocks: false,
      hasWorldContext: false,
      hasSessionBootstrap: false,
      hasSignalArticles: false,
      hasAlwaysOnDocs: false,
      hasSopHint: false,
      hasGuideContext: false,
      hasMcpInstructions: false,
      hasAgentMemory: false,
      hasLessonsContext: true,
      hasProjectContext: true,
      governanceTier: 'core',
      governanceEstimatedTokens: 120,
      hasGovernanceSourceContext: true,
      catBudget: budget,
    });

    assert.equal(snapshot.governanceTier, 'core');
    assert.equal(snapshot.governanceEstimatedTokens, 120);
    assert.equal(snapshot.governanceSourceInjected, true);
    assert.ok(snapshot.loadedBlocks.includes('governance-core'));
    assert.ok(snapshot.loadedBlocks.includes('governance-source'));
    assert.ok(snapshot.loadedBlocks.includes('lessons'));
    assert.ok(snapshot.loadedBlocks.includes('project-progress'));
  });

  test('caps messages to maxMessages when cursor is undefined (first-time cat)', async () => {
    const budget = getCatContextBudget('opus');
    const overCount = budget.maxMessages + 50;

    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const msgs = seedMessages(messageStore, overCount);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus');

    const deliveredCount = (result.contextText.match(/\[(\d{16}-\d{6}-[a-f0-9]{8})\]/g) || []).length;
    assert.ok(
      deliveredCount <= budget.maxMessages,
      `Expected at most ${budget.maxMessages} messages, got ${deliveredCount}`,
    );

    assert.ok(result.contextText.includes(msgs[msgs.length - 1].id), 'Should include the newest message');
    // F148 Phase C: msgs[0] may appear as primacy anchor [Thread opener: {id}].
    // Anchor format does NOT contain `[{id}]` (burst format), so this check is precise.
    const oldestInBurst = result.contextText.includes(`[${msgs[0].id}]`);
    assert.ok(
      !oldestInBurst,
      'Oldest message must not appear in burst format (may appear as [Thread opener: ...] anchor)',
    );
  });

  test('respects caller-supplied mature-secretary context budget', async () => {
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const msgs = seedMessages(messageStore, 10);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', undefined, 'play', {
      contextBudget: {
        maxPromptTokens: 180000,
        maxContextTokens: 2000,
        maxMessages: 5,
        maxContentLengthPerMsg: 1000,
      },
    });

    const deliveredCount = (result.contextText.match(/\[(\d{16}-\d{6}-[a-f0-9]{8})\]/g) || []).length;
    assert.ok(deliveredCount <= 5, `Expected caller budget to cap at 5 messages, got ${deliveredCount}`);
    assert.ok(result.contextText.includes(msgs[msgs.length - 1].id), 'Should keep newest message under caller budget');
  });

  test('caps messages when stale cursor produces large unseen batch', async () => {
    const budget = getCatContextBudget('opus');
    const totalCount = budget.maxMessages + 100;

    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const msgs = seedMessages(messageStore, totalCount);

    await deliveryCursorStore.ackCursor('user-1', 'opus', 'thread-1', msgs[9].id);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus');

    const deliveredCount = (result.contextText.match(/\[(\d{16}-\d{6}-[a-f0-9]{8})\]/g) || []).length;
    assert.ok(
      deliveredCount <= budget.maxMessages,
      `Stale cursor: expected at most ${budget.maxMessages} messages, got ${deliveredCount}`,
    );

    assert.ok(result.contextText.includes(msgs[msgs.length - 1].id), 'Should include the newest message');
  });

  test('includesCurrentUserMessage is based on capped set, not raw relevant', async () => {
    const budget = getCatContextBudget('opus');
    const overCount = budget.maxMessages + 50;

    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const msgs = seedMessages(messageStore, overCount);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const currentMsgId = msgs[msgs.length - 1].id;
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', currentMsgId);

    assert.equal(result.includesCurrentUserMessage, true, 'Current user message (newest) should be in capped set');
  });

  test('includesCurrentUserMessage is false when current msg is in oldest capped-off portion', async () => {
    const budget = getCatContextBudget('opus');
    const overCount = budget.maxMessages + 50;

    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const msgs = seedMessages(messageStore, overCount);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const oldMsgId = msgs[0].id;
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', oldMsgId);

    assert.equal(result.includesCurrentUserMessage, false, 'Old message capped off should not be reported as included');
  });

  test('does NOT truncate when message count is within budget (warm path)', async () => {
    // F148: use ≤15 to stay on warm path
    const withinCount = 10;
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    seedMessages(messageStore, withinCount);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus');

    const deliveredCount = (result.contextText.match(/\[(\d{16}-\d{6}-[a-f0-9]{8})\]/g) || []).length;
    assert.equal(deliveredCount, withinCount, `All ${withinCount} messages should be delivered without truncation`);
  });

  test('boundaryId is the last message in capped set', async () => {
    const budget = getCatContextBudget('opus');
    const overCount = budget.maxMessages + 50;

    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const msgs = seedMessages(messageStore, overCount);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus');

    assert.equal(result.boundaryId, msgs[msgs.length - 1].id, 'boundaryId should be the newest message ID');
  });

  test('currentMessageFilteredOut reflects visibility filtering, not budget cap', async () => {
    const budget = getCatContextBudget('opus');
    const overCount = budget.maxMessages + 50;

    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const msgs = seedMessages(messageStore, overCount);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const oldMsgId = msgs[0].id;
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', oldMsgId);

    assert.equal(
      result.currentMessageFilteredOut,
      false,
      'Budget cap should NOT set currentMessageFilteredOut (reserved for visibility/whisper filtering)',
    );
  });

  test('returns context when messages exceed budget', async () => {
    const budget = getCatContextBudget('opus');
    const overCount = budget.maxMessages + 50;

    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    seedMessages(messageStore, overCount);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus');

    // With F148: cold path activates (overCount > 15), burst + tombstone handles it.
    // Either warm-path degradation or cold-path smart window is acceptable.
    assert.ok(result.contextText.length > 0, 'Should produce context regardless of path');
  });

  test('no degradation when within budget', async () => {
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    seedMessages(messageStore, 10);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus');

    assert.ok(!result.degradation, 'Should NOT report degradation when within budget');
  });

  test('context header shows count info after cap', async () => {
    const budget = getCatContextBudget('opus');
    const overCount = budget.maxMessages + 50;

    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    seedMessages(messageStore, overCount);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus');

    // F148: cold path uses "智能窗口" header, warm path uses "未发送过 N 条" header
    const warmHeader = result.contextText.match(/未发送过 (\d+) 条/);
    const coldHeader = result.contextText.includes('智能窗口');
    assert.ok(warmHeader || coldHeader, 'Context should have warm or cold path header');
  });
});
