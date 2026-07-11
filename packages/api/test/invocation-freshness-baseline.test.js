import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const BASELINE = '900719925474099312345678901234567890';

function authInput(invocationId, callbackToken, freshnessBaseline = BASELINE) {
  return {
    invocationId,
    callbackToken,
    userId: 'user-1',
    catId: 'opus',
    threadId: 'thread-1',
    clientMessageIds: new Set(),
    createdAt: Date.now(),
    freshnessBaseline,
  };
}

function createRedisState() {
  return {
    hashes: new Map(),
    strings: new Map(),
    expiresAt: new Map(),
  };
}

/**
 * Minimal shared-state Redis fake for RedisAuthInvocationBackend's create,
 * getRecord and verify/TTL-slide paths. A second client over the same state
 * simulates rebuilding the backend after an API process restart.
 */
class FakeAuthRedis {
  constructor(state = createRedisState()) {
    this.state = state;
  }

  fork() {
    return new FakeAuthRedis(this.state);
  }

  async eval(script, numberOfKeys, ...keysAndArgs) {
    const keys = keysAndArgs.slice(0, numberOfKeys);
    const argv = keysAndArgs.slice(numberOfKeys).map(String);

    if (script.includes('local hashFields = {}')) {
      const invocationId = argv.at(-2);
      const expiresAt = argv.at(-1);
      const fields = argv.slice(0, -2);
      const hash = {};
      for (let i = 0; i < fields.length; i += 2) {
        hash[fields[i]] = fields[i + 1];
      }
      this.state.hashes.set(keys[0], hash);
      this.state.strings.set(keys[1], invocationId);
      this.state.expiresAt.set(keys[0], Number(expiresAt) + 60_000);
      this.state.expiresAt.set(keys[1], Number(expiresAt) + 60_000);
      return 1;
    }

    if (script.includes("local stored = redis.call('HGET', KEYS[1], 'callbackToken')")) {
      const hash = this.state.hashes.get(keys[0]);
      if (!hash) return ['fail', 'unknown_invocation'];
      if (hash.callbackToken !== argv[0]) return ['fail', 'invalid_token'];
      if (!hash.expiresAt || Number(argv[1]) > Number(hash.expiresAt)) {
        this.state.hashes.delete(keys[0]);
        return ['fail', 'expired'];
      }

      hash.expiresAt = argv[2];
      this.state.expiresAt.set(keys[0], Number(argv[2]) + 60_000);
      return ['ok', Object.entries(hash).flat()];
    }

    throw new Error('FakeAuthRedis received an unsupported Lua script');
  }

  async hgetall(key) {
    return { ...(this.state.hashes.get(key) ?? {}) };
  }

  async get(key) {
    return this.state.strings.get(key) ?? null;
  }

  async pexpireat(key, expiresAt) {
    if (!this.state.hashes.has(key) && !this.state.strings.has(key)) return 0;
    this.state.expiresAt.set(key, Number(expiresAt));
    return 1;
  }

  async del(key) {
    const removed = Number(this.state.hashes.delete(key)) + Number(this.state.strings.delete(key));
    this.state.expiresAt.delete(key);
    return removed;
  }
}

describe('invocation freshness baseline', () => {
  test('memory registry create, verify and getRecord preserve the opaque baseline', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1', undefined, undefined, {
      freshnessBaseline: BASELINE,
    });

    const verified = await registry.verify(invocationId, callbackToken);
    assert.equal(verified.ok, true);
    assert.equal(verified.record.freshnessBaseline, BASELINE);
    assert.equal(typeof verified.record.freshnessBaseline, 'string');

    const fetched = await registry.getRecord(invocationId);
    assert.ok(fetched);
    assert.equal(fetched.freshnessBaseline, BASELINE);
  });

  test('Redis backend rebuild preserves the baseline', async () => {
    const { RedisAuthInvocationBackend } = await import(
      '../dist/domains/cats/services/agents/invocation/RedisAuthInvocationBackend.js'
    );

    const redis1 = new FakeAuthRedis();
    const backend1 = new RedisAuthInvocationBackend(redis1);
    await backend1.create(authInput('redis-restart-inv', 'redis-restart-token'), 60_000);

    const backendAfterRestart = new RedisAuthInvocationBackend(redis1.fork());
    const rebuilt = await backendAfterRestart.getRecord('redis-restart-inv');

    assert.ok(rebuilt);
    assert.equal(rebuilt.freshnessBaseline, BASELINE);
    assert.equal(typeof rebuilt.freshnessBaseline, 'string');
  });

  test('Redis verify TTL slide preserves the baseline', async () => {
    const { RedisAuthInvocationBackend } = await import(
      '../dist/domains/cats/services/agents/invocation/RedisAuthInvocationBackend.js'
    );

    const originalDateNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;

    try {
      const redis1 = new FakeAuthRedis();
      const backend1 = new RedisAuthInvocationBackend(redis1);
      await backend1.create(authInput('redis-slide-inv', 'redis-slide-token'), 1_000);
      const before = await backend1.getRecord('redis-slide-inv');
      assert.ok(before);

      now += 400;
      const backendAfterRestart = new RedisAuthInvocationBackend(redis1.fork());
      const verified = await backendAfterRestart.verify('redis-slide-inv', 'redis-slide-token', 1_000);

      assert.equal(verified.ok, true);
      assert.ok(verified.record.expiresAt > before.expiresAt, 'verify must slide the logical TTL');
      assert.equal(verified.record.freshnessBaseline, BASELINE);

      const fetchedAfterSlide = await backendAfterRestart.getRecord('redis-slide-inv');
      assert.ok(fetchedAfterSlide);
      assert.equal(fetchedAfterSlide.freshnessBaseline, BASELINE);
    } finally {
      Date.now = originalDateNow;
    }
  });
});
