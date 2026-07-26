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

  it('跨视图感知修复: markProcessing(catIds, threadId) 让 catStatusChange 携带 threadId,markIdle 后清除关联', async () => {
    const deps = makeDeps();
    const supervisor = new CatSupervisor({ ...deps, processingTimeoutMs: 60_000 });
    await supervisor.syncCats({ codex: catConfig('codex') });

    await supervisor.markProcessing('codex', 'thread-branch-1');
    const processingCall = deps.socketManager.emitToUser.mock.calls.find(
      (call) => call.arguments[2].status === 'processing',
    );
    assert.equal(processingCall.arguments[2].threadId, 'thread-branch-1');

    await supervisor.markIdle('codex');
    const idleCalls = deps.socketManager.emitToUser.mock.calls.filter((call) => call.arguments[2].status === 'online_idle');
    // idle 事件仍带上"最后已知" threadId(方便前端归因到具体分支后再清灯)
    assert.equal(idleCalls.at(-1).arguments[2].threadId, 'thread-branch-1');

    // 再次 markProcessing 不传 threadId 时不应该带上任何残留的旧 threadId
    await supervisor.markProcessing('codex');
    const secondProcessingCall = deps.socketManager.emitToUser.mock.calls
      .filter((call) => call.arguments[2].status === 'processing')
      .at(-1);
    assert.equal(secondProcessingCall.arguments[2].threadId, undefined);
  });

  it('跨视图感知修复: 不传 threadId 时 catStatusChange 载荷里没有 threadId 字段(向后兼容)', async () => {
    const deps = makeDeps();
    const supervisor = new CatSupervisor({ ...deps, processingTimeoutMs: 60_000 });
    await supervisor.syncCats({ codex: catConfig('codex') });

    await supervisor.markProcessing('codex');
    const processingCall = deps.socketManager.emitToUser.mock.calls.find(
      (call) => call.arguments[2].status === 'processing',
    );
    assert.equal('threadId' in processingCall.arguments[2], false);
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

  it('keeps legacy flat timeout behavior when only processingTimeoutMs is configured', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const deps = makeDeps();
    const supervisor = new CatSupervisor({ ...deps, processingTimeoutMs: 1_000 });
    await supervisor.syncCats({ codex: catConfig('codex') });

    await supervisor.markProcessing('codex');
    t.mock.timers.tick(500);
    await supervisor.markOutput('codex');
    t.mock.timers.tick(500);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(supervisor.getStatus('codex'), 'timeout');
  });

  it('marks processing cats as timeout when no first output arrives before connect timeout', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const deps = makeDeps();
    const supervisor = new CatSupervisor({ ...deps, connectTimeoutMs: 1_000, idleTimeoutMs: 5_000 });
    await supervisor.syncCats({ codex: catConfig('codex') });

    await supervisor.markProcessing('codex');
    t.mock.timers.tick(999);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(supervisor.getStatus('codex'), 'processing');

    t.mock.timers.tick(1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(supervisor.getStatus('codex'), 'timeout');
  });

  it('switches to idle timeout after first output and resets it on later output', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const deps = makeDeps();
    const supervisor = new CatSupervisor({ ...deps, connectTimeoutMs: 1_000, idleTimeoutMs: 2_000 });
    await supervisor.syncCats({ codex: catConfig('codex') });

    await supervisor.markProcessing('codex');
    t.mock.timers.tick(500);
    await supervisor.markOutput('codex');

    t.mock.timers.tick(1_500);
    await supervisor.markOutput('codex');
    t.mock.timers.tick(1_999);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(supervisor.getStatus('codex'), 'processing');

    t.mock.timers.tick(1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(supervisor.getStatus('codex'), 'timeout');
  });

  it('pauses idle timeout during tool execution and resumes after tool result', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const deps = makeDeps();
    const supervisor = new CatSupervisor({ ...deps, connectTimeoutMs: 1_000, idleTimeoutMs: 2_000 });
    await supervisor.syncCats({ codex: catConfig('codex') });

    await supervisor.markProcessing('codex');
    await supervisor.pauseForTool('codex');
    t.mock.timers.tick(10_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(supervisor.getStatus('codex'), 'processing');

    await supervisor.resumeAfterTool('codex');
    t.mock.timers.tick(1_999);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(supervisor.getStatus('codex'), 'processing');

    t.mock.timers.tick(1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(supervisor.getStatus('codex'), 'timeout');
  });

  it('recovers stale processing and timeout statuses to online idle', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const deps = makeDeps();
    const supervisor = new CatSupervisor({ ...deps, processingTimeoutMs: 1_000 });
    await supervisor.syncCats({ codex: catConfig('codex'), kimi: catConfig('kimi') });

    await supervisor.markProcessing('codex');
    t.mock.timers.tick(1_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(supervisor.getStatus('codex'), 'timeout');
    await supervisor.markProcessing('kimi');
    assert.equal(supervisor.getStatus('kimi'), 'processing');

    const recovered = await supervisor.recoverStaleStatuses();

    assert.deepEqual(recovered.sort(), ['codex', 'kimi']);
    assert.equal(supervisor.getStatus('codex'), 'online_idle');
    assert.equal(supervisor.getStatus('kimi'), 'online_idle');
    assert.equal(deps.log.info.mock.calls.at(-1).arguments[1], '[CatSupervisor] recovered stale cat statuses');
  });
});
