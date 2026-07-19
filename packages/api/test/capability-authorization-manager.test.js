import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { AuthorizationManager } = await import('../dist/domains/cats/services/auth/AuthorizationManager.js');
const { AuthorizationRuleStore } = await import('../dist/domains/cats/services/stores/ports/AuthorizationRuleStore.js');
const { PendingRequestStore } = await import('../dist/domains/cats/services/stores/ports/PendingRequestStore.js');
const { AuthorizationAuditStore } = await import(
  '../dist/domains/cats/services/stores/ports/AuthorizationAuditStore.js'
);
const { digestCapabilityArguments } = await import(
  '../dist/domains/cats/services/stores/ports/CapabilityReceiptStore.js'
);

function intent(overrides = {}) {
  return {
    version: 1,
    executorId: 'antigravity.native.run_command',
    action: 'run_command',
    invocationId: 'inv-cap-1',
    threadId: 'thread-canary',
    catId: 'antig-opus',
    userId: 'owner-1',
    argumentDigest: digestCapabilityArguments({ commandLine: 'git status', cwd: '/tmp' }),
    ...overrides,
  };
}

function createManager(timeoutMs = 100) {
  const pendingStore = new PendingRequestStore();
  const manager = new AuthorizationManager({
    ruleStore: new AuthorizationRuleStore(),
    pendingStore,
    auditStore: new AuthorizationAuditStore(),
    timeoutMs,
  });
  return { manager, pendingStore };
}

describe('AuthorizationManager capability once grants', () => {
  test('binds the pending request to requester and exact intent', async () => {
    const { manager } = createManager(5_000);
    const expected = intent();
    const approvalPromise = manager.requestCapability(expected, 'Approve native run_command');
    await new Promise((resolve) => setTimeout(resolve, 5));

    const [pending] = await manager.getPending(expected.threadId);
    assert.equal(pending.requesterUserId, expected.userId);
    assert.deepEqual(pending.capabilityIntent, expected);
    assert.equal(pending.capabilitySubjectDigest.length, 64);
    assert.ok(pending.requestExpiresAt > Date.now());

    await manager.respond(pending.requestId, false, 'once', expected.userId, 'not now');
    assert.equal((await approvalPromise).status, 'denied');
  });

  test('in-flight once approval returns receipt issuance metadata', async () => {
    const { manager } = createManager(5_000);
    const expected = intent();
    const approvalPromise = manager.requestCapability(expected, 'Approve native run_command');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const [pending] = await manager.getPending(expected.threadId);

    await manager.respond(pending.requestId, true, 'once', expected.userId, 'approved');
    const approval = await approvalPromise;

    assert.equal(approval.status, 'granted');
    assert.equal(approval.requestId, pending.requestId);
    assert.equal(approval.approvedBy, expected.userId);
    assert.equal(approval.scope, 'once');
    assert.ok(approval.expiresAt > Date.now());
  });

  test('late approval is atomically claimed by the exact retry without a second request', async () => {
    const { manager, pendingStore } = createManager(10);
    const expected = intent();

    const timedOut = await manager.requestCapability(expected, 'Approve native run_command');
    assert.equal(timedOut.status, 'pending');
    const [pending] = await manager.getPending(expected.threadId);
    await manager.respond(pending.requestId, true, 'once', expected.userId);

    const retry = await manager.requestCapability(expected, 'Approve native run_command');
    const replay = await manager.requestCapability(expected, 'Approve native run_command');

    assert.equal(retry.status, 'granted');
    assert.equal(retry.requestId, pending.requestId);
    assert.equal(replay.status, 'pending', 'consumed grant must not be reused');
    assert.equal(pendingStore.size, 2, 'only replay creates the next approval request');
  });

  test('wrong requester cannot resolve another owner capability request', async () => {
    const { manager } = createManager(5_000);
    const expected = intent();
    const approvalPromise = manager.requestCapability(expected, 'Approve native run_command');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const [pending] = await manager.getPending(expected.threadId);

    await assert.rejects(manager.respond(pending.requestId, true, 'once', 'attacker'), /owner/i);
    assert.equal((await manager.getRequestStatus(pending.requestId)).status, 'waiting');

    await manager.respond(pending.requestId, false, 'once', expected.userId);
    await approvalPromise;
  });

  test('capability requests reject persistent thread/global approvals in A1', async () => {
    const { manager } = createManager(5_000);
    const expected = intent();
    const approvalPromise = manager.requestCapability(expected, 'Approve native run_command');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const [pending] = await manager.getPending(expected.threadId);

    await assert.rejects(manager.respond(pending.requestId, true, 'thread', expected.userId), /once/i);
    assert.equal((await manager.getRequestStatus(pending.requestId)).status, 'waiting');

    await manager.respond(pending.requestId, false, 'once', expected.userId);
    await approvalPromise;
  });
});
