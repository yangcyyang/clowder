/**
 * Capability receipt v1 — memory contract tests.
 *
 * A1 security invariants:
 * - the bearer secret is never persisted in the receipt record;
 * - claims are bound to a canonical argument digest;
 * - consume is single-use and first-consumer-wins;
 * - mismatched or expired receipts never execute and never become reusable.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const {
  CapabilityReceiptStore,
  canonicalizeCapabilityArguments,
  digestCapabilityArguments,
} = await import('../dist/domains/cats/services/stores/ports/CapabilityReceiptStore.js');

function makeIntent(overrides = {}) {
  return {
    version: 1,
    executorId: 'antigravity.native.run_command',
    action: 'run_command',
    invocationId: 'inv-1',
    threadId: 'thread-1',
    catId: 'antigravity',
    userId: 'user-1',
    taskId: 'task-397',
    argumentDigest: digestCapabilityArguments({ commandLine: 'touch sentinel', cwd: '/tmp/a1' }),
    ...overrides,
  };
}

function issue(store, intent = makeIntent(), overrides = {}) {
  return store.issue({
    requestId: 'request-1',
    intent,
    approvedBy: 'user-1',
    approvalScope: 'once',
    expiresAt: 130_000,
    ...overrides,
  });
}

describe('capability argument canonicalization', () => {
  test('sorts object keys recursively without changing array order', () => {
    const left = { z: 1, nested: { b: true, a: 'x' }, list: [{ y: 2, x: 1 }, 3] };
    const right = { list: [{ x: 1, y: 2 }, 3], nested: { a: 'x', b: true }, z: 1 };

    assert.equal(canonicalizeCapabilityArguments(left), canonicalizeCapabilityArguments(right));
    assert.equal(digestCapabilityArguments(left), digestCapabilityArguments(right));
    assert.notEqual(digestCapabilityArguments({ list: [1, 2] }), digestCapabilityArguments({ list: [2, 1] }));
  });
});

describe('CapabilityReceiptStore', () => {
  test('issues an opaque bearer while persisting only its hash and exact claims', async () => {
    const store = new CapabilityReceiptStore({ now: () => 100_000 });
    const intent = makeIntent();

    const issued = await issue(store, intent);

    assert.match(issued.bearer, /^arv1\.[^.]+\.[A-Za-z0-9_-]+$/);
    assert.equal(issued.receipt.status, 'issued');
    assert.equal(issued.receipt.subjectDigest.length, 64);
    assert.equal(issued.receipt.tokenHash.length, 64);
    assert.equal(JSON.stringify(issued.receipt).includes(issued.bearer), false);
    assert.equal(issued.receipt.userId, intent.userId);
    assert.equal(issued.receipt.argumentDigest, intent.argumentDigest);
  });

  test('consumes once and rejects replay', async () => {
    const store = new CapabilityReceiptStore({ now: () => 100_000 });
    const intent = makeIntent();
    const issued = await issue(store, intent);

    const first = await store.consume(issued.bearer, intent, 'antigravity.native.run_command');
    const replay = await store.consume(issued.bearer, intent, 'antigravity.native.run_command');

    assert.equal(first.ok, true);
    assert.equal(first.receipt.status, 'consumed');
    assert.deepEqual(replay, { ok: false, code: 'already_used' });
  });

  test('scope mismatch does not consume the valid receipt', async () => {
    const store = new CapabilityReceiptStore({ now: () => 100_000 });
    const intent = makeIntent();
    const issued = await issue(store, intent);

    const mismatch = await store.consume(
      issued.bearer,
      { ...intent, threadId: 'thread-other' },
      'antigravity.native.run_command',
    );
    const exact = await store.consume(issued.bearer, intent, 'antigravity.native.run_command');

    assert.deepEqual(mismatch, { ok: false, code: 'scope_mismatch' });
    assert.equal(exact.ok, true);
  });

  test('expired receipt cannot be consumed', async () => {
    let now = 100_000;
    const store = new CapabilityReceiptStore({ now: () => now });
    const intent = makeIntent();
    const issued = await issue(store, intent, { expiresAt: 100_100 });
    now = 100_101;

    const result = await store.consume(issued.bearer, intent, 'antigravity.native.run_command');

    assert.deepEqual(result, { ok: false, code: 'expired' });
  });

  test('twenty concurrent consumers have exactly one winner', async () => {
    const store = new CapabilityReceiptStore({ now: () => 100_000 });
    const intent = makeIntent();
    const issued = await issue(store, intent);

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        store.consume(issued.bearer, intent, 'antigravity.native.run_command'),
      ),
    );

    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => !result.ok && result.code === 'already_used').length, 19);
  });
});
