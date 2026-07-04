import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { SessionContinuationCoordinator } = await import(
  '../dist/domains/cats/services/agents/invocation/SessionContinuationCoordinator.js'
);

function makeCapsule(overrides = {}) {
  return {
    v: 1,
    threadId: 't1',
    catId: 'opus',
    mode: 'serial',
    a2aEnabled: true,
    ballState: 'in_progress',
    continuationReason: 'threshold_seal',
    createdAt: 1,
    seal: { sessionId: 's1', sessionSeq: 1, reason: 'threshold_seal' },
    ...overrides,
  };
}

describe('SessionContinuationCoordinator', () => {
  it('defaults unset member strategy to resume', async () => {
    const coord = new SessionContinuationCoordinator({
      threadStore: { getMemberSessionStrategy: () => undefined },
    });
    assert.equal(await coord.resolveSessionStrategy('t1', 'opus', 'u1'), 'resume');
  });

  it('reborn skips pending continuation consume', async () => {
    let consumed = false;
    const coord = new SessionContinuationCoordinator({
      threadStore: {
        getMemberSessionStrategy: () => 'reborn',
        consumePendingContinuation: () => {
          consumed = true;
          return null;
        },
      },
    });

    const result = await coord.prepareInvocationContext({
      threadId: 't1',
      catId: 'opus',
      userId: 'u1',
      content: 'hello',
    });

    assert.equal(result.content, 'hello');
    assert.equal(result.sessionPolicy, 'reborn');
    assert.equal(consumed, false);
  });

  it('resume consumes pending capsule and injects continuation prompt', async () => {
    const capsule = makeCapsule();
    const coord = new SessionContinuationCoordinator({
      threadStore: {
        getMemberSessionStrategy: () => 'resume',
        consumePendingContinuation: () => capsule,
      },
    });

    const result = await coord.prepareInvocationContext({
      threadId: 't1',
      catId: 'opus',
      userId: 'u1',
      content: 'hello',
    });

    assert.match(result.content, /System Continuation/);
    assert.match(result.content, /hello/);
    assert.equal(result.consumedContinuation.capsule, capsule);
  });

  it('resume consumes compact boundary capsule and re-injects identity plus unfinished task guardrails', async () => {
    const capsule = makeCapsule({
      continuationReason: 'compact_boundary',
      seal: undefined,
      threadId: 'thread-compact',
      catId: 'codex',
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 2,
      directMessageFrom: 'opus',
    });
    const coord = new SessionContinuationCoordinator({
      threadStore: {
        getMemberSessionStrategy: () => 'resume',
        consumePendingContinuation: () => capsule,
      },
    });

    const result = await coord.prepareInvocationContext({
      threadId: 'thread-compact',
      catId: 'codex',
      userId: 'u1',
      content: '继续执行 B4 验收',
    });

    assert.match(result.content, /compact_boundary/);
    assert.match(result.content, /Thread: thread-compact/);
    assert.match(result.content, /Cat: codex/);
    assert.match(result.content, /Mode: serial \(1 \/ 2\)/);
    assert.match(result.content, /Direct message from: opus/);
    assert.match(result.content, /unfinished work/i);
    assert.match(result.content, /git status --short --branch/i);
    assert.match(result.content, /继续执行 B4 验收/);
    assert.equal(result.consumedContinuation.capsule, capsule);
  });

  it('success stores produced capsule for next invocation', async () => {
    const calls = [];
    const capsule = makeCapsule();
    const coord = new SessionContinuationCoordinator({
      threadStore: {
        getMemberSessionStrategy: () => undefined,
        setPendingContinuation: (threadId, catId, userId, storedCapsule) => {
          calls.push({ threadId, catId, userId, storedCapsule });
        },
      },
    });

    await coord.commitInvocationOutcome({
      finalStatus: 'succeeded',
      threadId: 't1',
      catId: 'opus',
      userId: 'u1',
      producedCapsules: [capsule],
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].storedCapsule, capsule);
  });

  it('failure restores consumed capsule when no newer capsule supersedes it', async () => {
    const calls = [];
    const consumed = { capsule: makeCapsule(), threadId: 't1', catId: 'opus', userId: 'u1' };
    const coord = new SessionContinuationCoordinator({
      threadStore: {
        getMemberSessionStrategy: () => undefined,
        setPendingContinuation: (threadId, catId, userId, storedCapsule) => {
          calls.push({ threadId, catId, userId, storedCapsule });
        },
      },
    });

    await coord.commitInvocationOutcome({
      finalStatus: 'failed',
      threadId: 't1',
      catId: 'opus',
      userId: 'u1',
      consumedContinuation: consumed,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].storedCapsule, consumed.capsule);
  });

  it('produced capsule for another cat does not prevent restoring consumed capsule', async () => {
    const calls = [];
    const consumed = { capsule: makeCapsule({ catId: 'opus' }), threadId: 't1', catId: 'opus', userId: 'u1' };
    const coord = new SessionContinuationCoordinator({
      threadStore: {
        getMemberSessionStrategy: () => undefined,
        setPendingContinuation: (threadId, catId, userId, storedCapsule) => {
          calls.push({ threadId, catId, userId, storedCapsule });
        },
      },
    });

    await coord.commitInvocationOutcome({
      finalStatus: 'failed',
      threadId: 't1',
      catId: 'opus',
      userId: 'u1',
      consumedContinuation: consumed,
      producedCapsules: [makeCapsule({ catId: 'codex' })],
    });

    assert.equal(calls.length, 2);
    assert.ok(calls.find((call) => call.catId === 'codex'));
    assert.ok(calls.find((call) => call.catId === 'opus' && call.storedCapsule === consumed.capsule));
  });

  it('skips cross-thread produced capsules', async () => {
    const calls = [];
    const coord = new SessionContinuationCoordinator({
      threadStore: {
        getMemberSessionStrategy: () => undefined,
        setPendingContinuation: (threadId, catId, userId, storedCapsule) => {
          calls.push({ threadId, catId, userId, storedCapsule });
        },
      },
    });

    await coord.commitInvocationOutcome({
      finalStatus: 'succeeded',
      threadId: 't1',
      catId: 'opus',
      userId: 'u1',
      producedCapsules: [makeCapsule({ threadId: 'other' })],
    });

    assert.equal(calls.length, 0);
  });
});
