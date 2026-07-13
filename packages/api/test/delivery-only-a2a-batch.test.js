import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { migrateRouterOpts } from './helpers/agent-registry-helpers.js';

const DELIVERY_ONLY_ENV = 'CAT_CAFE_DELIVERY_ONLY_THREADS';
const CONTENT_FREE_ENV = 'CAT_CAFE_CONTENT_FREE_INBOX_THREADS';

function createCapturingService(catId, response = '收到') {
  const prompts = [];
  return {
    prompts,
    async *invoke(prompt) {
      prompts.push(prompt);
      yield { type: 'text', catId, content: response, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

function setDualCanary(threadId) {
  const previous = {
    deliveryOnly: process.env[DELIVERY_ONLY_ENV],
    contentFree: process.env[CONTENT_FREE_ENV],
  };
  process.env[DELIVERY_ONLY_ENV] = threadId;
  process.env[CONTENT_FREE_ENV] = threadId;
  return () => {
    if (previous.deliveryOnly === undefined) delete process.env[DELIVERY_ONLY_ENV];
    else process.env[DELIVERY_ONLY_ENV] = previous.deliveryOnly;
    if (previous.contentFree === undefined) delete process.env[CONTENT_FREE_ENV];
    else process.env[CONTENT_FREE_ENV] = previous.contentFree;
  };
}

function appendMessage(messageStore, threadId, content, overrides = {}) {
  return messageStore.append({
    threadId,
    userId: 'user-1',
    catId: null,
    content,
    mentions: [],
    timestamp: Date.now(),
    ...overrides,
  });
}

function seedHistory(messageStore, threadId) {
  const base = Date.now() - 60_000;
  return Array.from({ length: 20 }, (_, index) =>
    appendMessage(messageStore, threadId, `OLD_ANCHOR_${index} ${'历史细节'.repeat(80)} decision-${index}`, {
      timestamp: base + index * 1_000,
    }),
  );
}

function buildSummaryStore(threadId, history) {
  const summary = [
    `范围：${threadId} 的早期历史已压缩。`,
    '当前状态：正在验证 deliveryOnly 的 trigger、summary 与 anchors 合同。',
    '已确认决策/约束：完整 trigger 只出现一次；原文锚点最多三条。',
    '下一步：完成 A2A、batch 与 cursor 边界验收。',
    '风险锚点：需要精确原话时必须使用 cat_cafe_fetch_thread_history 按消息 ID 拉取。',
    'SUMMARY_REQUIRED_SENTINEL',
  ].join('\n');

  return {
    async listLatestByThread(actualThreadId) {
      assert.equal(actualThreadId, threadId);
      return [
        {
          id: `summary-${threadId}`,
          threadId,
          fromMessageId: history[0].id,
          toMessageId: history[15].id,
          messageCount: 16,
          summary,
          generatedAt: '2026-07-13T00:00:00.000Z',
          modelId: 'unit-test-summary-model',
          promptVersion: 'history-v1',
        },
      ];
    },
  };
}

async function createRouter({ messageStore, service, summaryStore, deliveryCursorStore }) {
  const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');
  const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
  return new AgentRouter(
    await migrateRouterOpts({
      claudeService: createCapturingService('opus', 'unused'),
      codexService: service,
      geminiService: createCapturingService('gemini', 'unused'),
      registry: new InvocationRegistry(),
      messageStore,
      threadHistorySummaryStore: summaryStore,
      ...(deliveryCursorStore ? { deliveryCursorStore } : {}),
    }),
  );
}

async function drainRoute(router, { userId = 'user-1', message, threadId, messageId, options = {} }) {
  for await (const _event of router.routeExecution(
    userId,
    message,
    threadId,
    messageId,
    ['codex'],
    { intent: 'execute', explicit: true, promptTags: [] },
    options,
  )) {
    // Drain the complete route so deferred cursor boundaries are collected.
  }
}

describe('F004 deliveryOnly — A2A, batch payload and cursor boundaries', () => {
  test('ordinary user route keeps content-free precedence when both canary flags match', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const threadId = 'thread-delivery-only-dual-user';
    const messageStore = new MessageStore();
    const history = seedHistory(messageStore, threadId);
    const current = appendMessage(messageStore, threadId, 'ORDINARY_DUAL_FLAG_TRIGGER');
    const service = createCapturingService('codex');
    const restoreEnv = setDualCanary(threadId);

    try {
      const router = await createRouter({
        messageStore,
        service,
        summaryStore: buildSummaryStore(threadId, history),
      });
      await drainRoute(router, {
        message: current.content,
        threadId,
        messageId: current.id,
      });

      assert.equal(service.prompts.length, 1);
      const prompt = service.prompts[0];
      assert.ok(prompt.includes('[Inbox] unread='), 'ordinary dual-flag route must stay content-free');
      assert.ok(!prompt.includes('ORDINARY_DUAL_FLAG_TRIGGER'), 'content-free precedence must not leak trigger body');
      assert.ok(
        !prompt.includes('SUMMARY_REQUIRED_SENTINEL'),
        'content-free precedence must skip deliveryOnly summary',
      );
    } finally {
      restoreEnv();
    }
  });

  test('full batch route payload appears once; later batch rows are not replayed as anchors; ack stays deferred', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { formatMessageEnvelopeBatch } = await import(
      '../dist/domains/cats/services/agents/invocation/QueueProcessor.js'
    );
    const threadId = 'thread-delivery-only-batch';
    const messageStore = new MessageStore();
    const history = seedHistory(messageStore, threadId);
    const first = appendMessage(messageStore, threadId, 'BATCH_FIRST_SENTINEL');
    const second = appendMessage(messageStore, threadId, 'BATCH_SECOND_SENTINEL');
    const third = appendMessage(messageStore, threadId, 'BATCH_THIRD_SENTINEL');
    const routePayload = formatMessageEnvelopeBatch(
      [first, second, third].map((message) => ({
        messageId: message.id,
        senderType: 'user',
        content: message.content,
        mentions: ['codex'],
        timestamp: message.timestamp,
      })),
    );
    const service = createCapturingService('codex');
    const ackCalls = [];
    const deliveryCursorStore = {
      async getCursor() {
        return undefined;
      },
      async ackCursor(userId, catId, actualThreadId, boundaryId) {
        ackCalls.push({ userId, catId, threadId: actualThreadId, boundaryId });
      },
    };
    const cursorBoundaries = new Map();
    const previousDeliveryOnly = process.env[DELIVERY_ONLY_ENV];
    process.env[DELIVERY_ONLY_ENV] = threadId;

    try {
      const router = await createRouter({
        messageStore,
        service,
        summaryStore: buildSummaryStore(threadId, history),
        deliveryCursorStore,
      });
      await drainRoute(router, {
        message: routePayload,
        threadId,
        // QueueProcessor intentionally passes the first batch message ID only.
        messageId: first.id,
        options: { cursorBoundaries },
      });

      assert.equal(service.prompts.length, 1);
      const prompt = service.prompts[0];
      assert.ok(prompt.includes('SUMMARY_REQUIRED_SENTINEL'), 'deliveryOnly summary is mandatory');
      for (const sentinel of ['BATCH_FIRST_SENTINEL', 'BATCH_SECOND_SENTINEL', 'BATCH_THIRD_SENTINEL']) {
        assert.equal(countOccurrences(prompt, sentinel), 1, `${sentinel} must appear exactly once from route payload`);
      }
      const rawAnchorCount = new Set(prompt.match(/OLD_ANCHOR_\d+/g) ?? []).size;
      assert.ok(rawAnchorCount <= 3, `deliveryOnly must include at most 3 raw anchors, got ${rawAnchorCount}`);
      assert.equal(ackCalls.length, 0, 'route assembly must not ack the cursor before caller success');
      assert.equal(
        cursorBoundaries.get('codex'),
        third.id,
        'successful batch must preserve the existing deferred boundary through the final delivered row',
      );

      await router.ackCollectedCursors('user-1', threadId, cursorBoundaries);
      assert.deepEqual(ackCalls, [{ userId: 'user-1', catId: 'codex', threadId, boundaryId: third.id }]);
    } finally {
      if (previousDeliveryOnly === undefined) delete process.env[DELIVERY_ONLY_ENV];
      else process.env[DELIVERY_ONLY_ENV] = previousDeliveryOnly;
    }
  });

  test('A2A direct route overrides content-free, keeps >500-char stored trigger verbatim, and requires summary', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const threadId = 'thread-delivery-only-a2a-full';
    const messageStore = new MessageStore();
    const history = seedHistory(messageStore, threadId);
    const triggerBody = [
      'A2A_FULL_HEAD',
      '甲乙🙂'.repeat(90),
      'A2A_FULL_MIDDLE',
      '丙丁🚀'.repeat(90),
      'A2A_FULL_TAIL',
    ].join('|');
    assert.ok(triggerBody.length > 500);
    const trigger = appendMessage(messageStore, threadId, triggerBody, { catId: 'opus' });
    const service = createCapturingService('codex');
    const restoreEnv = setDualCanary(threadId);

    try {
      const router = await createRouter({
        messageStore,
        service,
        summaryStore: buildSummaryStore(threadId, history),
      });
      await drainRoute(router, {
        // The real direct-A2A queue route passes the complete trigger as the route payload.
        // deliveryOnly must preserve that payload rather than performing a second MessageStore read.
        message: triggerBody,
        threadId,
        messageId: trigger.id,
        options: { directMessageFrom: 'opus', a2aTriggerMessageId: trigger.id },
      });

      assert.equal(service.prompts.length, 1);
      const prompt = service.prompts[0];
      assert.ok(prompt.includes('SUMMARY_REQUIRED_SENTINEL'), 'A2A deliveryOnly must retain mandatory summary');
      assert.ok(prompt.includes('A2A_FULL_HEAD'));
      assert.ok(prompt.includes('A2A_FULL_MIDDLE'));
      assert.ok(prompt.includes('A2A_FULL_TAIL'));
      assert.equal(countOccurrences(prompt, 'A2A_FULL_MIDDLE'), 1, 'stored A2A trigger must be injected once');
      assert.ok(!prompt.includes('原文超限已截断'), 'normal >500-char A2A trigger must remain verbatim');
    } finally {
      restoreEnv();
    }
  });

  test('pathological A2A trigger is clamped near 8k tokens with both ends and pull-by-ID recovery hint', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { estimateTokens } = await import('../dist/utils/token-counter.js');
    const threadId = 'thread-delivery-only-a2a-clamp';
    const messageStore = new MessageStore();
    const history = seedHistory(messageStore, threadId);
    const triggerBody = [
      'A2A_PATHOLOGICAL_HEAD',
      'segment-a '.repeat(2_250),
      'A2A_PATHOLOGICAL_MIDDLE_MUST_DROP',
      'segment-b '.repeat(2_250),
      'A2A_PATHOLOGICAL_TAIL',
    ].join('|');
    assert.ok(estimateTokens(triggerBody) > 8_000, 'fixture must exceed the A2A trigger token clamp');
    const trigger = appendMessage(messageStore, threadId, triggerBody, { catId: 'opus' });
    const service = createCapturingService('codex');
    const restoreEnv = setDualCanary(threadId);

    try {
      const router = await createRouter({
        messageStore,
        service,
        summaryStore: buildSummaryStore(threadId, history),
      });
      await drainRoute(router, {
        message: triggerBody,
        threadId,
        messageId: trigger.id,
        options: { directMessageFrom: 'opus', a2aTriggerMessageId: trigger.id },
      });

      assert.equal(service.prompts.length, 1);
      const prompt = service.prompts[0];
      assert.ok(prompt.includes('SUMMARY_REQUIRED_SENTINEL'));
      assert.ok(prompt.includes('A2A_PATHOLOGICAL_HEAD'));
      assert.ok(prompt.includes('A2A_PATHOLOGICAL_TAIL'));
      assert.ok(!prompt.includes('A2A_PATHOLOGICAL_MIDDLE_MUST_DROP'));
      assert.ok(prompt.includes('原文超限已截断'));
      assert.ok(prompt.includes('cat_cafe_fetch_thread_history'));
      assert.ok(prompt.includes(trigger.id), 'recovery hint must remain bound to the exact stored trigger ID');
    } finally {
      restoreEnv();
    }
  });

  test('direct A2A batch uses the complete route payload once instead of replacing it with the stored first row', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { formatMessageEnvelopeBatch } = await import(
      '../dist/domains/cats/services/agents/invocation/QueueProcessor.js'
    );
    const threadId = 'thread-delivery-only-a2a-batch';
    const messageStore = new MessageStore();
    const history = seedHistory(messageStore, threadId);
    const first = appendMessage(messageStore, threadId, 'A2A_BATCH_FIRST_SENTINEL', { catId: 'opus' });
    const second = appendMessage(messageStore, threadId, 'A2A_BATCH_SECOND_SENTINEL', { catId: 'opus' });
    const third = appendMessage(messageStore, threadId, 'A2A_BATCH_THIRD_SENTINEL', { catId: 'opus' });
    const routePayload = formatMessageEnvelopeBatch(
      [first, second, third].map((message) => ({
        messageId: message.id,
        senderType: 'agent',
        content: message.content,
        mentions: ['codex'],
        timestamp: message.timestamp,
      })),
    );
    const service = createCapturingService('codex');
    const restoreEnv = setDualCanary(threadId);

    try {
      const router = await createRouter({
        messageStore,
        service,
        summaryStore: buildSummaryStore(threadId, history),
      });
      await drainRoute(router, {
        message: routePayload,
        threadId,
        // Only the first ID is available on RouteOptions; the complete batch lives in `message`.
        messageId: first.id,
        options: { directMessageFrom: 'opus', a2aTriggerMessageId: first.id },
      });

      assert.equal(service.prompts.length, 1);
      const prompt = service.prompts[0];
      assert.ok(prompt.includes('SUMMARY_REQUIRED_SENTINEL'));
      for (const sentinel of ['A2A_BATCH_FIRST_SENTINEL', 'A2A_BATCH_SECOND_SENTINEL', 'A2A_BATCH_THIRD_SENTINEL']) {
        assert.equal(countOccurrences(prompt, sentinel), 1, `${sentinel} must survive the route payload exactly once`);
      }
    } finally {
      restoreEnv();
    }
  });
});
