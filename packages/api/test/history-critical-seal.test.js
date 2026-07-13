import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

const { finalizeHistoryCriticalPublication } = await import(
  '../dist/domains/cats/services/agents/invocation/HistoryCriticalSeal.js'
);
const { SessionManager } = await import('../dist/domains/cats/services/session/SessionManager.js');
const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
const { resetAgentMemoryAutoWriterForTests } = await import(
  '../dist/domains/cats/services/agents/memory/AgentMemoryAutoWriter.js'
);

const tempRoots = [];

afterEach(async () => {
  resetAgentMemoryAutoWriterForTests();
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function capsule(threadId, catId = 'codex') {
  return {
    v: 1,
    threadId,
    catId,
    mode: 'serial',
    a2aEnabled: false,
    ballState: 'in_progress',
    continuationReason: 'threshold_seal',
  };
}

function intent(watermark = 'msg-090') {
  return {
    reason: 'history_budget_critical',
    watermark,
    historyBudgetRatio: 0.9,
    criticalRatio: 0.9,
  };
}

async function setup(userId = 'user-1') {
  const projectPath = await mkdtemp(join(tmpdir(), 'clowder-critical-seal-'));
  tempRoots.push(projectPath);
  const threadStore = new ThreadStore();
  const thread = threadStore.create(userId, 'Critical seal', projectPath);
  const sessionChainStore = new SessionChainStore();
  const active = sessionChainStore.create({
    cliSessionId: 'cli-1',
    threadId: thread.id,
    catId: 'codex',
    userId,
  });
  return { projectPath, threadStore, thread, sessionChainStore, active };
}

describe('finalizeHistoryCriticalPublication', () => {
  test('writes memory, claims watermark, appends capsule, and awaits finalize in order', async () => {
    const state = await setup();
    const events = [];
    const deps = {
      threadStore: state.threadStore,
      sessionChainStore: state.sessionChainStore,
      sessionManager: new SessionManager(),
      sessionSealer: {
        async requestSeal() {
          events.push('request');
          const memory = await readFile(join(state.projectPath, '.cat-cafe', 'memory', 'codex.md'), 'utf-8');
          assert.match(memory, /critical reply/);
          return { accepted: true, status: 'sealing' };
        },
        async finalize() {
          events.push('finalize');
        },
      },
      transcriptWriter: {
        appendEvent(_session, event) {
          events.push('transcript');
          assert.match(event.content, /history_budget_critical/);
        },
      },
    };
    const originalDelete = deps.sessionManager.delete.bind(deps.sessionManager);
    deps.sessionManager.delete = async (...args) => {
      events.push('delete');
      return originalDelete(...args);
    };

    const result = await finalizeHistoryCriticalPublication({
      deps,
      intent: intent(),
      userId: 'user-1',
      catId: 'codex',
      threadId: state.thread.id,
      invocationId: 'inv-1',
      assistantText: 'critical reply',
      projectPath: state.projectPath,
      continuityCapsule: capsule(state.thread.id),
    });

    assert.deepEqual(events, ['request', 'delete', 'transcript', 'finalize']);
    assert.equal(JSON.parse(result.content).continuityCapsule.seal.reason, 'history_budget_critical');
    assert.equal(
      (await state.threadStore.claimHistoryCriticalSeal(state.thread.id, 'codex', 'msg-090')).claimed,
      false,
    );
  });

  test('consumes the watermark when a provider seal already removed the active session', async () => {
    const state = await setup();
    state.sessionChainStore.update(state.active.id, { status: 'sealed' });
    let requested = 0;
    const result = await finalizeHistoryCriticalPublication({
      deps: {
        threadStore: state.threadStore,
        sessionChainStore: state.sessionChainStore,
        sessionManager: new SessionManager(),
        sessionSealer: {
          async requestSeal() {
            requested += 1;
            return { accepted: true, status: 'sealing' };
          },
          async finalize() {},
        },
      },
      intent: intent(),
      userId: 'user-1',
      catId: 'codex',
      threadId: state.thread.id,
      assistantText: 'provider already sealed',
      projectPath: state.projectPath,
      continuityCapsule: capsule(state.thread.id),
    });
    assert.equal(result, null);
    assert.equal(requested, 0);
    assert.equal(
      (await state.threadStore.claimHistoryCriticalSeal(state.thread.id, 'codex', 'msg-090')).claimed,
      false,
    );
    assert.equal((await state.threadStore.claimHistoryCriticalSeal(state.thread.id, 'codex', 'msg-091')).claimed, true);
  });

  test('grants one seal request across concurrent publications with the same watermark', async () => {
    const state = await setup();
    let requested = 0;
    const deps = {
      threadStore: state.threadStore,
      sessionChainStore: state.sessionChainStore,
      sessionManager: new SessionManager(),
      sessionSealer: {
        async requestSeal() {
          requested += 1;
          return { accepted: true, status: 'sealing' };
        },
        async finalize() {},
      },
    };
    const results = await Promise.all(
      ['inv-concurrent-a', 'inv-concurrent-b'].map((invocationId) =>
        finalizeHistoryCriticalPublication({
          deps,
          intent: intent(),
          userId: 'user-1',
          catId: 'codex',
          threadId: state.thread.id,
          invocationId,
          assistantText: invocationId,
          projectPath: state.projectPath,
          continuityCapsule: capsule(state.thread.id),
        }),
      ),
    );
    assert.equal(requested, 1);
    assert.equal(results.filter(Boolean).length, 1);
  });

  test('rolls back on seal rejection and refuses a foreign active session', async () => {
    const state = await setup('foreign-user');
    let requested = 0;
    const deps = {
      threadStore: state.threadStore,
      sessionChainStore: state.sessionChainStore,
      sessionManager: new SessionManager(),
      sessionSealer: {
        async requestSeal() {
          requested += 1;
          return { accepted: false, status: 'sealed' };
        },
        async finalize() {},
      },
    };
    assert.equal(
      await finalizeHistoryCriticalPublication({
        deps,
        intent: intent(),
        userId: 'user-1',
        catId: 'codex',
        threadId: state.thread.id,
        assistantText: 'foreign session',
        projectPath: state.projectPath,
        continuityCapsule: capsule(state.thread.id),
      }),
      null,
    );
    assert.equal(requested, 0);
    assert.equal((await state.threadStore.claimHistoryCriticalSeal(state.thread.id, 'codex', 'msg-090')).claimed, true);

    const retryState = await setup('user-1');
    const retryDeps = {
      ...deps,
      threadStore: retryState.threadStore,
      sessionChainStore: retryState.sessionChainStore,
    };
    assert.equal(
      await finalizeHistoryCriticalPublication({
        deps: retryDeps,
        intent: intent('msg-091'),
        userId: 'user-1',
        catId: 'codex',
        threadId: retryState.thread.id,
        assistantText: 'seal rejected',
        projectPath: retryState.projectPath,
        continuityCapsule: capsule(retryState.thread.id),
      }),
      null,
    );
    assert.equal(requested, 1);
    assert.equal(
      (await retryState.threadStore.claimHistoryCriticalSeal(retryState.thread.id, 'codex', 'msg-091')).claimed,
      true,
    );
  });

  test('still returns the persisted capsule when finalization fails after acceptance', async () => {
    const state = await setup();
    const result = await finalizeHistoryCriticalPublication({
      deps: {
        threadStore: state.threadStore,
        sessionChainStore: state.sessionChainStore,
        sessionManager: {
          async delete() {
            throw new Error('resume cleanup failed');
          },
        },
        sessionSealer: {
          async requestSeal() {
            return { accepted: true, status: 'sealing' };
          },
          async finalize() {
            throw new Error('flush failed');
          },
        },
        transcriptWriter: {
          appendEvent() {
            throw new Error('append failed');
          },
        },
      },
      intent: intent(),
      userId: 'user-1',
      catId: 'codex',
      threadId: state.thread.id,
      assistantText: 'partial finalize',
      projectPath: state.projectPath,
      continuityCapsule: capsule(state.thread.id),
    });
    assert.match(result.content, /session_seal_requested/);
  });
});
