import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCatId } from '@cat-cafe/shared';

const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');
const { AgentRegistry } = await import('../dist/domains/cats/services/agents/registry/AgentRegistry.js');
const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');

function createHarness({ failDelete = false } = {}) {
  const chainStore = new SessionChainStore();
  const currentActive = chainStore.create({
    cliSessionId: 'current-active-cli',
    threadId: 'thread-reset',
    catId: createCatId('codex'),
    userId: 'current-user',
  });
  const currentSealed = chainStore.create({
    cliSessionId: 'current-sealed-cli',
    threadId: 'thread-reset',
    catId: createCatId('opus'),
    userId: 'current-user',
  });
  chainStore.update(currentSealed.id, { status: 'sealed' });
  const otherActive = chainStore.create({
    cliSessionId: 'other-active-cli',
    threadId: 'thread-reset',
    catId: createCatId('gemini'),
    userId: 'other-user',
  });
  const deleted = [];
  const sealCalls = [];
  const finalizeCalls = [];
  const sessionStore = {
    async deleteSession(userId, catId, threadId) {
      deleted.push({ userId, catId: String(catId), threadId });
      if (failDelete && String(catId) === 'codex') throw new Error('delete failed');
    },
  };
  const sessionSealer = {
    async requestSeal(input) {
      sealCalls.push(input);
      return { accepted: true };
    },
    async finalize(input) {
      finalizeCalls.push(input);
    },
  };
  const router = new AgentRouter({
    agentRegistry: new AgentRegistry(),
    registry: new InvocationRegistry(),
    messageStore: new MessageStore(),
    sessionStore,
    sessionChainStore: chainStore,
    sessionSealer,
  });
  return { router, currentActive, otherActive, deleted, sealCalls, finalizeCalls };
}

describe('AgentRouter.resetContextSessions', () => {
  it('clears only the current user pointers and seals only their active chain', async () => {
    const harness = createHarness();
    const result = await harness.router.resetContextSessions('current-user', 'thread-reset');

    assert.ok(result.cleared > 0);
    assert.ok(harness.deleted.every((entry) => entry.userId === 'current-user'));
    assert.deepEqual(harness.sealCalls, [{ sessionId: harness.currentActive.id, reason: 'context_reset' }]);
    assert.deepEqual(harness.finalizeCalls, [{ sessionId: harness.currentActive.id }]);
    assert.ok(!harness.sealCalls.some((call) => call.sessionId === harness.otherActive.id));
  });

  it('still seals the active chain when one resume-pointer delete fails', async () => {
    const harness = createHarness({ failDelete: true });
    await assert.rejects(
      harness.router.resetContextSessions('current-user', 'thread-reset'),
      /Context reset session cleanup failed/,
    );
    assert.deepEqual(harness.sealCalls, [{ sessionId: harness.currentActive.id, reason: 'context_reset' }]);
    assert.deepEqual(harness.finalizeCalls, [{ sessionId: harness.currentActive.id }]);
  });
});
