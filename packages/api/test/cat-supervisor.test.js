import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

const { CatSupervisor } = await import('../dist/infrastructure/cats/CatSupervisor.js');

function makeDeps() {
  return {
    redis: {
      set: mock.fn(async () => 'OK'),
    },
    socketManager: {
      emitToUser: mock.fn(),
    },
    log: {
      info: mock.fn(),
      warn: mock.fn(),
    },
  };
}

function catConfig(id) {
  return { id };
}

describe('CatSupervisor', () => {
  it('registers enabled cats as online idle and broadcasts status', async () => {
    const deps = makeDeps();
    const supervisor = new CatSupervisor({ ...deps, heartbeatMs: 60_000 });

    await supervisor.syncCats({ codex: catConfig('codex'), kimi: catConfig('kimi') });

    assert.equal(supervisor.getStatus('codex'), 'online_idle');
    assert.equal(supervisor.getStatus('kimi'), 'online_idle');
    assert.equal(deps.redis.set.mock.calls[0].arguments[0], 'cat:status:codex');
    assert.equal(deps.redis.set.mock.calls[0].arguments[1], 'online_idle');
    assert.equal(deps.socketManager.emitToUser.mock.calls[0].arguments[1], 'catStatusChange');
    assert.deepEqual(deps.socketManager.emitToUser.mock.calls[0].arguments[2].catId, 'codex');
  });

  it('moves processing cats back to online idle on completion', async () => {
    const deps = makeDeps();
    const supervisor = new CatSupervisor({ ...deps, processingTimeoutMs: 60_000 });
    await supervisor.syncCats({ codex: catConfig('codex') });

    await supervisor.markProcessing('codex');
    assert.equal(supervisor.getStatus('codex'), 'processing');

    await supervisor.markIdle('codex');
    assert.equal(supervisor.getStatus('codex'), 'online_idle');

    const statuses = deps.socketManager.emitToUser.mock.calls.map((call) => call.arguments[2].status);
    assert.deepEqual(statuses, ['online_idle', 'processing', 'online_idle']);
  });

  it('marks a long-running processing cat as timeout', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const deps = makeDeps();
    const supervisor = new CatSupervisor({ ...deps, processingTimeoutMs: 1_000 });
    await supervisor.syncCats({ codex: catConfig('codex') });

    await supervisor.markProcessing('codex');
    t.mock.timers.tick(1_000);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(supervisor.getStatus('codex'), 'timeout');
    const timeoutCall = deps.socketManager.emitToUser.mock.calls.find((call) => call.arguments[2].status === 'timeout');
    assert.ok(timeoutCall, 'timeout status should be broadcast');
  });
});
