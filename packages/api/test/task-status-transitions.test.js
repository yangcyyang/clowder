/**
 * Legal task status transition guard (batch 2-C)
 * docs/research/clowder-raft-thread-task-design.md §5.2 rule 6:
 * "完成先置 in_review，人验过才 done"
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { isLegalTaskStatusTransition } = await import(
  '../dist/domains/cats/services/tasks/task-status-transitions.js'
);

describe('isLegalTaskStatusTransition', () => {
  test('same-status no-op is always legal', () => {
    for (const status of ['todo', 'doing', 'in_review', 'blocked', 'done', 'failed']) {
      assert.equal(isLegalTaskStatusTransition(status, status).ok, true, `${status} -> ${status}`);
    }
  });

  test('cannot jump directly to done from todo/doing/blocked/failed', () => {
    for (const from of ['todo', 'doing', 'blocked', 'failed']) {
      const result = isLegalTaskStatusTransition(from, 'done');
      assert.equal(result.ok, false, `${from} -> done should be illegal`);
      assert.match(result.reason, /in_review/);
    }
  });

  test('in_review -> done is legal', () => {
    assert.equal(isLegalTaskStatusTransition('in_review', 'done').ok, true);
  });

  test('done is terminal — no transitions out of it', () => {
    for (const to of ['todo', 'doing', 'in_review', 'blocked', 'failed']) {
      const result = isLegalTaskStatusTransition('done', to);
      assert.equal(result.ok, false, `done -> ${to} should be illegal`);
      assert.match(result.reason, /terminal/);
    }
  });

  test('all other transitions are permissive (not a full state machine)', () => {
    assert.equal(isLegalTaskStatusTransition('todo', 'doing').ok, true);
    assert.equal(isLegalTaskStatusTransition('doing', 'blocked').ok, true);
    assert.equal(isLegalTaskStatusTransition('blocked', 'doing').ok, true);
    assert.equal(isLegalTaskStatusTransition('failed', 'todo').ok, true);
    assert.equal(isLegalTaskStatusTransition('in_review', 'doing').ok, true, 'rejected-back-to-work stays legal');
  });
});
