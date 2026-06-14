/**
 * Vote utility tests.
 * Vote casting is explicit API state, not text parsed from agent prose.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('checkVoteCompletion', () => {
  test('returns true when all voters have voted', async () => {
    const { checkVoteCompletion } = await import('../dist/domains/votes/vote-utils.js');
    const state = {
      v: 1,
      question: 'test?',
      options: ['a', 'b'],
      votes: { opus: 'a', codex: 'b' },
      anonymous: false,
      deadline: Date.now() + 60000,
      createdBy: 'user-1',
      status: 'active',
      voters: ['opus', 'codex'],
    };
    assert.equal(checkVoteCompletion(state), true);
  });

  test('returns false when not all voters voted', async () => {
    const { checkVoteCompletion } = await import('../dist/domains/votes/vote-utils.js');
    const state = {
      v: 1,
      question: 'test?',
      options: ['a', 'b'],
      votes: { opus: 'a' },
      anonymous: false,
      deadline: Date.now() + 60000,
      createdBy: 'user-1',
      status: 'active',
      voters: ['opus', 'codex'],
    };
    assert.equal(checkVoteCompletion(state), false);
  });

  test('returns false when no voters field (Phase 1 compat)', async () => {
    const { checkVoteCompletion } = await import('../dist/domains/votes/vote-utils.js');
    const state = {
      v: 1,
      question: 'test?',
      options: ['a', 'b'],
      votes: { opus: 'a' },
      anonymous: false,
      deadline: Date.now() + 60000,
      createdBy: 'user-1',
      status: 'active',
    };
    assert.equal(checkVoteCompletion(state), false);
  });
});

describe('buildVoteNotification', () => {
  test('builds notification message with options', async () => {
    const { buildVoteNotification } = await import('../dist/domains/votes/vote-utils.js');
    const msg = buildVoteNotification('谁最绿茶？', ['opus', 'codex', 'gemini']);
    assert.ok(msg.includes('谁最绿茶？'));
    assert.ok(msg.includes('opus'));
    assert.ok(msg.includes('投票组件'));
  });
});

describe('buildVoteTally', () => {
  test('builds tally from votes', async () => {
    const { buildVoteTally } = await import('../dist/domains/votes/vote-utils.js');
    const tally = buildVoteTally(['a', 'b'], { u1: 'a', u2: 'a', u3: 'b' });
    assert.equal(tally.a, 2);
    assert.equal(tally.b, 1);
  });

  test('includes zero-vote options', async () => {
    const { buildVoteTally } = await import('../dist/domains/votes/vote-utils.js');
    const tally = buildVoteTally(['a', 'b', 'c'], { u1: 'a' });
    assert.equal(tally.a, 1);
    assert.equal(tally.b, 0);
    assert.equal(tally.c, 0);
  });
});
