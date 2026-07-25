/**
 * Batch 3-E item 2: daily-cost-budget-gate.ts tests.
 *
 * Three required categories per the batch brief:
 *   1. 超限拦截 (over-cap blocks the run)
 *   2. 缺数据保守放行 (missing/unreliable cost data → conservative pass-through, not a block)
 *   3. 开关关闭时零影响 (CLOWDER_BUDGET_ENFORCE off → zero behavior change, no store access at all)
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

const { checkDailyBudgetCap, isBudgetEnforceEnabled, _clearDailyCostBudgetCache } = await import(
  '../dist/domains/cats/services/agents/invocation/daily-cost-budget-gate.js'
);

const ENABLED_ENV = { CLOWDER_BUDGET_ENFORCE: '1' };
const DISABLED_ENV = {};

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function todayEpochMs() {
  return Date.now();
}

function yesterdayEpochMs() {
  return Date.now() - 24 * 60 * 60 * 1000 - 60_000;
}

/** Builds a fake InvocationRecordStore with a scanAll() over the given fixtures. */
function fakeStoreWithRecords(records, { hasScanAll = true } = {}) {
  if (!hasScanAll) return {};
  return { scanAll: async () => records };
}

function usageRecord({ catId, costUsd, recordedAt }) {
  return {
    id: `rec-${catId}-${recordedAt}`,
    usageByCat: { [catId]: { costUsd } },
    usageRecordedAt: recordedAt,
    updatedAt: recordedAt,
  };
}

