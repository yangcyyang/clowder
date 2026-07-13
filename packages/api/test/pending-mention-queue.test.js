import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');

describe('durable busy mention admission', () => {
  it('keeps distinct mentions for the same busy cat and exact-replay dedupes', async () => {
    const persisted = new Map();
    const queue = new InvocationQueue({
      async save(entry) {
        persisted.set(entry.id, structuredClone(entry));
      },
      async delete(id) {
        persisted.delete(id);
      },
      async list() {
        return [...persisted.values()];
      },
    });
    const deps = {
      router: {},
      invocationRecordStore: {},
      socketManager: { emitToUser: mock.fn(), broadcastAgentMessage: mock.fn() },
      invocationTracker: { has: mock.fn(() => true) },
      invocationQueue: queue,
      queueProcessor: { tryAutoExecute: mock.fn(async () => {}) },
      log: { info: mock.fn(), warn: mock.fn() },
    };
    const base = {
      targetCats: ['opus'],
      content: '@opus review',
      userId: 'user-1',
      threadId: 'thread-1',
      callerCatId: 'codex',
    };
    const trigger = (id) => ({
      id,
      userId: 'user-1',
      catId: 'codex',
      threadId: 'thread-1',
      content: '@opus review',
      mentions: ['opus'],
      timestamp: Date.now(),
    });

    await enqueueA2ATargets(deps, { ...base, triggerMessage: trigger('msg-1') });
    await enqueueA2ATargets(deps, { ...base, triggerMessage: trigger('msg-2') });
    await enqueueA2ATargets(deps, { ...base, triggerMessage: trigger('msg-1') });

    const entries = queue.list('thread-1', 'user-1');
    assert.equal(entries.length, 2, 'new mentions must not be dropped by per-cat coarse dedup');
    assert.equal(persisted.size, 2);
    assert.ok(entries.every((entry) => entry.expiresAt - entry.createdAt >= 7 * 24 * 60 * 60 * 1000 - 100));
    assert.equal(deps.queueProcessor.tryAutoExecute.mock.calls.length, 3);
  });
});
