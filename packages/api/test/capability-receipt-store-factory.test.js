import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const {
  createCapabilityReceiptStore,
  resolveCapabilityReceiptMode,
} = await import(
  '../dist/domains/cats/services/stores/factories/CapabilityReceiptStoreFactory.js'
);
const { CapabilityReceiptStore } = await import(
  '../dist/domains/cats/services/stores/ports/CapabilityReceiptStore.js'
);
const { RedisCapabilityReceiptStore } = await import(
  '../dist/domains/cats/services/stores/redis/RedisCapabilityReceiptStore.js'
);

describe('CapabilityReceiptStoreFactory', () => {
  test('defaults to off and creates no receipt store', () => {
    assert.equal(resolveCapabilityReceiptMode(undefined), 'off');
    assert.equal(createCapabilityReceiptStore({ mode: 'off' }), undefined);
  });

  test('observe may use memory when Redis is unavailable', () => {
    const store = createCapabilityReceiptStore({ mode: 'observe' });
    assert.ok(store instanceof CapabilityReceiptStore);
  });

  test('observe uses Redis when it is available', () => {
    const redis = {};
    const store = createCapabilityReceiptStore({ mode: 'observe', redis });
    assert.ok(store instanceof RedisCapabilityReceiptStore);
  });

  test('enforce refuses to start without Redis', () => {
    assert.throws(
      () => createCapabilityReceiptStore({ mode: 'enforce' }),
      /requires Redis/i,
    );
  });

  test('enforce uses Redis and never falls back to memory', () => {
    const redis = {};
    const store = createCapabilityReceiptStore({ mode: 'enforce', redis });
    assert.ok(store instanceof RedisCapabilityReceiptStore);
  });

  test('rejects unknown rollout modes instead of widening policy', () => {
    assert.throws(() => resolveCapabilityReceiptMode('enabled'), /Invalid capability receipt mode/);
  });
});
