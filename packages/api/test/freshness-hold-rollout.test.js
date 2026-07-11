import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isFreshnessHoldEnabledFor, loadFreshnessHoldRollout } from '../dist/config/freshness-hold-rollout.js';
import { selectRouteFreshnessGate } from '../dist/domains/cats/services/agents/routing/AgentRouter.js';

describe('Freshness Hold rollout policy', () => {
  test('defaults off and supports one-switch rollback', () => {
    assert.equal(loadFreshnessHoldRollout({}).enabled, false);
    assert.equal(loadFreshnessHoldRollout({ CAT_CAFE_FRESHNESS_HOLD_ENABLED: 'false' }).enabled, false);
    assert.equal(loadFreshnessHoldRollout({ CAT_CAFE_FRESHNESS_HOLD_ENABLED: 'true' }).enabled, true);
  });

  test('supports optional cat and thread allowlists', () => {
    const policy = loadFreshnessHoldRollout({
      CAT_CAFE_FRESHNESS_HOLD_ENABLED: 'true',
      CAT_CAFE_FRESHNESS_HOLD_CATS: ' opus, codex ',
      CAT_CAFE_FRESHNESS_HOLD_THREADS: 'thread-a,thread-b',
    });

    assert.equal(isFreshnessHoldEnabledFor(policy, 'thread-a', 'opus'), true);
    assert.equal(isFreshnessHoldEnabledFor(policy, 'thread-a', 'gemini'), false);
    assert.equal(isFreshnessHoldEnabledFor(policy, 'thread-c', 'opus'), false);
  });

  test('keeps the whole route legacy unless every target is allowlisted', () => {
    const protectedRouteGate = {
      isEnabledFor() {
        return true;
      },
    };
    const gate = {
      isEnabledFor(threadId, catId) {
        return threadId === 'thread-a' && (catId === 'opus' || catId === 'codex');
      },
      forProtectedRoute() {
        return protectedRouteGate;
      },
    };

    assert.equal(selectRouteFreshnessGate(gate, 'thread-a', ['opus', 'codex']), protectedRouteGate);
    assert.equal(protectedRouteGate.isEnabledFor('thread-a', 'gemini'), true);
    assert.equal(selectRouteFreshnessGate(gate, 'thread-a', ['opus', 'gemini']), undefined);
    assert.equal(selectRouteFreshnessGate(gate, 'thread-b', ['opus']), undefined);
  });
});
