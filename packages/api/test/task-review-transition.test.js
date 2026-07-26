/**
 * 批次4-B1 + B4①③: 进入 in_review 的统一处理 —— reviewer 缺省/自审拒绝/唤醒投递 +
 * 证据自动锚定 + 静态扫描。docs/prd/batch4-codex-execution.md §3 B1/B4。
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

const { prepareReviewEntry, onTaskEnteredReview, prepareReviewActionEvent } = await import(
  '../dist/domains/cats/services/tasks/task-review-transition.js'
);
const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
const { _resetTaskLifecycleNoticeDedupeForTests } = await import('../dist/routes/task-event-notices.js');

function messageStoreStub() {
  const messages = [];
  return {
    messages,
    async append(input) {
      const stored = { ...input, id: `msg-${messages.length + 1}` };
      messages.push(stored);
      return stored;
    },
  };
}

function socketManagerStub() {
  const events = [];
  return { events, broadcastToRoom: (room, event, payload) => events.push({ room, event, payload }) };
}

function invocationQueueStub() {
  const enqueued = [];
  return {
    enqueued,
    hasActiveIdempotencyKey: () => false,
    enqueue(input) {
      const entry = { id: `entry-${enqueued.length + 1}`, ...input };
      enqueued.push(entry);
      return { outcome: 'enqueued', entry, deduped: false, queuePosition: enqueued.length };
    },
    async persistEntry() {},
  };
}

describe('prepareReviewEntry (B1 reviewer 缺省 + B-AC1 自审拒绝)', () => {
  test('legacy task with no reviewerId → resolves to the configured default', () => {
    const result = prepareReviewEntry(
      { reviewerId: undefined, ownerCatId: 'opus' },
      { CLOWDER_TASK_DEFAULT_REVIEWER: 'gpt52' },
    );
    assert.equal(result.ok, true);
    assert.equal(result.reviewerId, 'gpt52');
    assert.equal(result.events[0].type, 'review_requested');
    assert.equal(result.events[0].data.reviewerId, 'gpt52');
  });

  test('no env configured, no reviewerId set → human', () => {
    const result = prepareReviewEntry({ reviewerId: undefined, ownerCatId: 'opus' }, {});
    assert.equal(result.ok, true);
    assert.equal(result.reviewerId, 'human');
  });

  test('B-AC1: reviewerId === ownerCatId (self-review) → rejected', () => {
    const result = prepareReviewEntry({ reviewerId: 'opus', ownerCatId: 'opus' }, { CLOWDER_TASK_DEFAULT_REVIEWER: 'gpt52' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /不能自己审自己的票/);
    assert.equal(result.suggestedReviewerId, 'gpt52');
  });

  test('gate track (registered cat reviewer, distinct from owner) — passes through', () => {
    const result = prepareReviewEntry({ reviewerId: 'gpt52', ownerCatId: 'opus' }, {});
    assert.equal(result.ok, true);
    assert.equal(result.reviewerId, 'gpt52');
  });
});

describe('prepareReviewActionEvent (B4④ 验收动作留痕)', () => {
  test('leaving in_review → done records a review_action_recorded event with the evidence pointer', () => {
    const events = prepareReviewActionEvent({
      previousStatus: 'in_review',
      nextStatus: 'done',
      previousEvents: [
        { ts: '2026-01-01T00:00:00.000Z', catId: 'system', type: 'evidence_anchored', data: {} },
      ],
      actorId: 'gpt52',
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'review_action_recorded');
    assert.equal(events[0].data.from, 'in_review');
    assert.equal(events[0].data.to, 'done');
    assert.equal(events[0].data.actorId, 'gpt52');
    assert.equal(events[0].data.evidenceEventTs, '2026-01-01T00:00:00.000Z');
  });

  test('not leaving in_review (e.g. todo → doing) → no event', () => {
    assert.deepEqual(
      prepareReviewActionEvent({ previousStatus: 'todo', nextStatus: 'doing', previousEvents: [], actorId: 'opus' }),
      [],
    );
  });

  test('entering in_review (not leaving) → no event', () => {
    assert.deepEqual(
      prepareReviewActionEvent({ previousStatus: 'doing', nextStatus: 'in_review', previousEvents: [], actorId: 'opus' }),
      [],
    );
  });
});

describe('onTaskEnteredReview (B1 gate 唤醒投递 + B4①③ 证据锚定)', () => {
  afterEach(() => {
    _resetTaskLifecycleNoticeDedupeForTests();
  });

  test('gate reviewer (registered cat) → durable enqueue wake-up fires, targeting the reviewer', async () => {
    const taskStore = new TaskStore();
    const messageStore = messageStoreStub();
    const socketManager = socketManagerStub();
    const invocationQueue = invocationQueueStub();
    const task = taskStore.create({
      threadId: 't1',
      title: '待验收任务',
      why: '',
      createdBy: 'opus',
      ownerCatId: 'opus',
      status: 'in_review',
      reviewerId: 'gpt52',
    });

    await onTaskEnteredReview(task, {
      taskStore,
      threadStore: { async get() { return null; } },
      messageStore,
      socketManager,
      invocationQueue,
      queueProcessor: { async tryAutoExecute() {} },
      env: { CLOWDER_REVIEW_EVIDENCE_AUTO_ANCHOR: '0' }, // isolate this test to the wake-up path
    });

    assert.equal(invocationQueue.enqueued.length, 1, 'expected exactly one wake-up enqueue');
    assert.deepEqual(invocationQueue.enqueued[0].targetCats, ['gpt52']);
    assert.equal(invocationQueue.enqueued[0].sourceCategory, 'gate_review_wakeup');
  });

  test('human reviewer → no wake-up enqueue attempted (relies on the existing visible notice)', async () => {
    const taskStore = new TaskStore();
    const messageStore = messageStoreStub();
    const socketManager = socketManagerStub();
    const invocationQueue = invocationQueueStub();
    const task = taskStore.create({
      threadId: 't1',
      title: '待验收任务(人工)',
      why: '',
      createdBy: 'opus',
      ownerCatId: 'opus',
      status: 'in_review',
      reviewerId: 'human',
    });

    await onTaskEnteredReview(task, {
      taskStore,
      messageStore,
      socketManager,
      invocationQueue,
      env: { CLOWDER_REVIEW_EVIDENCE_AUTO_ANCHOR: '0' },
    });

    assert.equal(invocationQueue.enqueued.length, 0);
  });

  test('B4①③: evidence anchor posts commit sha/diff stat/file list + flags a secret-shaped string via a fake git runner', async () => {
    // task-review-evidence.ts's captureGitEvidence accepts an injected GitRunner — this test
    // exercises the full anchor pipeline (repo resolution → snapshot → static scan → notice +
    // ledger event) WITHOUT depending on a real git checkout, by resolving the repo dir to
    // process.cwd() (no threadStore bound project) and faking every git subprocess call.
    const taskStore = new TaskStore();
    const messageStore = messageStoreStub();
    const socketManager = socketManagerStub();
    const task = taskStore.create({
      threadId: 't1',
      title: '证据锚定任务',
      why: '',
      createdBy: 'opus',
      ownerCatId: 'opus',
      status: 'in_review',
      reviewerId: 'human',
    });

    const { anchorReviewEvidence } = await import('../dist/domains/cats/services/tasks/task-review-evidence.js');
    const fakeGit = async (_cwd, args) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'abc123deadbeef\n';
      if (args[0] === 'rev-parse') return 'parentsha\n'; // HEAD~1 exists
      if (args[0] === 'diff' && args.includes('--stat')) return ' src/foo.ts | 2 +-\n1 file changed\n';
      if (args[0] === 'diff' && args.includes('--numstat')) return '1\t1\tsrc/foo.ts\n';
      if (args[0] === 'diff' && args.includes('--name-only')) return 'src/foo.ts\n';
      if (args[0] === 'diff') return '+const key = "sk-abcdefghijklmnop";\n';
      if (args[0] === 'status') return ''; // clean working tree
      return null;
    };

    await anchorReviewEvidence(task, { taskStore, messageStore, socketManager, git: fakeGit });

    const posted = messageStore.messages.find((m) => m.content.includes('验收证据自动锚定'));
    assert.ok(posted, 'expected an evidence-anchor notice to be posted');
    assert.match(posted.content, /abc123deadbeef/);
    assert.match(posted.content, /src\/foo\.ts/);
    assert.match(posted.content, /密钥形态字符串/, '密钥形态 diff 应被静态扫描标记');

    const updated = await taskStore.get(task.id);
    const anchoredEvent = (updated.events ?? []).find((e) => e.type === 'evidence_anchored');
    assert.ok(anchoredEvent, 'expected an evidence_anchored ledger event');
    assert.equal(anchoredEvent.data.commitSha, 'abc123deadbeef');
    assert.equal(anchoredEvent.data.hasUncommittedChanges, false);
    assert.ok(anchoredEvent.data.scanFlags.some((f) => f.includes('密钥形态')));
  });

  test('B4③: bare NUL control character in the diff is flagged', async () => {
    const taskStore = new TaskStore();
    const messageStore = messageStoreStub();
    const socketManager = socketManagerStub();
    const task = taskStore.create({
      threadId: 't1',
      title: '裸控制字符任务',
      why: '',
      createdBy: 'opus',
      ownerCatId: 'opus',
      status: 'in_review',
    });

    const { anchorReviewEvidence } = await import('../dist/domains/cats/services/tasks/task-review-evidence.js');
    const fakeGit = async (_cwd, args) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'shawithnul\n';
      if (args[0] === 'rev-parse') return null; // no parent — first commit
      if (args[0] === 'diff' && args.includes('--stat')) return '1 file changed\n';
      if (args[0] === 'diff' && args.includes('--numstat')) return '1\t0\tsrc/bad.ts\n';
      if (args[0] === 'diff' && args.includes('--name-only')) return 'src/bad.ts\n';
      if (args[0] === 'diff') return `+const x = "a\x00b";\n`;
      if (args[0] === 'status') return 'M src/bad.ts\n';
      return null;
    };

    await anchorReviewEvidence(task, { taskStore, messageStore, socketManager, git: fakeGit });
    const updated = await taskStore.get(task.id);
    const anchoredEvent = (updated.events ?? []).find((e) => e.type === 'evidence_anchored');
    assert.ok(anchoredEvent.data.scanFlags.some((f) => f.includes('裸控制字符')));
    assert.equal(anchoredEvent.data.hasUncommittedChanges, true, 'status --porcelain 非空应标记未提交改动');
  });

  test('B4③: binary file changes are flagged via numstat markers', async () => {
    const taskStore = new TaskStore();
    const messageStore = messageStoreStub();
    const socketManager = socketManagerStub();
    const task = taskStore.create({
      threadId: 't1',
      title: '二进制文件任务',
      why: '',
      createdBy: 'opus',
      ownerCatId: 'opus',
      status: 'in_review',
    });

    const { anchorReviewEvidence } = await import('../dist/domains/cats/services/tasks/task-review-evidence.js');
    const fakeGit = async (_cwd, args) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'shabin\n';
      if (args[0] === 'rev-parse') return null;
      if (args[0] === 'diff' && args.includes('--stat')) return 'Bin 0 -> 1024 bytes\n';
      if (args[0] === 'diff' && args.includes('--numstat')) return '-\t-\tassets/logo.png\n';
      if (args[0] === 'diff' && args.includes('--name-only')) return 'assets/logo.png\n';
      if (args[0] === 'diff') return '';
      if (args[0] === 'status') return '';
      return null;
    };

    await anchorReviewEvidence(task, { taskStore, messageStore, socketManager, git: fakeGit });
    const updated = await taskStore.get(task.id);
    const anchoredEvent = (updated.events ?? []).find((e) => e.type === 'evidence_anchored');
    assert.ok(anchoredEvent.data.scanFlags.some((f) => f.includes('二进制文件')));
  });

  test('git snapshot unavailable (no repo / rev-parse fails) → best-effort no-op, never throws', async () => {
    const taskStore = new TaskStore();
    const messageStore = messageStoreStub();
    const socketManager = socketManagerStub();
    const task = taskStore.create({
      threadId: 't1',
      title: '无仓库任务',
      why: '',
      createdBy: 'opus',
      ownerCatId: 'opus',
      status: 'in_review',
    });

    const { anchorReviewEvidence } = await import('../dist/domains/cats/services/tasks/task-review-evidence.js');
    await assert.doesNotReject(
      anchorReviewEvidence(task, { taskStore, messageStore, socketManager, git: async () => null }),
    );
    assert.equal(messageStore.messages.length, 0, 'no evidence to anchor — nothing should be posted');
    const updated = await taskStore.get(task.id);
    assert.equal((updated.events ?? []).some((e) => e.type === 'evidence_anchored'), false);
  });

  test('env kill switch off → evidence anchoring is a complete no-op', async () => {
    const taskStore = new TaskStore();
    const messageStore = messageStoreStub();
    const socketManager = socketManagerStub();
    const task = taskStore.create({
      threadId: 't1',
      title: '关闭证据锚定',
      why: '',
      createdBy: 'opus',
      ownerCatId: 'opus',
      status: 'in_review',
    });

    const { anchorReviewEvidence } = await import('../dist/domains/cats/services/tasks/task-review-evidence.js');
    let gitCalled = false;
    await anchorReviewEvidence(task, {
      taskStore,
      messageStore,
      socketManager,
      env: { CLOWDER_REVIEW_EVIDENCE_AUTO_ANCHOR: '0' },
      git: async () => {
        gitCalled = true;
        return null;
      },
    });
    assert.equal(gitCalled, false, 'kill switch must prevent even attempting a git call');
  });
});
