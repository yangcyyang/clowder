import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildDeps, mockMsg, seedMessages } from './helpers/incremental-context-helpers.js';

const {
  assembleIncrementalContext,
  __resetHistoryGovernanceDecisionStateForTests,
  buildAgentStageGate,
  buildHistoryGovernanceObservation,
  resolveHistoryGovernanceDecision,
  buildRuntimeContextBudgetSnapshot,
  estimateFullHistoryTokens,
} = await import('../dist/domains/cats/services/agents/routing/route-helpers.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { DeliveryCursorStore } = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');
const { getCatContextBudget } = await import('../dist/config/cat-budgets.js');

function structuredSummary(extra = '') {
  return [
    '范围：thread-1 历史消息已经压缩。',
    '当前状态：正在推进 Phase 3 历史治理。',
    '已确认决策/约束：summary-active 只允许 canary 线程启用。',
    '下一步：保留最近原文窗口并继续执行质量闸门。',
    '风险锚点：如果需要精确文件路径或用户原话，必须回看原文范围。',
    extra,
  ]
    .filter(Boolean)
    .join('\n');
}

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
      projectContextDeferred: false,
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

  test('runtime context budget snapshot exposes deferred project context', async () => {
    const budget = getCatContextBudget('opus');
    const snapshot = buildRuntimeContextBudgetSnapshot({
      threadId: 'thread-1',
      toolPolicy: 'standard',
      toolPolicySource: 'agent-default',
      mode: 'serial',
      prompt: '费曼解释一下 skill router',
      staticIdentity: 'identity',
      historyCount: 0,
      includedHistoryCount: 0,
      loadStandardContext: true,
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
      hasLessonsContext: false,
      hasProjectContext: false,
      projectContextDeferred: true,
      governanceTier: 'operational',
      governanceEstimatedTokens: 120,
      hasGovernanceSourceContext: false,
      catBudget: budget,
    });

    assert.ok(snapshot.loadedBlocks.includes('project-progress:on-demand'));
    assert.ok(snapshot.skippedBlocks.includes('project-progress'));
  });

  test('runtime context budget snapshot exposes observe-only history governance fields', async () => {
    const budget = getCatContextBudget('opus');
    const messageStore = new MessageStore();
    const seeded = seedMessages(messageStore, 3);
    messageStore.append(mockMsg({ userId: 'system', content: 'system notice must not count' }));

    const history = [...seeded, messageStore.getRecent(1, 'system')[0]].filter(Boolean);
    const historyFullTokens = estimateFullHistoryTokens(history);
    const historyObservation = buildHistoryGovernanceObservation({
      enabled: true,
      historyFullTokens,
      maxPromptTokens: budget.maxPromptTokens,
    });

    assert.ok(historyFullTokens > 0);
    assert.equal(historyObservation?.historyMode, 'observe');
    assert.equal(historyObservation?.historyFullTokens, historyFullTokens);

    const snapshot = buildRuntimeContextBudgetSnapshot({
      threadId: 'thread-1',
      toolPolicy: 'standard',
      toolPolicySource: 'agent-default',
      mode: 'serial',
      prompt: 'hi',
      staticIdentity: 'identity',
      historyCount: history.length,
      includedHistoryCount: 1,
      loadStandardContext: true,
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
      hasLessonsContext: false,
      hasProjectContext: false,
      projectContextDeferred: false,
      governanceTier: 'operational',
      governanceEstimatedTokens: 120,
      hasGovernanceSourceContext: false,
      catBudget: budget,
      historyObservation,
    });

    assert.equal(snapshot.historyMode, 'observe');
    assert.equal(snapshot.historyFullTokens, historyFullTokens);
    assert.equal(snapshot.historyBudgetRatio, historyFullTokens / budget.maxPromptTokens);
    assert.equal(snapshot.historyGovernanceDegraded, false);
    assert.equal(snapshot.historyMessages, 1, 'observe-only must not change included history count');
  });

  test('injects formatted thread history summary while keeping recent delivered messages', async () => {
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    messageStore.append(mockMsg({ content: 'old detail already summarized' }));
    const latest = messageStore.append(mockMsg({ content: 'recent instruction stays verbatim' }));

    const deps = buildDeps(messageStore, deliveryCursorStore);
    deps.threadHistorySummaryStore = {
      listLatestByThread: async (threadId) => {
        assert.equal(threadId, 'thread-1');
        return [
          {
            id: 'seg-001',
            threadId,
            fromMessageId: 'msg-001',
            toMessageId: 'msg-010',
            messageCount: 10,
            summary: '稳定事实：已经确认使用 summary_segments 做旧历史摘要。\n下一步：接入 formatter。',
            generatedAt: '2026-07-03T12:00:00.000Z',
            modelId: 'cheap-summary-model',
            promptVersion: 'history-v1',
          },
        ];
      },
    };

    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', latest.id, 'play', {
      contextBudget: {
        maxPromptTokens: 180000,
        maxContextTokens: 4000,
        maxMessages: 10,
        maxContentLengthPerMsg: 1000,
      },
      historySummaryEnabled: true,
    });

    assert.ok(result.contextText.includes('[Thread History Summary]'));
    assert.ok(result.contextText.includes('Scope: thread-1, messages msg-001..msg-010'));
    assert.ok(result.contextText.includes('This is a compressed, provenance-backed summary'));
    assert.ok(result.contextText.includes('需要精确引用、文件路径、命令输出或敏感凭据细节时'));
    assert.ok(result.contextText.includes('稳定事实：已经确认使用 summary_segments 做旧历史摘要。'));
    assert.ok(result.contextText.includes('[Recent Messages]'));
    assert.ok(result.contextText.includes('recent instruction stays verbatim'));
    assert.equal(result.historySummary?.segmentIds[0], 'seg-001');
    assert.ok(result.historySummary?.tokens && result.historySummary.tokens > 0);
  });

  test('keeps legacy context when thread history summary flag is off', async () => {
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const latest = messageStore.append(mockMsg({ content: 'recent message only' }));

    const deps = buildDeps(messageStore, deliveryCursorStore);
    deps.threadHistorySummaryStore = {
      listLatestByThread: async () => [
        {
          id: 'seg-off',
          threadId: 'thread-1',
          fromMessageId: 'msg-a',
          toMessageId: 'msg-b',
          messageCount: 2,
          summary: 'this summary must not be injected by default',
          generatedAt: '2026-07-03T12:00:00.000Z',
          modelId: 'cheap-summary-model',
          promptVersion: 'history-v1',
        },
      ],
    };

    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', latest.id, 'play', {
      contextBudget: {
        maxPromptTokens: 180000,
        maxContextTokens: 4000,
        maxMessages: 10,
        maxContentLengthPerMsg: 1000,
      },
      historySummaryEnabled: false,
    });

    assert.ok(!result.contextText.includes('[Thread History Summary]'));
    assert.equal(result.historySummary, undefined);
  });

  test('runtime context budget snapshot exposes shadow-summary diagnostics', () => {
    const budget = getCatContextBudget('opus');
    const snapshot = buildRuntimeContextBudgetSnapshot({
      threadId: 'thread-1',
      toolPolicy: 'standard',
      toolPolicySource: 'agent-default',
      mode: 'serial',
      prompt: 'hi',
      staticIdentity: 'identity',
      historyCount: 8,
      includedHistoryCount: 8,
      loadStandardContext: true,
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
      hasLessonsContext: false,
      hasProjectContext: false,
      projectContextDeferred: false,
      governanceTier: 'operational',
      governanceEstimatedTokens: 120,
      hasGovernanceSourceContext: false,
      catBudget: budget,
      historyObservation: {
        historyMode: 'observe',
        historyFullTokens: 12000,
        historyBudgetRatio: 0.5,
        historyGovernanceDegraded: false,
      },
      historySummary: {
        mode: 'shadow-summary',
        tokens: 320,
        segmentIds: ['seg-001'],
        messageCount: 10,
      },
    });

    assert.equal(snapshot.historyMode, 'shadow-summary');
    assert.equal(snapshot.historySummaryTokens, 320);
    assert.equal(snapshot.summarySegmentId, 'seg-001');
    assert.ok(snapshot.loadedBlocks.includes('history-summary'));
    assert.equal(snapshot.usesFullHistory, true, 'B1 shadow summary must keep full/recent history behavior unchanged');
  });

  test('summary-active canary keeps only a bounded recent window with summary provenance', async () => {
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const msgs = seedMessages(messageStore, 40);
    const latest = msgs[msgs.length - 1];

    const deps = buildDeps(messageStore, deliveryCursorStore);
    deps.threadHistorySummaryStore = {
      listLatestByThread: async () => [
        {
          id: 'seg-active',
          threadId: 'thread-1',
          fromMessageId: msgs[0].id,
          toMessageId: msgs[15].id,
          messageCount: 16,
          summary: structuredSummary('稳定事实：前 16 条消息已经归纳为可追溯摘要。'),
          generatedAt: '2026-07-03T12:00:00.000Z',
          modelId: 'cheap-summary-model',
          promptVersion: 'history-v1',
        },
      ],
    };

    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', latest.id, 'play', {
      contextBudget: {
        maxPromptTokens: 10000,
        maxContextTokens: 8000,
        maxMessages: 40,
        maxContentLengthPerMsg: 1000,
      },
      historyObservation: {
        historyMode: 'observe',
        historyFullTokens: 8500,
        historyBudgetRatio: 0.85,
        historyGovernanceDegraded: false,
      },
      historyGovernanceEnv: {
        CAT_CAFE_HISTORY_GOVERNANCE: 'summary-active',
        CAT_CAFE_HISTORY_GOVERNANCE_CANARY_THREADS: 'thread-1',
        CAT_CAFE_HISTORY_GOVERNANCE_ACTIVE_RATIO: '0.8',
        CAT_CAFE_HISTORY_GOVERNANCE_RECENT_MESSAGES: '12',
      },
    });

    const deliveredCount = (result.contextText.match(/\[(\d{16}-\d{6}-[a-f0-9]{8})\]/g) || []).length;
    assert.equal(result.historySummary?.mode, 'summary-active');
    assert.equal(result.historySummary?.segmentIds[0], 'seg-active');
    assert.equal(result.historySummary?.watermarkMessageId, msgs[15].id);
    assert.ok(result.contextText.includes('[Thread History Summary]'));
    assert.ok(result.contextText.includes('[History Recall Smoke]'));
    assert.ok(result.contextText.includes('[Recent Messages]'));
    assert.ok(result.contextText.includes(latest.id), 'current/latest user message must remain verbatim');
    assert.ok(!result.contextText.includes(`[${msgs[0].id}]`), 'oldest raw message must be replaced by summary');
    assert.ok(deliveredCount <= 12, `summary-active should cap recent raw messages, got ${deliveredCount}`);
    assert.equal(result.historyGovernanceDegraded, false);
  });

  test('summary-active rejects secret-like summaries and degrades without injecting them', async () => {
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const msgs = seedMessages(messageStore, 40);
    const latest = msgs[msgs.length - 1];

    const deps = buildDeps(messageStore, deliveryCursorStore);
    deps.threadHistorySummaryStore = {
      listLatestByThread: async () => [
        {
          id: 'seg-secret',
          threadId: 'thread-1',
          fromMessageId: msgs[0].id,
          toMessageId: msgs[15].id,
          messageCount: 16,
          summary: structuredSummary('风险锚点：ANTHROPIC_API_KEY=sk-ant-secret-value'),
          generatedAt: '2026-07-03T12:00:00.000Z',
          modelId: 'cheap-summary-model',
          promptVersion: 'history-v1',
        },
      ],
    };

    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', latest.id, 'play', {
      contextBudget: {
        maxPromptTokens: 10000,
        maxContextTokens: 8000,
        maxMessages: 40,
        maxContentLengthPerMsg: 1000,
      },
      historyObservation: {
        historyMode: 'observe',
        historyFullTokens: 8500,
        historyBudgetRatio: 0.85,
        historyGovernanceDegraded: false,
      },
      historyGovernanceEnv: {
        CAT_CAFE_HISTORY_GOVERNANCE: 'summary-active',
        CAT_CAFE_HISTORY_GOVERNANCE_CANARY_THREADS: 'thread-1',
        CAT_CAFE_HISTORY_GOVERNANCE_ACTIVE_RATIO: '0.8',
        CAT_CAFE_HISTORY_GOVERNANCE_RECENT_MESSAGES: '12',
      },
    });

    assert.equal(result.historySummary, undefined);
    assert.equal(result.historyGovernanceDegraded, true);
    assert.ok(!result.contextText.includes('[Thread History Summary]'));
    assert.ok(!result.contextText.includes('sk-ant-secret-value'));
  });

  test('summary-active rejects summaries that fail recall-smoke structure', async () => {
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const msgs = seedMessages(messageStore, 40);
    const latest = msgs[msgs.length - 1];

    const deps = buildDeps(messageStore, deliveryCursorStore);
    deps.threadHistorySummaryStore = {
      listLatestByThread: async () => [
        {
          id: 'seg-thin',
          threadId: 'thread-1',
          fromMessageId: msgs[0].id,
          toMessageId: msgs[15].id,
          messageCount: 16,
          summary: '稳定事实：只有一句泛泛而谈的摘要。',
          generatedAt: '2026-07-03T12:00:00.000Z',
          modelId: 'cheap-summary-model',
          promptVersion: 'history-v1',
        },
      ],
    };

    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', latest.id, 'play', {
      contextBudget: {
        maxPromptTokens: 10000,
        maxContextTokens: 8000,
        maxMessages: 40,
        maxContentLengthPerMsg: 1000,
      },
      historyObservation: {
        historyMode: 'observe',
        historyFullTokens: 8500,
        historyBudgetRatio: 0.85,
        historyGovernanceDegraded: false,
      },
      historyGovernanceEnv: {
        CAT_CAFE_HISTORY_GOVERNANCE: 'summary-active',
        CAT_CAFE_HISTORY_GOVERNANCE_CANARY_THREADS: 'thread-1',
      },
    });

    assert.equal(result.historySummary, undefined);
    assert.equal(result.historyGovernanceDegraded, true);
    assert.ok(!result.contextText.includes('[History Recall Smoke]'));
  });

  test('summary-active rejects summaries that overlap the recent window', async () => {
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const msgs = seedMessages(messageStore, 40);
    const latest = msgs[msgs.length - 1];

    const deps = buildDeps(messageStore, deliveryCursorStore);
    deps.threadHistorySummaryStore = {
      listLatestByThread: async () => [
        {
          id: 'seg-overlap',
          threadId: 'thread-1',
          fromMessageId: msgs[0].id,
          toMessageId: msgs[35].id,
          messageCount: 36,
          summary: structuredSummary(),
          generatedAt: '2026-07-03T12:00:00.000Z',
          modelId: 'cheap-summary-model',
          promptVersion: 'history-v1',
        },
      ],
    };

    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', latest.id, 'play', {
      contextBudget: {
        maxPromptTokens: 10000,
        maxContextTokens: 8000,
        maxMessages: 40,
        maxContentLengthPerMsg: 1000,
      },
      historyObservation: {
        historyMode: 'observe',
        historyFullTokens: 8500,
        historyBudgetRatio: 0.85,
        historyGovernanceDegraded: false,
      },
      historyGovernanceEnv: {
        CAT_CAFE_HISTORY_GOVERNANCE: 'summary-active',
        CAT_CAFE_HISTORY_GOVERNANCE_CANARY_THREADS: 'thread-1',
        CAT_CAFE_HISTORY_GOVERNANCE_RECENT_MESSAGES: '12',
      },
    });

    assert.equal(result.historySummary, undefined);
    assert.equal(result.historyGovernanceDegraded, true);
  });

  test('summary-active rejects summaries that are not smaller than full history', async () => {
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const msgs = seedMessages(messageStore, 40);
    const latest = msgs[msgs.length - 1];

    const deps = buildDeps(messageStore, deliveryCursorStore);
    deps.threadHistorySummaryStore = {
      listLatestByThread: async () => [
        {
          id: 'seg-bloat',
          threadId: 'thread-1',
          fromMessageId: msgs[0].id,
          toMessageId: msgs[15].id,
          messageCount: 16,
          summary: structuredSummary('稳定事实：这条摘要故意设置为比 full history 预算更贵。'),
          generatedAt: '2026-07-03T12:00:00.000Z',
          modelId: 'cheap-summary-model',
          promptVersion: 'history-v1',
        },
      ],
    };

    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', latest.id, 'play', {
      contextBudget: {
        maxPromptTokens: 10000,
        maxContextTokens: 8000,
        maxMessages: 40,
        maxContentLengthPerMsg: 1000,
      },
      historyObservation: {
        historyMode: 'observe',
        historyFullTokens: 10,
        historyBudgetRatio: 0.001,
        historyGovernanceDegraded: false,
      },
      historyGovernanceEnv: {
        CAT_CAFE_HISTORY_GOVERNANCE: 'summary-active',
        CAT_CAFE_HISTORY_GOVERNANCE_CANARY_THREADS: 'thread-1',
        CAT_CAFE_HISTORY_GOVERNANCE_ACTIVE_RATIO: '0.0001',
      },
    });

    assert.equal(result.historySummary, undefined);
    assert.equal(result.historyGovernanceDegraded, true);
    assert.ok(result.historyGovernanceQualityIssues?.includes('summary_token_bloat'));
    assert.ok(!result.contextText.includes('[Thread History Summary]'));
  });

  test('history governance kill switch disables summary injection without marking degraded', async () => {
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const msgs = seedMessages(messageStore, 40);
    const latest = msgs[msgs.length - 1];

    const deps = buildDeps(messageStore, deliveryCursorStore);
    deps.threadHistorySummaryStore = {
      listLatestByThread: async () => [
        {
          id: 'seg-disabled',
          threadId: 'thread-1',
          fromMessageId: msgs[0].id,
          toMessageId: msgs[15].id,
          messageCount: 16,
          summary: structuredSummary(),
          generatedAt: '2026-07-03T12:00:00.000Z',
          modelId: 'cheap-summary-model',
          promptVersion: 'history-v1',
        },
      ],
    };

    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', latest.id, 'play', {
      contextBudget: {
        maxPromptTokens: 10000,
        maxContextTokens: 8000,
        maxMessages: 40,
        maxContentLengthPerMsg: 1000,
      },
      historyObservation: {
        historyMode: 'observe',
        historyFullTokens: 8500,
        historyBudgetRatio: 0.85,
        historyGovernanceDegraded: false,
      },
      historySummaryEnabled: true,
      historyGovernanceEnv: {
        CAT_CAFE_HISTORY_GOVERNANCE: '0',
        CAT_CAFE_HISTORY_GOVERNANCE_CANARY_THREADS: 'thread-1',
      },
    });

    assert.equal(result.historySummary, undefined);
    assert.equal(result.historyGovernanceDegraded, false);
    assert.ok(!result.contextText.includes('[Thread History Summary]'));
  });

  test('summary-active degrades when a canary thread has no usable summary', async () => {
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const msgs = seedMessages(messageStore, 10);
    const latest = msgs[msgs.length - 1];

    const deps = buildDeps(messageStore, deliveryCursorStore);
    deps.threadHistorySummaryStore = {
      listLatestByThread: async () => [],
    };

    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', latest.id, 'play', {
      contextBudget: {
        maxPromptTokens: 10000,
        maxContextTokens: 8000,
        maxMessages: 40,
        maxContentLengthPerMsg: 1000,
      },
      historyObservation: {
        historyMode: 'observe',
        historyFullTokens: 8500,
        historyBudgetRatio: 0.85,
        historyGovernanceDegraded: false,
      },
      historyGovernanceEnv: {
        CAT_CAFE_HISTORY_GOVERNANCE: 'summary-active',
        CAT_CAFE_HISTORY_GOVERNANCE_CANARY_THREADS: 'thread-1',
        CAT_CAFE_HISTORY_GOVERNANCE_ACTIVE_RATIO: '0.8',
        CAT_CAFE_HISTORY_GOVERNANCE_RECENT_MESSAGES: '6',
      },
    });

    assert.equal(result.historySummary, undefined);
    assert.equal(result.historyGovernanceDegraded, true);
    assert.deepEqual(result.historyGovernanceQualityIssues, ['empty_summary']);
    assert.equal(result.includedHistoryCount, 10);
    assert.ok(result.contextText.includes(`[${msgs[0].id}]`), 'missing summary must fall back to raw history');
  });

  test('summary-active threshold is configurable and can stay in shadow below active ratio', () => {
    __resetHistoryGovernanceDecisionStateForTests();
    const decision = resolveHistoryGovernanceDecision({
      threadId: 'thread-1',
      catId: 'opus',
      summary: {
        mode: 'shadow-summary',
        text: '[Thread History Summary]\nsummary\n[/Thread History Summary]',
        tokens: 20,
        segmentIds: ['seg-001'],
        messageCount: 12,
        watermarkMessageId: 'm12',
      },
      historyObservation: {
        historyMode: 'observe',
        historyFullTokens: 8500,
        historyBudgetRatio: 0.85,
        historyGovernanceDegraded: false,
      },
      env: {
        CAT_CAFE_HISTORY_GOVERNANCE: 'summary-active',
        CAT_CAFE_HISTORY_GOVERNANCE_CANARY_THREADS: 'thread-1',
        CAT_CAFE_HISTORY_GOVERNANCE_ACTIVE_RATIO: '0.9',
      },
    });

    assert.equal(decision.mode, 'shadow-summary');
    assert.equal(decision.recentMessageLimit, undefined);
  });

  test('summary flag keeps B1 shadow formatter available without observe mode', () => {
    __resetHistoryGovernanceDecisionStateForTests();
    const decision = resolveHistoryGovernanceDecision({
      threadId: 'thread-shadow',
      catId: 'opus',
      summary: {
        mode: 'shadow-summary',
        text: '[Thread History Summary]\nsummary\n[/Thread History Summary]',
        tokens: 20,
        segmentIds: ['seg-shadow'],
        messageCount: 12,
        watermarkMessageId: 'm12',
      },
      env: {
        CAT_CAFE_HISTORY_GOVERNANCE_SUMMARY: '1',
      },
    });

    assert.equal(decision.mode, 'shadow-summary');
    assert.equal(decision.reason, 'shadow');
  });

  test('summary-active debounces until the summary watermark changes', () => {
    __resetHistoryGovernanceDecisionStateForTests();
    const env = {
      CAT_CAFE_HISTORY_GOVERNANCE: 'summary-active',
      CAT_CAFE_HISTORY_GOVERNANCE_CANARY_THREADS: 'thread-debounce',
      CAT_CAFE_HISTORY_GOVERNANCE_ACTIVE_RATIO: '0.8',
      CAT_CAFE_HISTORY_GOVERNANCE_RECENT_MESSAGES: '24',
    };
    const summary = {
      mode: 'shadow-summary',
      text: '[Thread History Summary]\nsummary\n[/Thread History Summary]',
      tokens: 20,
      segmentIds: ['seg-001'],
      messageCount: 20,
      watermarkMessageId: 'm20',
    };

    const first = resolveHistoryGovernanceDecision({
      threadId: 'thread-debounce',
      catId: 'opus',
      summary,
      historyObservation: {
        historyMode: 'observe',
        historyFullTokens: 8500,
        historyBudgetRatio: 0.85,
        historyGovernanceDegraded: false,
      },
      env,
    });
    const second = resolveHistoryGovernanceDecision({
      threadId: 'thread-debounce',
      catId: 'opus',
      summary,
      historyObservation: {
        historyMode: 'observe',
        historyFullTokens: 3000,
        historyBudgetRatio: 0.3,
        historyGovernanceDegraded: false,
      },
      env,
    });
    const changedWatermark = resolveHistoryGovernanceDecision({
      threadId: 'thread-debounce',
      catId: 'opus',
      summary: { ...summary, segmentIds: ['seg-002'], watermarkMessageId: 'm21' },
      historyObservation: {
        historyMode: 'observe',
        historyFullTokens: 3000,
        historyBudgetRatio: 0.3,
        historyGovernanceDegraded: false,
      },
      env,
    });

    assert.equal(first.mode, 'summary-active');
    assert.equal(first.reason, 'active-threshold');
    assert.equal(second.mode, 'summary-active');
    assert.equal(second.reason, 'active-debounce');
    assert.equal(second.recentMessageLimit, 24);
    assert.equal(changedWatermark.mode, 'shadow-summary');
  });

  test('history governance observation is absent when observe flag is off', () => {
    const observation = buildHistoryGovernanceObservation({
      enabled: false,
      historyFullTokens: 12000,
      maxPromptTokens: 30000,
    });

    assert.equal(observation, undefined);
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
