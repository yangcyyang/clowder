import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

const { CapabilityReceiptExecutionGate, resolveCapabilityReceiptRolloutPolicy } = await import(
  '../dist/domains/cats/services/auth/CapabilityReceiptExecutionGate.js'
);
const { CapabilityReceiptStore, digestCapabilityArguments } = await import(
  '../dist/domains/cats/services/stores/ports/CapabilityReceiptStore.js'
);

function intent(overrides = {}) {
  return {
    version: 1,
    executorId: 'antigravity.native.run_command',
    action: 'run_command',
    invocationId: 'inv-1',
    threadId: 'thread-canary',
    catId: 'antig-opus',
    userId: 'default-user',
    argumentDigest: digestCapabilityArguments({ commandLine: 'git status', cwd: '/tmp' }),
    ...overrides,
  };
}

function policy(overrides = {}) {
  return {
    mode: 'enforce',
    executorAllowlist: new Set(['antigravity.native.run_command']),
    catAllowlist: new Set(['antig-opus']),
    threadAllowlist: new Set(['thread-canary']),
    ...overrides,
  };
}

describe('CapabilityReceiptExecutionGate rollout policy', () => {
  test('parses exact CSV allowlists and defaults to off/match-none', () => {
    const defaults = resolveCapabilityReceiptRolloutPolicy({});
    assert.equal(defaults.mode, 'off');
    assert.equal(defaults.executorAllowlist.size, 0);
    assert.equal(defaults.catAllowlist.size, 0);
    assert.equal(defaults.threadAllowlist.size, 0);

    const configured = resolveCapabilityReceiptRolloutPolicy({
      CLOWDER_CAPABILITY_RECEIPT_MODE: 'observe',
      CLOWDER_CAPABILITY_RECEIPT_EXECUTOR_ALLOWLIST: ' antigravity.native.run_command ',
      CLOWDER_CAPABILITY_RECEIPT_CAT_ALLOWLIST: 'antig-opus, antig-sonnet',
      CLOWDER_CAPABILITY_RECEIPT_THREAD_ALLOWLIST: 'thread-canary',
      CLOWDER_CAPABILITY_RECEIPT_EMERGENCY_BLOCK: '1',
    });
    assert.equal(configured.mode, 'observe');
    assert.deepEqual([...configured.catAllowlist], ['antig-opus', 'antig-sonnet']);
    assert.equal(configured.emergencyBlock, true);
  });

  test('off bypasses without consulting the approver', async () => {
    const authorize = mock.fn();
    const decisions = [];
    const gate = new CapabilityReceiptExecutionGate({
      policy: policy({ mode: 'off' }),
      authorize,
      recordDecision: (status) => decisions.push(status),
    });

    assert.deepEqual(await gate.authorize(intent(), 'read repository status'), {
      allowed: true,
      state: 'off',
    });
    assert.equal(authorize.mock.callCount(), 0);
    assert.deepEqual(decisions, ['gate_off']);
  });

  test('empty allowlists never expand to global enforcement', async () => {
    const authorize = mock.fn();
    const gate = new CapabilityReceiptExecutionGate({
      policy: policy({ threadAllowlist: new Set() }),
      authorize,
    });

    assert.deepEqual(await gate.authorize(intent(), 'read repository status'), {
      allowed: true,
      state: 'out_of_scope',
    });
    assert.equal(authorize.mock.callCount(), 0);
  });

  test('allowlists use exact matches rather than substring matches', async () => {
    const authorize = mock.fn();
    const gate = new CapabilityReceiptExecutionGate({ policy: policy(), authorize });

    const result = await gate.authorize(intent({ threadId: 'thread-canary-copy' }), 'read repository status');

    assert.deepEqual(result, { allowed: true, state: 'out_of_scope' });
    assert.equal(authorize.mock.callCount(), 0);
  });

  test('observe records a matched decision without creating an approval request', async () => {
    const authorize = mock.fn();
    const decisions = [];
    const gate = new CapabilityReceiptExecutionGate({
      policy: policy({ mode: 'observe' }),
      authorize,
      recordDecision: (status) => decisions.push(status),
    });

    assert.deepEqual(await gate.authorize(intent(), 'read repository status'), {
      allowed: true,
      state: 'observed',
    });
    assert.equal(authorize.mock.callCount(), 0);
    assert.deepEqual(decisions, ['would_block']);
  });

  test('emergency block denies an exact matched canary before approval', async () => {
    const authorize = mock.fn();
    const gate = new CapabilityReceiptExecutionGate({
      policy: policy({ emergencyBlock: true }),
      authorize,
    });

    const result = await gate.authorize(intent(), 'read repository status');

    assert.equal(result.allowed, false);
    assert.equal(result.state, 'denied');
    assert.match(result.reason, /emergency block/i);
    assert.equal(authorize.mock.callCount(), 0);
  });

  test('enforce grants only after a receipt is issued and consumed', async () => {
    const receiptStore = new CapabilityReceiptStore({ now: () => 100_000 });
    const authorize = mock.fn(async () => ({
      status: 'granted',
      requestId: 'request-1',
      approvedBy: 'default-user',
      scope: 'once',
      expiresAt: 130_000,
    }));
    const decisions = [];
    const gate = new CapabilityReceiptExecutionGate({
      policy: policy(),
      authorize,
      receiptStore,
      recordDecision: (status) => decisions.push(status),
    });

    const result = await gate.authorize(intent(), 'read repository status');

    assert.equal(result.allowed, true);
    assert.equal(result.state, 'granted');
    assert.match(result.receiptId, /^[0-9a-f-]+$/i);
    assert.equal(authorize.mock.callCount(), 1);
    assert.deepEqual(decisions, ['issued', 'consumed']);
  });

  test('pending or denied approval blocks execution', async () => {
    for (const status of ['pending', 'denied']) {
      const gate = new CapabilityReceiptExecutionGate({
        policy: policy(),
        authorize: async () => ({ status, requestId: 'request-1' }),
        receiptStore: new CapabilityReceiptStore({ now: () => 100_000 }),
      });

      const result = await gate.authorize(intent(), 'read repository status');
      assert.equal(result.allowed, false);
      assert.equal(result.state, status);
    }
  });

  test('receipt store failure is fail-closed in enforce mode', async () => {
    const decisions = [];
    const receiptStore = {
      issue: async () => {
        throw new Error('redis unavailable');
      },
      consume: async () => ({ ok: false, code: 'not_found' }),
    };
    const gate = new CapabilityReceiptExecutionGate({
      policy: policy(),
      authorize: async () => ({
        status: 'granted',
        requestId: 'request-1',
        approvedBy: 'default-user',
        scope: 'once',
        expiresAt: 130_000,
      }),
      receiptStore,
      recordDecision: (status) => decisions.push(status),
    });

    const result = await gate.authorize(intent(), 'read repository status');

    assert.deepEqual(result, { allowed: false, state: 'error' });
    assert.deepEqual(decisions, ['store_error']);
  });
});
