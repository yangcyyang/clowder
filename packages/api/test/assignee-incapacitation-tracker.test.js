/**
 * 批次4-B3 失能打标 —— AssigneeIncapacitationTracker 单测.
 * docs/prd/batch4-codex-execution.md §3 B3.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

const {
  AssigneeIncapacitationTracker,
  toIncapacitationClassification,
  setActiveAssigneeIncapacitationTracker,
  getActiveAssigneeIncapacitationTracker,
} = await import('../dist/domains/cats/services/tasks/assignee-incapacitation-tracker.js');

describe('toIncapacitationClassification', () => {
  test('maps quota → quota_exhausted', () => {
    assert.equal(toIncapacitationClassification('quota'), 'quota_exhausted');
  });
  test('maps permission_denied → permission_denied', () => {
    assert.equal(toIncapacitationClassification('permission_denied'), 'permission_denied');
  });
  test('maps cli_crash and cli_stall → process_abnormal', () => {
    assert.equal(toIncapacitationClassification('cli_crash'), 'process_abnormal');
    assert.equal(toIncapacitationClassification('cli_stall'), 'process_abnormal');
  });
  test('transient_network is deliberately NOT incapacitating (expected to self-heal)', () => {
    assert.equal(toIncapacitationClassification('transient_network'), null);
  });
  test('everything else (aborted/context_overflow/output_truncated/agent_error) → null', () => {
    assert.equal(toIncapacitationClassification('aborted'), null);
    assert.equal(toIncapacitationClassification('context_overflow'), null);
    assert.equal(toIncapacitationClassification('output_truncated'), null);
    assert.equal(toIncapacitationClassification('agent_error'), null);
  });
});

describe('AssigneeIncapacitationTracker', () => {
  let tracker;
  beforeEach(() => {
    tracker = new AssigneeIncapacitationTracker();
  });

  test('never observed → getSignal returns undefined (not healthy, not incapacitated)', () => {
    assert.equal(tracker.getSignal('opus'), undefined);
  });

  test('first qualifying failure opens a streak with since=now', () => {
    tracker.recordFailure('opus', 'quota_exhausted', 1000);
    assert.deepEqual(tracker.getSignal('opus'), { kind: 'incapacitated', classification: 'quota_exhausted', since: 1000 });
  });

  test('a second failure while the streak is open extends it (classification updates, since stays)', () => {
    tracker.recordFailure('opus', 'quota_exhausted', 1000);
    tracker.recordFailure('opus', 'permission_denied', 5000);
    assert.deepEqual(tracker.getSignal('opus'), { kind: 'incapacitated', classification: 'permission_denied', since: 1000 });
  });

  test('防闪断: recordSuccess marks the cat explicitly healthy (not a bare deletion)', () => {
    tracker.recordFailure('opus', 'quota_exhausted', 1000);
    tracker.recordSuccess('opus');
    assert.deepEqual(tracker.getSignal('opus'), { kind: 'healthy' });
  });

  test('a fresh failure after being healthy opens a brand-new streak (since=the new failure time)', () => {
    tracker.recordFailure('opus', 'quota_exhausted', 1000);
    tracker.recordSuccess('opus');
    tracker.recordFailure('opus', 'process_abnormal', 9000);
    assert.deepEqual(tracker.getSignal('opus'), { kind: 'incapacitated', classification: 'process_abnormal', since: 9000 });
  });

  test('signals are tracked independently per cat', () => {
    tracker.recordFailure('opus', 'quota_exhausted', 1000);
    tracker.recordSuccess('gpt52');
    assert.equal(tracker.getSignal('opus').kind, 'incapacitated');
    assert.equal(tracker.getSignal('gpt52').kind, 'healthy');
    assert.equal(tracker.getSignal('dare'), undefined);
  });

  test('_resetForTests clears all signals back to the "never observed" state', () => {
    tracker.recordFailure('opus', 'quota_exhausted', 1000);
    tracker._resetForTests();
    assert.equal(tracker.getSignal('opus'), undefined);
  });
});

describe('module-level singleton accessor (mirrors StartupPermissionCheck.ts pattern)', () => {
  test('unset by default', () => {
    setActiveAssigneeIncapacitationTracker(undefined);
    assert.equal(getActiveAssigneeIncapacitationTracker(), undefined);
  });

  test('set/get round-trips the same instance', () => {
    const instance = new AssigneeIncapacitationTracker();
    setActiveAssigneeIncapacitationTracker(instance);
    assert.equal(getActiveAssigneeIncapacitationTracker(), instance);
    setActiveAssigneeIncapacitationTracker(undefined); // cleanup for other test files
  });
});
