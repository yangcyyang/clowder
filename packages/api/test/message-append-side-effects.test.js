import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('message append side effects', () => {
  test('message append listener advances thread activity from the message timestamp', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { createThreadActivityAppendListener } = await import(
      '../dist/domains/cats/services/stores/thread-activity-listener.js'
    );

    const threadStore = new ThreadStore();
    const thread = threadStore.create('user-1', 'Recent channel');
    threadStore.updateLastActive(thread.id, 100);

    const messageStore = new MessageStore({
      onAppend: createThreadActivityAppendListener({ threadStore }),
    });

    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'move this channel forward',
      mentions: [],
      timestamp: 200,
      threadId: thread.id,
    });

    assert.equal(threadStore.get(thread.id)?.lastActiveAt, 200);
  });
});
