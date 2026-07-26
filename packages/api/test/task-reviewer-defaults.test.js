/**
 * 批次4-B1: reviewer 缺省规则单测.
 * docs/prd/batch4-codex-execution.md §3 B1: "人建的票 → 常设 gate(未配置=human);
 * agent 子票 → 继承父票 reviewer".
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { resolveConfiguredDefaultReviewerId, resolveReviewerIdForNewTask, isGateReviewer, HUMAN_REVIEWER } =
  await import('../dist/domains/cats/services/tasks/task-reviewer-defaults.js');
const { catRegistry } = await import('@cat-cafe/shared');

const TEST_CAT_ID = 'opus';

describe('resolveConfiguredDefaultReviewerId', () => {
  test('unset env → human', () => {
    assert.equal(resolveConfiguredDefaultReviewerId({}), HUMAN_REVIEWER);
  });

  test('blank env → human', () => {
    assert.equal(resolveConfiguredDefaultReviewerId({ CLOWDER_TASK_DEFAULT_REVIEWER: '   ' }), HUMAN_REVIEWER);
  });

  test('configured to a registered cat → that cat', () => {
    assert.ok(catRegistry.has(TEST_CAT_ID), 'fixture assumption: test cat registry seeds this id');
    assert.equal(
      resolveConfiguredDefaultReviewerId({ CLOWDER_TASK_DEFAULT_REVIEWER: TEST_CAT_ID }),
      TEST_CAT_ID,
    );
  });

  test('configured to a cat that is not registered → fail-open to human', () => {
    assert.equal(
      resolveConfiguredDefaultReviewerId({ CLOWDER_TASK_DEFAULT_REVIEWER: 'not-a-real-cat-xyz' }),
      HUMAN_REVIEWER,
    );
  });
});

describe('resolveReviewerIdForNewTask', () => {
  test('no parent task → platform default', () => {
    assert.equal(
      resolveReviewerIdForNewTask({ parentTask: null, env: { CLOWDER_TASK_DEFAULT_REVIEWER: TEST_CAT_ID } }),
      TEST_CAT_ID,
    );
  });

  test('parent task with a reviewer → inherits it, ignoring the platform default', () => {
    assert.equal(
      resolveReviewerIdForNewTask({
        parentTask: { reviewerId: 'gpt52' },
        env: { CLOWDER_TASK_DEFAULT_REVIEWER: TEST_CAT_ID },
      }),
      'gpt52',
    );
  });

  test('parent task WITHOUT a reviewer (legacy pre-batch-4 task) → falls through to platform default', () => {
    assert.equal(
      resolveReviewerIdForNewTask({
        parentTask: { reviewerId: undefined },
        env: { CLOWDER_TASK_DEFAULT_REVIEWER: TEST_CAT_ID },
      }),
      TEST_CAT_ID,
    );
  });

  test('no env override and no parent → human', () => {
    assert.equal(resolveReviewerIdForNewTask({ parentTask: null, env: {} }), HUMAN_REVIEWER);
  });
});

describe('isGateReviewer', () => {
  test('a registered cat id is a gate reviewer', () => {
    assert.equal(isGateReviewer(TEST_CAT_ID), true);
  });

  test("the literal 'human' is never a gate reviewer", () => {
    assert.equal(isGateReviewer(HUMAN_REVIEWER), false);
  });

  test('undefined is never a gate reviewer', () => {
    assert.equal(isGateReviewer(undefined), false);
  });

  test('an unregistered catId string is never a gate reviewer', () => {
    assert.equal(isGateReviewer('not-a-real-cat-xyz'), false);
  });
});
