/**
 * F194 Raft-parity batch 3-C: computed sidebar `kind` derivation.
 * See docs/research/clowder-raft-thread-task-design.md §1/§4 and
 * ports/ThreadStore.ts `computeThreadKind`.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('computeThreadKind', () => {
  test('id === "default" derives lobby regardless of other flags', async () => {
    const { computeThreadKind } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    assert.equal(computeThreadKind({ id: 'default', isDM: false, relation: undefined }), 'lobby');
    // Lobby wins even over isDM/relation — matches derivation order (kindOverride → lobby → dm → ...).
    assert.equal(
      computeThreadKind({
        id: 'default',
        isDM: true,
        relation: { v: 1, kind: 'task_thread', parentThreadId: 'p', rootMessageId: 'm' },
      }),
      'lobby',
    );
  });

  test('isDM derives dm', async () => {
    const { computeThreadKind } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    assert.equal(computeThreadKind({ id: 'thread-1', isDM: true, relation: undefined }), 'dm');
  });

  test('relation.kind task_thread/message_thread derives task_discussion', async () => {
    const { computeThreadKind } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    assert.equal(
      computeThreadKind({
        id: 'thread-1',
        isDM: false,
        relation: { v: 1, kind: 'task_thread', parentThreadId: 'p', rootMessageId: 'm' },
      }),
      'task_discussion',
    );
    assert.equal(
      computeThreadKind({
        id: 'thread-2',
        isDM: false,
        relation: { v: 1, kind: 'message_thread', parentThreadId: 'p', rootMessageId: 'm' },
      }),
      'task_discussion',
    );
  });

  test('relation.kind inline_reply/edit_branch derives branch', async () => {
    const { computeThreadKind } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    assert.equal(
      computeThreadKind({
        id: 'thread-3',
        isDM: false,
        relation: { v: 1, kind: 'inline_reply', parentThreadId: 'p', rootMessageId: 'm' },
      }),
      'branch',
    );
    assert.equal(
      computeThreadKind({
        id: 'thread-4',
        isDM: false,
        relation: { v: 1, kind: 'edit_branch', parentThreadId: 'p', rootMessageId: 'm' },
      }),
      'branch',
    );
  });

  test('no relation, not dm, not default derives channel', async () => {
    const { computeThreadKind } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    assert.equal(computeThreadKind({ id: 'thread-5', isDM: false, relation: undefined }), 'channel');
  });

  test('kindOverride wins over every other signal', async () => {
    const { computeThreadKind } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    assert.equal(
      computeThreadKind({
        id: 'default',
        isDM: true,
        relation: { v: 1, kind: 'task_thread', parentThreadId: 'p', rootMessageId: 'm' },
        kindOverride: 'channel',
      }),
      'channel',
    );
  });

  test('ThreadStore.updateKindOverride sets/clears the override and read-time derivation reflects it', async () => {
    const { ThreadStore, computeThreadKind } = await import(
      '../dist/domains/cats/services/stores/ports/ThreadStore.js'
    );
    const store = new ThreadStore();
    const thread = store.create('alice', 'Some Channel');
    assert.equal(computeThreadKind(store.get(thread.id)), 'channel');

    store.updateKindOverride(thread.id, 'task_discussion');
    assert.equal(computeThreadKind(store.get(thread.id)), 'task_discussion');

    store.updateKindOverride(thread.id, null);
    assert.equal(computeThreadKind(store.get(thread.id)), 'channel');
  });
});
