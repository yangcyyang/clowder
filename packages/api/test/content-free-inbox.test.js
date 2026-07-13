import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildDeps, mockMsg } from './helpers/incremental-context-helpers.js';

const {
  assembleIncrementalContext,
  buildContentFreeInbox,
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

  test('prompt is under 50 tokens and never contains message bodies', () => {
    const rows = [mockMsg({ content: 'TOP-SECRET-BODY-1' }), mockMsg({ catId: 'codex', content: 'TOP-SECRET-BODY-2' })];
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

    const fullTrigger = `HEAD-${'x'.repeat(500)}-TAIL`;
    assert.equal(
      selectExplicitPromptMessage(result, trigger.id, fullTrigger, {
        directMessageFrom: 'codex',
        triggerMessageId: trigger.id,
      }),
      fullTrigger,
    );
  });
});
