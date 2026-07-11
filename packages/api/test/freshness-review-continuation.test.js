import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';
import './helpers/setup-cat-registry.js';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');

function reviewContext(overrides = {}) {
  return {
    holdId: 'hold-1',
    expectedVersion: 1,
    originalInvocationId: 'original-invocation',
    userId: 'user-1',
    catId: 'opus',
    threadId: 'thread-1',
    reviewCount: 0,
    status: 'held',
    draftContent: '基于旧上下文的草稿',
    deltaMessageIds: ['new-message-1'],
    ...overrides,
  };
}

function queueDeps(overrides = {}) {
  return {
    queue: new InvocationQueue(),
    invocationTracker: {
      start: mock.fn(() => new AbortController()),
      startAll: mock.fn(() => new AbortController()),
      complete: mock.fn(),
      completeAll: mock.fn(),
      has: mock.fn(() => false),
    },
    invocationRecordStore: {
      create: mock.fn(async () => ({ outcome: 'created', invocationId: `outer-${Date.now()}` })),
      update: mock.fn(async () => {}),
    },
    router: {
      routeExecution: mock.fn(async function* () {
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
      ackCollectedCursors: mock.fn(async () => {}),
    },
    socketManager: {
      broadcastAgentMessage: mock.fn(),
      broadcastToRoom: mock.fn(),
      emitToUser: mock.fn(),
    },
    messageStore: {
      append: mock.fn(async () => ({ id: 'message-1' })),
      getById: mock.fn(async (id) =>
        id === 'new-message-1'
          ? { id, userId: 'user-1', catId: null, content: '用户新要求', timestamp: Date.now(), mentions: ['opus'] }
          : null,
      ),
      markDelivered: mock.fn(async () => null),
    },
    log: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
    ...overrides,
  };
}

async function waitUntil(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('timed out waiting for async queue processing');
}

describe('freshness review continuation', () => {
  test('dedupes the same hold/version and refuses terminal or exhausted reviews', () => {
    const deps = queueDeps();
    const processor = new QueueProcessor(deps);

    const first = processor.enqueueFreshnessReview(reviewContext());
    const duplicate = processor.enqueueFreshnessReview(reviewContext());
    const exhausted = processor.enqueueFreshnessReview(reviewContext({ holdId: 'hold-2', reviewCount: 2 }));
    const terminal = processor.enqueueFreshnessReview(reviewContext({ holdId: 'hold-3', status: 'needs_attention' }));

    assert.equal(first.outcome, 'enqueued');
    assert.equal(duplicate.outcome, 'skipped_existing_entry');
    assert.equal(exhausted.outcome, 'skipped_review_limit');
    assert.equal(terminal.outcome, 'skipped_terminal');
    assert.equal(first.entry.sourceCategory, 'freshness_review');
    assert.equal(first.entry.priority, 'urgent');
    assert.deepEqual(first.entry.freshnessReview, {
      holdId: 'hold-1',
      expectedVersion: 1,
      originalInvocationId: 'original-invocation',
      userId: 'user-1',
      catId: 'opus',
      threadId: 'thread-1',
      reviewCount: 0,
      status: 'held',
    });
    const publicQueueJson = JSON.stringify(deps.queue.list('thread-1', 'user-1'));
    const queueUpdateJson = JSON.stringify(deps.socketManager.emitToUser.mock.calls[0].arguments[2]);
    assert.doesNotMatch(publicQueueJson, /基于旧上下文的草稿/);
    assert.doesNotMatch(publicQueueJson, /用户新要求/);
    assert.doesNotMatch(queueUpdateJson, /基于旧上下文的草稿/);
    assert.doesNotMatch(queueUpdateJson, /用户新要求/);
    assert.equal(deps.queue.list('thread-1', 'user-1').length, 1);
  });

  test('held output schedules only freshness review and does not hand its seal capsule to session continuation', async () => {
    const capsule = {
      v: 1,
      threadId: 'thread-1',
      catId: 'opus',
      invocationId: 'sealed-invocation',
      mode: 'independent',
      a2aEnabled: true,
      ballState: 'in_progress',
      continuationReason: 'threshold_seal',
      createdAt: Date.now(),
      seal: { sessionId: 'sealed-session', sessionSeq: 1, reason: 'threshold' },
    };
    const committedOutcomes = [];
    const deps = queueDeps({
      router: {
        routeExecution: mock.fn(async function* (_userId, _content, _threadId, _messageId, _targets, _intent, opts) {
          opts.persistenceContext.egressByCat = {
            opus: {
              disposition: 'held',
              holdId: 'hold-1',
              version: 1,
              reviewCount: 0,
              holdStatus: 'held',
              freshnessReview: reviewContext(),
            },
          };
          yield {
            type: 'system_info',
            catId: 'opus',
            content: JSON.stringify({ type: 'session_seal_requested', continuityCapsule: capsule }),
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
      sessionContinuationCoordinator: {
        prepareInvocationContext: mock.fn(async ({ content }) => ({ content })),
        commitInvocationOutcome: mock.fn(async (outcome) => {
          committedOutcomes.push({
            ...outcome,
            producedCapsules: [...outcome.producedCapsules],
          });
        }),
      },
    });
    const processor = new QueueProcessor(deps);
    const queued = deps.queue.enqueue({
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'start work',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
    });
    assert.equal(queued.outcome, 'enqueued');

    const status = await processor.executeEntry(queued.entry);

    assert.equal(status, 'succeeded');
    assert.deepEqual(
      deps.queue.list('thread-1', 'user-1').map((entry) => entry.sourceCategory),
      ['freshness_review'],
    );
    assert.equal(committedOutcomes.length, 1);
    assert.deepEqual(committedOutcomes[0].producedCapsules, []);
  });

  test('passes structured review context, requeues exactly the next version, then stops at needs_attention', async () => {
    const routeContexts = [];
    const deps = queueDeps({
      router: {
        routeExecution: mock.fn(async function* (_userId, _content, _threadId, _messageId, _targets, _intent, opts) {
          routeContexts.push(structuredClone(opts.persistenceContext.freshnessReview));
          const current = opts.persistenceContext.freshnessReview;
          opts.persistenceContext.egressByCat = {
            opus:
              current.expectedVersion === 1
                ? {
                    disposition: 'held',
                    holdId: current.holdId,
                    version: 3,
                    reviewCount: 1,
                    holdStatus: 'held',
                    freshnessReview: reviewContext({ expectedVersion: 3, reviewCount: 1 }),
                  }
                : {
                    disposition: 'held',
                    holdId: current.holdId,
                    version: 5,
                    reviewCount: 2,
                    holdStatus: 'needs_attention',
                    freshnessReview: reviewContext({
                      expectedVersion: 5,
                      reviewCount: 2,
                      status: 'needs_attention',
                    }),
                  },
          };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const processor = new QueueProcessor(deps);
    assert.equal(processor.enqueueFreshnessReview(reviewContext()).outcome, 'enqueued');

    await processor.tryAutoExecute('thread-1');
    await waitUntil(() => routeContexts.length === 2 && deps.queue.list('thread-1', 'user-1').length === 0);

    assert.deepEqual(
      routeContexts.map((context) => context.expectedVersion),
      [1, 3],
    );
    assert.match(routeContexts[0].deltaMessages[0].content, /用户新要求/);
    assert.equal(deps.router.routeExecution.mock.calls.length, 2, 'needs_attention must not schedule a third review');
  });

  test('mixed verdict finalizes the published stream instead of holding the whole invocation', async () => {
    const streamingHook = {
      onStreamStart: mock.fn(async () => {}),
      onStreamChunk: mock.fn(async () => {}),
      onStreamEnd: mock.fn(async () => {}),
      onStreamHold: mock.fn(async () => {}),
      cleanupPlaceholders: mock.fn(async () => {}),
    };
    const outboundHook = { deliver: mock.fn(async () => {}) };
    const deps = queueDeps({
      streamingHook,
      outboundHook,
      router: {
        routeExecution: mock.fn(async function* (_userId, _content, _threadId, _messageId, _targets, _intent, opts) {
          opts.persistenceContext.egressByCat = {
            opus: { disposition: 'published', messageId: 'published-opus' },
            codex: {
              disposition: 'held',
              holdId: 'held-codex',
              version: 1,
              reviewCount: 0,
              holdStatus: 'needs_attention',
            },
          };
          yield { type: 'text', catId: 'opus', content: '已发布回答', timestamp: Date.now() };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          yield { type: 'done', catId: 'codex', timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const processor = new QueueProcessor(deps);
    const queued = deps.queue.enqueue({
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'parallel',
      source: 'user',
      targetCats: ['opus', 'codex'],
      intent: 'ideate',
    });
    assert.equal(queued.outcome, 'enqueued');

    await processor.processNext('thread-1', 'user-1');
    await waitUntil(() => deps.queue.list('thread-1', 'user-1').length === 0);

    assert.equal(streamingHook.onStreamHold.mock.calls.length, 0);
    assert.equal(streamingHook.onStreamEnd.mock.calls.length, 1);
    assert.equal(outboundHook.deliver.mock.calls.length, 1);
    assert.equal(outboundHook.deliver.mock.calls[0].arguments[2], 'opus');
  });

  test('latest serial successor publishes stdout as the held message replacement', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { FreshnessHoldStore } = await import('../dist/domains/cats/services/stores/ports/FreshnessHoldStore.js');
    const { FreshnessEgressGate } = await import(
      '../dist/domains/cats/services/agents/freshness/FreshnessEgressGate.js'
    );
    const { freshnessPersistenceEgress } = await import(
      '../dist/domains/cats/services/agents/routing/route-helpers.js'
    );
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const messageStore = new MessageStore();
    const gate = new FreshnessEgressGate({
      messageStore,
      holdStore: new FreshnessHoldStore({ maxReviews: 2 }),
    });
    const baseline = await messageStore.captureFreshnessWatermark('thread-review-serial', {
      kind: 'cat',
      catId: 'opus',
    });
    const newer = await messageStore.append({
      userId: 'user-1',
      catId: null,
      threadId: 'thread-review-serial',
      content: '请把结论改成新版',
      mentions: ['opus'],
      deliveryStatus: 'queued',
      timestamp: Date.now(),
    });
    const held = await gate.submit({
      invocationId: 'original-serial-invocation',
      submissionKey: 'original-serial-output',
      userId: 'user-1',
      catId: 'opus',
      threadId: 'thread-review-serial',
      baselineWatermark: baseline,
      draft: {
        userId: 'user-1',
        catId: 'opus',
        threadId: 'thread-review-serial',
        content: '旧版结论',
        mentions: [],
        timestamp: Date.now(),
      },
    });
    assert.equal(held.outcome, 'held');
    const review = freshnessPersistenceEgress(held).freshnessReview;
    assert.ok(review);
    const latestChecks = [];
    let observedPrompt = '';
    const deps = {
      services: {
        opus: {
          async *invoke(prompt) {
            observedPrompt = prompt;
            yield { type: 'text', catId: 'opus', content: '新版完整结论', timestamp: Date.now() };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          },
        },
      },
      messageStore,
      freshnessGate: gate,
      invocationDeps: {
        registry: {
          async create() {
            return { invocationId: 'successor-serial-invocation', callbackToken: 'token' };
          },
          async isLatest(invocationId) {
            latestChecks.push(invocationId);
            return true;
          },
        },
        sessionManager: {
          get: async () => null,
          getOrCreate: async () => ({}),
          resolveWorkingDirectory: () => '/tmp/freshness-review-serial',
        },
        threadStore: null,
        apiUrl: 'http://127.0.0.1:3004',
      },
    };
    const persistenceContext = { failed: false, errors: [], freshnessReview: review };
    const yielded = [];
    for await (const message of routeSerial(
      deps,
      ['opus'],
      'Freshness review pending',
      'user-1',
      'thread-review-serial',
      { persistenceContext, parentInvocationId: 'outer-review-serial' },
    )) {
      yielded.push(message);
    }

    assert.deepEqual(latestChecks, ['successor-serial-invocation']);
    assert.match(observedPrompt, /旧版结论/);
    assert.match(observedPrompt, new RegExp(newer.id));
    assert.equal(persistenceContext.egressByCat.opus.disposition, 'published');
    assert.equal(
      messageStore.getRecent(20).filter((message) => message.catId === 'opus' && message.content === '新版完整结论')
        .length,
      1,
    );
    assert.equal(yielded.filter((message) => message.type === 'text' && message.textMode === 'replace').length, 1);
  });

  test('non-latest parallel successor cannot take over the held draft', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { FreshnessHoldStore } = await import('../dist/domains/cats/services/stores/ports/FreshnessHoldStore.js');
    const { FreshnessEgressGate } = await import(
      '../dist/domains/cats/services/agents/freshness/FreshnessEgressGate.js'
    );
    const { freshnessPersistenceEgress } = await import(
      '../dist/domains/cats/services/agents/routing/route-helpers.js'
    );
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const messageStore = new MessageStore();
    const holdStore = new FreshnessHoldStore({ maxReviews: 2 });
    const gate = new FreshnessEgressGate({ messageStore, holdStore });
    const threadId = 'thread-review-parallel';
    const baseline = await messageStore.captureFreshnessWatermark(threadId, { kind: 'cat', catId: 'opus' });
    await messageStore.append({
      userId: 'user-1',
      catId: null,
      threadId,
      content: '后到新消息',
      mentions: ['opus'],
      deliveryStatus: 'queued',
      timestamp: Date.now(),
    });
    const held = await gate.submit({
      invocationId: 'original-parallel-invocation',
      submissionKey: 'original-parallel-output',
      userId: 'user-1',
      catId: 'opus',
      threadId,
      baselineWatermark: baseline,
      draft: {
        userId: 'user-1',
        catId: 'opus',
        threadId,
        content: '并行旧稿',
        mentions: [],
        timestamp: Date.now(),
      },
    });
    assert.equal(held.outcome, 'held');
    const review = freshnessPersistenceEgress(held).freshnessReview;
    assert.ok(review);
    const deps = {
      services: {
        opus: {
          async *invoke() {
            yield { type: 'text', catId: 'opus', content: '不应发布的接管稿', timestamp: Date.now() };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          },
        },
      },
      messageStore,
      freshnessGate: gate,
      invocationDeps: {
        registry: {
          async create() {
            return { invocationId: 'stale-successor', callbackToken: 'token' };
          },
          async isLatest() {
            return false;
          },
        },
        sessionManager: {
          get: async () => null,
          getOrCreate: async () => ({}),
          resolveWorkingDirectory: () => '/tmp/freshness-review-parallel',
        },
        threadStore: null,
        apiUrl: 'http://127.0.0.1:3004',
      },
    };
    const persistenceContext = { failed: false, errors: [], freshnessReview: review };
    const yielded = [];
    for await (const message of routeParallel(deps, ['opus'], 'Freshness review pending', 'user-1', threadId, {
      persistenceContext,
      parentInvocationId: 'outer-review-parallel',
    })) {
      yielded.push(message);
    }

    assert.equal(persistenceContext.failed, true);
    assert.match(persistenceContext.errors[0].error, /not the latest invocation/);
    assert.equal((await holdStore.get(held.hold.id)).status, 'held');
    assert.equal(messageStore.getRecent(20).filter((message) => message.catId === 'opus').length, 0);
    assert.equal(yielded.filter((message) => message.type === 'text').length, 0);
  });
});