describe('checkDailyBudgetCap', () => {
  const originalConfigs = catRegistry.getAllConfigs();

  beforeEach(() => {
    _clearDailyCostBudgetCache();
    catRegistry.reset();
    for (const [id, config] of Object.entries(originalConfigs)) {
      catRegistry.register(id, config);
    }
  });

  afterEach(() => {
    _clearDailyCostBudgetCache();
    catRegistry.reset();
    for (const [id, config] of Object.entries(originalConfigs)) {
      catRegistry.register(id, config);
    }
  });

  it('isBudgetEnforceEnabled: recognizes "1" and "true" (case-insensitive), rejects everything else', () => {
    assert.equal(isBudgetEnforceEnabled({ CLOWDER_BUDGET_ENFORCE: '1' }), true);
    assert.equal(isBudgetEnforceEnabled({ CLOWDER_BUDGET_ENFORCE: 'true' }), true);
    assert.equal(isBudgetEnforceEnabled({ CLOWDER_BUDGET_ENFORCE: 'TRUE' }), true);
    assert.equal(isBudgetEnforceEnabled({ CLOWDER_BUDGET_ENFORCE: '0' }), false);
    assert.equal(isBudgetEnforceEnabled({ CLOWDER_BUDGET_ENFORCE: 'false' }), false);
    assert.equal(isBudgetEnforceEnabled({}), false);
  });

  // ── Category 3: switch off → zero impact ──

  it('HARD CONSTRAINT: CLOWDER_BUDGET_ENFORCE off → always allowed, store never touched', async () => {
    catRegistry.register('budget-test-over', {
      id: 'budget-test-over',
      name: 'Over',
      displayName: 'Over',
      avatar: '',
      color: { primary: '#000', secondary: '#fff' },
      mentionPatterns: ['@budget-test-over'],
      clientId: 'anthropic',
      defaultModel: 'claude-sonnet-4-5',
      mcpSupport: false,
      roleDescription: '',
      personality: '',
      costBudget: { perCatDailyUsd: 1 },
    });

    let scanCalled = false;
    const store = {
      scanAll: async () => {
        scanCalled = true;
        return [usageRecord({ catId: 'budget-test-over', costUsd: 999, recordedAt: todayEpochMs() })];
      },
    };

    const result = await checkDailyBudgetCap(['budget-test-over'], { invocationRecordStore: store }, DISABLED_ENV);
    assert.deepEqual(result, { allowed: true });
    assert.equal(scanCalled, false, 'the gate must not touch the invocation store when the env flag is off');
  });

  // ── Category 1: over-cap blocks ──

  it('blocks when a Claude cat has spent at or over its daily cap today', async () => {
    catRegistry.register('budget-test-blocked', {
      id: 'budget-test-blocked',
      name: 'Blocked',
      displayName: 'Blocked',
      avatar: '',
      color: { primary: '#000', secondary: '#fff' },
      mentionPatterns: ['@budget-test-blocked'],
      clientId: 'anthropic',
      defaultModel: 'claude-sonnet-4-5',
      mcpSupport: false,
      roleDescription: '',
      personality: '',
      costBudget: { perCatDailyUsd: 2 },
    });

    const store = fakeStoreWithRecords([
      usageRecord({ catId: 'budget-test-blocked', costUsd: 1.5, recordedAt: todayEpochMs() }),
      usageRecord({ catId: 'budget-test-blocked', costUsd: 1.0, recordedAt: todayEpochMs() }),
      // yesterday's spend must NOT count toward today's cap
      usageRecord({ catId: 'budget-test-blocked', costUsd: 100, recordedAt: yesterdayEpochMs() }),
    ]);

    const result = await checkDailyBudgetCap(['budget-test-blocked'], { invocationRecordStore: store }, ENABLED_ENV);
    assert.equal(result.allowed, false);
    assert.deepEqual(result.blocked, { catId: 'budget-test-blocked', spentUsd: 2.5, capUsd: 2 });
  });

  it('allows when a Claude cat is under its daily cap today', async () => {
    catRegistry.register('budget-test-under', {
      id: 'budget-test-under',
      name: 'Under',
      displayName: 'Under',
      avatar: '',
      color: { primary: '#000', secondary: '#fff' },
      mentionPatterns: ['@budget-test-under'],
      clientId: 'anthropic',
      defaultModel: 'claude-sonnet-4-5',
      mcpSupport: false,
      roleDescription: '',
      personality: '',
      costBudget: { perCatDailyUsd: 10 },
    });

    const store = fakeStoreWithRecords([
      usageRecord({ catId: 'budget-test-under', costUsd: 1, recordedAt: todayEpochMs() }),
    ]);

    const result = await checkDailyBudgetCap(['budget-test-under'], { invocationRecordStore: store }, ENABLED_ENV);
    assert.deepEqual(result, { allowed: true });
  });

  it('checks multiple targetCats and blocks the whole run on the first cat over cap', async () => {
    catRegistry.register('budget-test-multi-ok', {
      id: 'budget-test-multi-ok',
      name: 'OK',
      displayName: 'OK',
      avatar: '',
      color: { primary: '#000', secondary: '#fff' },
      mentionPatterns: ['@budget-test-multi-ok'],
      clientId: 'anthropic',
      defaultModel: 'claude-sonnet-4-5',
      mcpSupport: false,
      roleDescription: '',
      personality: '',
      costBudget: { perCatDailyUsd: 10 },
    });
    catRegistry.register('budget-test-multi-bad', {
      id: 'budget-test-multi-bad',
      name: 'Bad',
      displayName: 'Bad',
      avatar: '',
      color: { primary: '#000', secondary: '#fff' },
      mentionPatterns: ['@budget-test-multi-bad'],
      clientId: 'anthropic',
      defaultModel: 'claude-sonnet-4-5',
      mcpSupport: false,
      roleDescription: '',
      personality: '',
      costBudget: { perCatDailyUsd: 1 },
    });

    const store = fakeStoreWithRecords([
      usageRecord({ catId: 'budget-test-multi-ok', costUsd: 0.5, recordedAt: todayEpochMs() }),
      usageRecord({ catId: 'budget-test-multi-bad', costUsd: 5, recordedAt: todayEpochMs() }),
    ]);

    const result = await checkDailyBudgetCap(
      ['budget-test-multi-ok', 'budget-test-multi-bad'],
      { invocationRecordStore: store },
      ENABLED_ENV,
    );
    assert.equal(result.allowed, false);
    assert.equal(result.blocked.catId, 'budget-test-multi-bad');
  });

  // ── Category 2: missing/unreliable data → conservative pass-through ──

  it('conservative pass-through: no costBudget configured → always allowed regardless of spend', async () => {
    // 'opus' is a real registered Claude cat from setup-cat-registry.js with no costBudget.
    const store = fakeStoreWithRecords([usageRecord({ catId: 'opus', costUsd: 99999, recordedAt: todayEpochMs() })]);
    const result = await checkDailyBudgetCap(['opus'], { invocationRecordStore: store }, ENABLED_ENV);
    assert.deepEqual(result, { allowed: true });
  });

  it('conservative pass-through: non-Claude clientId with a cap configured is still allowed (costUsd unreliable)', async () => {
    catRegistry.register('budget-test-non-claude', {
      id: 'budget-test-non-claude',
      name: 'NonClaude',
      displayName: 'NonClaude',
      avatar: '',
      color: { primary: '#000', secondary: '#fff' },
      mentionPatterns: ['@budget-test-non-claude'],
      clientId: 'openai',
      defaultModel: 'gpt-5.4',
      mcpSupport: false,
      roleDescription: '',
      personality: '',
      costBudget: { perCatDailyUsd: 1 },
    });

    const store = fakeStoreWithRecords([
      usageRecord({ catId: 'budget-test-non-claude', costUsd: 999, recordedAt: todayEpochMs() }),
    ]);

    const result = await checkDailyBudgetCap(['budget-test-non-claude'], { invocationRecordStore: store }, ENABLED_ENV);
    assert.deepEqual(result, { allowed: true }, 'non-Claude cats must never be blocked on unverified costUsd');
  });

  it('conservative pass-through: store without scanAll (in-memory store shape) → allowed', async () => {
    catRegistry.register('budget-test-no-scan', {
      id: 'budget-test-no-scan',
      name: 'NoScan',
      displayName: 'NoScan',
      avatar: '',
      color: { primary: '#000', secondary: '#fff' },
      mentionPatterns: ['@budget-test-no-scan'],
      clientId: 'anthropic',
      defaultModel: 'claude-sonnet-4-5',
      mcpSupport: false,
      roleDescription: '',
      personality: '',
      costBudget: { perCatDailyUsd: 1 },
    });

    const store = fakeStoreWithRecords([], { hasScanAll: false });
    const result = await checkDailyBudgetCap(['budget-test-no-scan'], { invocationRecordStore: store }, ENABLED_ENV);
    assert.deepEqual(result, { allowed: true }, 'a store that cannot report usage must not be treated as "over budget"');
  });

  it('unknown catId (not in registry) is allowed (no config to enforce against)', async () => {
    const store = fakeStoreWithRecords([]);
    const result = await checkDailyBudgetCap(['totally-unknown-cat'], { invocationRecordStore: store }, ENABLED_ENV);
    assert.deepEqual(result, { allowed: true });
  });

  // ── cache behavior ──

  it('caches the scanAll result for the TTL window (does not re-scan on every call for the same cat/day)', async () => {
    catRegistry.register('budget-test-cache', {
      id: 'budget-test-cache',
      name: 'Cache',
      displayName: 'Cache',
      avatar: '',
      color: { primary: '#000', secondary: '#fff' },
      mentionPatterns: ['@budget-test-cache'],
      clientId: 'anthropic',
      defaultModel: 'claude-sonnet-4-5',
      mcpSupport: false,
      roleDescription: '',
      personality: '',
      costBudget: { perCatDailyUsd: 10 },
    });

    let scanCount = 0;
    const store = {
      scanAll: async () => {
        scanCount += 1;
        return [usageRecord({ catId: 'budget-test-cache', costUsd: 1, recordedAt: todayEpochMs() })];
      },
    };

    await checkDailyBudgetCap(['budget-test-cache'], { invocationRecordStore: store }, ENABLED_ENV);
    await checkDailyBudgetCap(['budget-test-cache'], { invocationRecordStore: store }, ENABLED_ENV);
    await checkDailyBudgetCap(['budget-test-cache'], { invocationRecordStore: store }, ENABLED_ENV);

    assert.equal(scanCount, 1, 'repeated checks within the TTL window must reuse the cached spend, not re-scan');
  });
});

// Sanity: today/yesterday helpers actually produce distinct calendar dates in CI environments
// that happen to run near local midnight (defensive, not expected to ever fail in practice).
describe('test fixture sanity', () => {
  it('yesterdayEpochMs is at least 24h before now', () => {
    assert.ok(todayEpochMs() - yesterdayEpochMs() >= 24 * 60 * 60 * 1000);
  });
  it('todayIso is a plausible YYYY-MM-DD string', () => {
    assert.match(todayIso(), /^\d{4}-\d{2}-\d{2}$/);
  });
});
