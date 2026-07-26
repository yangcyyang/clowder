/**
 * Legal task status transition guard (batch 2-C)
 * docs/research/clowder-raft-thread-task-design.md §5.2 rule 6:
 * "完成先置 in_review，人验过才 done"
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { isLegalTaskStatusTransition, resolveReviewerAvoidingSelfReview } = await import(
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

/**
 * 批次4-B1 B-AC1: "执行者永不 review 自己的票" —— 服务端校验.
 * docs/prd/batch4-codex-execution.md §3 B1: "拒绝或落回缺省"两种设计都被文档允许，但
 * B-AC1 验收标准明确写"执行者=reviewer 被服务端拒绝" —— 本实现按 AC 选择"拒绝"。
 */
describe('resolveReviewerAvoidingSelfReview', () => {
  test('candidate reviewer differs from owner — passes through unchanged', () => {
    const result = resolveReviewerAvoidingSelfReview({
      candidateReviewerId: 'gpt52',
      ownerCatId: 'opus',
      defaultReviewerId: 'human',
    });
    assert.deepEqual(result, { ok: true, reviewerId: 'gpt52' });
  });

  test('reviewerId is the literal human — never a self-review conflict regardless of owner', () => {
    const result = resolveReviewerAvoidingSelfReview({
      candidateReviewerId: 'human',
      ownerCatId: 'opus',
      defaultReviewerId: 'human',
    });
    assert.equal(result.ok, true);
  });

  test('no owner (unclaimed task) — no self-review possible', () => {
    const result = resolveReviewerAvoidingSelfReview({
      candidateReviewerId: 'opus',
      ownerCatId: null,
      defaultReviewerId: 'human',
    });
    assert.equal(result.ok, true);
  });

  test('B-AC1: candidate reviewer === owner (self-review) — rejected, not silently redirected', () => {
    const result = resolveReviewerAvoidingSelfReview({
      candidateReviewerId: 'opus',
      ownerCatId: 'opus',
      defaultReviewerId: 'gpt52',
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /不能自己审自己的票/);
    assert.equal(result.suggestedReviewerId, 'gpt52', 'suggests the platform default as the way forward');
  });

  test('self-review AND the configured default also equals the owner — suggests human as the final safe harbor', () => {
    const result = resolveReviewerAvoidingSelfReview({
      candidateReviewerId: 'opus',
      ownerCatId: 'opus',
      defaultReviewerId: 'opus',
    });
    assert.equal(result.ok, false);
    assert.equal(result.suggestedReviewerId, 'human');
  });
});
