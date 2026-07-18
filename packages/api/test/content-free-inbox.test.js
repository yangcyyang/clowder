import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildDeps, mockMsg } from './helpers/incremental-context-helpers.js';

const {
  assembleIncrementalContext,
  buildContentFreeInbox,
  decodeContentFreeInboxCursor,
  formatA2ATriggerPrompt,
  formatContentFreeInbox,
  selectUnreadMessagesForCat,
  selectExplicitPromptMessage,
  shouldAppendExplicitCurrentMessage,
} = await import('../dist/domains/cats/services/agents/routing/route-helpers.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { DeliveryCursorStore } = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');
const { estimateTokens } = await import('../dist/utils/token-counter.js');

describe('F004 Phase 2 content-free inbox', () => {
  test('shared selector excludes non-conversational and own-cat rows', () => {
    const rows = [
      mockMsg({ content: 'human' }),
      mockMsg({ catId: 'codex', content: 'agent' }),
      mockMsg({ catId: 'opus', content: 'own' }),
      mockMsg({ catId: 'codex', origin: 'progress', content: 'progress' }),
      mockMsg({ userId: 'system', content: 'system' }),
    ];

    assert.deepEqual(
      selectUnreadMessagesForCat(rows, 'opus', 'play').map((m) => m.content),
      ['human', 'agent'],
    );
  });

  test('debug-mode invocation context excludes a non-recipient whisper body', async () => {
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const secret = 'WHISPER-SECRET-DEBUG-VIEWER';
    const hidden = messageStore.append({
      ...mockMsg({ content: `@codex ${secret}` }),
      visibility: 'whisper',
      whisperTo: ['opus'],
    });
    const trigger = messageStore.append(mockMsg({ content: 'public follow-up for codex' }));
    const deps = buildDeps(messageStore, deliveryCursorStore);

    assert.deepEqual(
      selectUnreadMessagesForCat([hidden, trigger], 'codex', 'debug').map((message) => message.content),
      ['public follow-up for codex'],
    );

    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'codex', trigger.id, 'debug');

    assert.ok(result.contextText.includes('public follow-up for codex'));
    assert.ok(!result.contextText.includes(secret), 'non-recipient whisper reached the actual invocation context');
    assert.equal(result.currentMessageFilteredOut, false);
  });

  test('prompt is under 50 tokens and never contains message bodies', () => {
    const messageStore = new MessageStore();
    const rows = [
      messageStore.append(mockMsg({ content: 'TOP-SECRET-BODY-1' })),
      messageStore.append(mockMsg({ catId: 'codex', content: 'TOP-SECRET-BODY-2' })),
    ];
    const inbox = buildContentFreeInbox('thread-1', rows, { maxIds: 3 });
    const text = formatContentFreeInbox(inbox);

    assert.ok(estimateTokens(text) < 50, `expected <50 tokens, got ${estimateTokens(text)}: ${text}`);
    assert.ok(!text.includes('TOP-SECRET'));
    assert.equal(inbox.unreadCount, 2);
    assert.deepEqual(
      inbox.messageIds,
      rows.map((m) => m.id),
    );
  });

  test('production token estimator keeps CJK/emoji senders and longest IDs under 50 tokens', () => {
    const messageStore = new MessageStore();
    const base = messageStore.append(mockMsg({ content: '绝密正文🙂🚀' }));
    const rows = [
      {
        ...base,
        id: `0000000000000001-000001-${'a'.repeat(128)}`,
        userId: `超长中文发送者🙂${'甲'.repeat(80)}`,
      },
      {
        ...base,
        id: `0000000000000002-000001-${'b'.repeat(128)}`,
        userId: `第二位发送者🚀${'乙'.repeat(80)}`,
      },
    ];
    const text = formatContentFreeInbox(buildContentFreeInbox('thread-1', rows, { maxIds: 20 }));

    assert.ok(estimateTokens(text) < 50, `expected <50 tokens, got ${estimateTokens(text)}: ${text}`);
    assert.ok(!text.includes('绝密正文'));
  });

  test('paginates 0 / 1 / limit / limit+1 rows with a stable message-ID snapshot cursor', () => {
    const messageStore = new MessageStore();
    const rows = Array.from({ length: 4 }, (_, index) =>
      messageStore.append(mockMsg({ content: `body-${index}`, timestamp: Date.now() + index })),
    );

    const empty = buildContentFreeInbox('thread-1', [], { maxIds: 3 });
    assert.deepEqual(empty, {
      threadId: 'thread-1',
      unreadCount: 0,
      senders: [],
      messageIds: [],
      hasMore: false,
    });

    const one = buildContentFreeInbox('thread-1', rows.slice(0, 1), { maxIds: 3 });
    assert.deepEqual(one.messageIds, [rows[0].id]);
    assert.equal(one.hasMore, false);
    assert.equal(one.nextCursor, undefined);

    const atLimit = buildContentFreeInbox('thread-1', rows.slice(0, 3), { maxIds: 3 });
    assert.deepEqual(
      atLimit.messageIds,
      rows.slice(0, 3).map((row) => row.id),
    );
    assert.equal(atLimit.hasMore, false);

    const first = buildContentFreeInbox('thread-1', rows, { maxIds: 3 });
    assert.equal(first.unreadCount, 4);
    assert.deepEqual(
      first.messageIds,
      rows.slice(1).map((row) => row.id),
    );
    assert.equal(first.hasMore, true);
    assert.ok(first.nextCursor);

    const cursor = decodeContentFreeInboxCursor(first.nextCursor);
    assert.deepEqual(cursor, {
      snapshotMessageId: rows[3].id,
      beforeMessageId: rows[1].id,
    });

    const laterArrival = messageStore.append(mockMsg({ content: 'late-body', timestamp: Date.now() + 100 }));
    const second = buildContentFreeInbox('thread-1', [...rows, laterArrival], { maxIds: 3, cursor });
    assert.equal(second.unreadCount, 4, 'snapshot total must not drift when a later row arrives');
    assert.deepEqual(second.messageIds, [rows[0].id]);
    assert.equal(second.hasMore, false);
    assert.equal(second.nextCursor, undefined);
  });

  test('A2A formatter preserves normal sentinels and clamps pathological input at 8k tokens', () => {
    const normal = ['SENTINEL_HEAD', '甲乙🙂'.repeat(90), 'SENTINEL_MIDDLE', '丙丁🚀'.repeat(90), 'SENTINEL_TAIL'].join(
      '|',
    );
    const normalPrompt = formatA2ATriggerPrompt(normal, 'message-id-normal');
    assert.ok(normal.length > 500);
    assert.ok(normalPrompt.includes('SENTINEL_HEAD'));
    assert.ok(normalPrompt.includes('SENTINEL_MIDDLE'));
    assert.ok(normalPrompt.includes('SENTINEL_TAIL'));
    assert.equal(normalPrompt.split('SENTINEL_MIDDLE').length - 1, 1, 'normal body must be injected once');

    const pathological = `SENTINEL_PATH_HEAD-${'长正文🙂🚀'.repeat(12_000)}-SENTINEL_PATH_TAIL`;
    const clamped = formatA2ATriggerPrompt(pathological, 'message-id-pathological');
    assert.ok(estimateTokens(clamped) <= 8_000, `A2A prompt exceeded 8k: ${estimateTokens(clamped)}`);
    assert.ok(clamped.includes('SENTINEL_PATH_HEAD'));
    assert.ok(clamped.includes('SENTINEL_PATH_TAIL'));
    assert.ok(clamped.includes('[原文超限已截断，用 cat_cafe_fetch_thread_history 按 ID 取全文]'));
    assert.ok(clamped.includes('message-id-pathological'));
  });

  test('canary assembly suppresses raw fallback and excludes the A2A trigger from inbox metadata', async () => {
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    messageStore.append(mockMsg({ content: 'older-body' }));
    const trigger = messageStore.append(mockMsg({ catId: 'codex', content: 'A2A-FULL-BODY' }));
    const deps = buildDeps(messageStore, deliveryCursorStore);

    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', trigger.id, 'play', {
      contentFreeInboxEnabled: true,
      a2aTriggerMessageId: trigger.id,
    });

    assert.equal(result.contentFreeInbox?.unreadCount, 1);
    assert.ok(!result.contextText.includes('older-body'));
    assert.ok(!result.contextText.includes('A2A-FULL-BODY'));
    assert.equal(shouldAppendExplicitCurrentMessage(result, trigger.id), false);
    assert.equal(result.boundaryId, trigger.id);

    const fullTrigger = `SENTINEL_HEAD-${'x'.repeat(500)}-SENTINEL_MIDDLE-${'y'.repeat(500)}-SENTINEL_TAIL`;
    const explicit = selectExplicitPromptMessage(result, trigger.id, 'WRONG-ROUTE-LEVEL-MESSAGE', {
      directMessageFrom: 'codex',
      triggerMessageId: trigger.id,
      triggerContent: fullTrigger,
    });
    assert.ok(explicit.includes('SENTINEL_HEAD'));
    assert.ok(explicit.includes('SENTINEL_MIDDLE'));
    assert.ok(explicit.includes('SENTINEL_TAIL'));
    assert.ok(!explicit.includes('WRONG-ROUTE-LEVEL-MESSAGE'));
  });
});
