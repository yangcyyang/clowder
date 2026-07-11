import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FreshnessHoldExpiryScheduler } from '../dist/domains/cats/services/agents/freshness/FreshnessHoldExpiryScheduler.js';

describe('FreshnessHoldExpiryScheduler', () => {
  it('sweeps immediately, repeats on the configured interval, and stops cleanly', async () => {
    const sweeps = [];
    let scheduledTick;
    let clearedHandle;
    const holdStore = {
      async expireDue(now) {
        sweeps.push(now);
        return 0;
      },
    };
    const scheduler = new FreshnessHoldExpiryScheduler({
      holdStore,
      now: () => 1234 + sweeps.length,
      intervalMs: 25,
      setIntervalFn(callback, intervalMs) {
        assert.equal(intervalMs, 25);
        scheduledTick = callback;
        return 'timer-handle';
      },
      clearIntervalFn(handle) {
        clearedHandle = handle;
      },
    });

    await scheduler.start();
    assert.deepEqual(sweeps, [1234]);

    await scheduledTick();
    assert.deepEqual(sweeps, [1234, 1235]);

    scheduler.stop();
    assert.equal(clearedHandle, 'timer-handle');
    assert.equal(scheduler.isRunning, false);

    await scheduledTick();
    assert.deepEqual(sweeps, [1234, 1235]);
  });
});
