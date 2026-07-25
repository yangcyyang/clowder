/**
 * Batch 3-A item 2: task↔run status linkage.
 * docs/research/clowder-raft-thread-task-design.md §5.2 rule 2.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

const { classifyRunFailureForTask, applyTaskRunOutcome } = await import(
  '../dist/domains/cats/services/tasks/task-run-linkage.js'
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

describe('classifyRunFailureForTask', () => {
  test('maps timeout-ish text to timeout', () => {
    assert.equal(classifyRunFailureForTask('CLI timed out after 300000ms'), 'timeout');
    assert.equal(classifyRunFailureForTask('runtime_hung: no output for 10m'), 'timeout');
  });

  test('maps infra-ish text to infra_error', () => {
    assert.equal(classifyRunFailureForTask('spawn claude ENOENT'), 'infra_error');
    assert.equal(classifyRunFailureForTask('connect ECONNREFUSED 127.0.0.1:1234'), 'infra_error');
    assert.equal(classifyRunFailureForTask('process_restart: worker crashed'), 'infra_error');
  });

  test('maps budget text to budget_exhausted (not a blocking class)', () => {
    assert.equal(classifyRunFailureForTask('budget_exhausted: quota reached'), 'budget_exhausted');
  });

  test('defaults everything else to agent_error', () => {
    assert.equal(classifyRunFailureForTask('assistant produced invalid JSON'), 'agent_error');
    assert.equal(classifyRunFailureForTask(undefined), 'agent_error');
  });
});

describe('applyTaskRunOutcome', () => {
  afterEach(() => {
    _resetTaskLifecycleNoticeDedupeForTests();
  });

  test('failed + timeout → task moves to blocked, with a lifecycle notice', async () => {
    const taskStore = new TaskStore();
    const messageStore = messageStoreStub();
    const socketManager = socketManagerStub();
    const created = taskStore.create({
      threadId: 't1',
      title: '修复登录超时',
      why: '',
      createdBy: 'user',
      ownerCatId: 'opus',
      status: 'doing',
    });

    const updated = await applyTaskRunOutcome({
      task: created,
      invocationId: 'inv-1',
      finalStatus: 'failed',
      errorText: 'CLI timed out after 300000ms',
      deps: { taskStore, messageStore, socketManager },
    });

    assert.equal(updated.status, 'blocked');
    assert.equal(updated.failureClass, 'timeout');
    const failedEvent = updated.events.find((event) => event.type === 'failed' && event.invocationId === 'inv-1');
    assert.ok(failedEvent, 'expected a failed event carrying the invocationId');
    assert.equal(failedEvent.data.taskStatus, 'blocked');
    assert.ok(
      messageStore.messages.some((msg) => msg.extra?.systemKind === 'task_status_changed'),
      'expected a task_status_changed lifecycle notice',
    );
    assert.ok(socketManager.events.some((event) => event.event === 'task_updated'));
  });

  test('failed + non-blocking class (e.g. agent_error) → task moves to failed', async () => {
    const taskStore = new TaskStore();
    const messageStore = messageStoreStub();
    const socketManager = socketManagerStub();
    const created = taskStore.create({
      threadId: 't1',
      title: '写单元测试',
      why: '',
      createdBy: 'user',
      ownerCatId: 'opus',
      status: 'doing',
    });

    const updated = await applyTaskRunOutcome({
      task: created,
      invocationId: 'inv-2',
      finalStatus: 'failed',
      errorText: 'assistant crashed with a stack trace',
      deps: { taskStore, messageStore, socketManager },
    });

    assert.equal(updated.status, 'failed');
    assert.equal(updated.failureClass, 'agent_error');
  });

  test('succeeded while task still doing → status untouched, only a run_succeeded event is appended, no notice', async () => {
    const taskStore = new TaskStore();
    const messageStore = messageStoreStub();
    const socketManager = socketManagerStub();
    const created = taskStore.create({
      threadId: 't1',
      title: '实现新接口',
      why: '',
      createdBy: 'user',
      ownerCatId: 'opus',
      status: 'doing',
    });

    const updated = await applyTaskRunOutcome({
      task: created,
      invocationId: 'inv-3',
      finalStatus: 'succeeded',
      deps: { taskStore, messageStore, socketManager },
    });

    assert.equal(updated.status, 'doing', 'platform must never auto-advance status on success');
    const runEvent = updated.events.find((event) => event.type === 'run_succeeded');
    assert.ok(runEvent, 'expected a run_succeeded bookkeeping event');
    assert.equal(runEvent.invocationId, 'inv-3');
    assert.equal(
      messageStore.messages.length,
      0,
      'a no-op status transition must not post a chat notice (Raft: only the cat marks in_review)',
    );
    assert.ok(socketManager.events.some((event) => event.event === 'task_updated'));
  });

  test('task already done → status left alone even on a failed linked run, but the event is still recorded', async () => {
    const taskStore = new TaskStore();
    const messageStore = messageStoreStub();
    const socketManager = socketManagerStub();
    const created = taskStore.create({
      threadId: 't1',
      title: '已完成的任务',
      why: '',
      createdBy: 'user',
      ownerCatId: 'opus',
      status: 'done',
    });

    const updated = await applyTaskRunOutcome({
      task: created,
      invocationId: 'inv-4',
      finalStatus: 'failed',
      errorText: 'stray retry timed out',
      deps: { taskStore, messageStore, socketManager },
    });

    assert.equal(updated.status, 'done', 'human verdict (done) must win over a stray failed run');
    const failedEvent = updated.events.find((event) => event.type === 'failed' && event.invocationId === 'inv-4');
    assert.ok(failedEvent, 'the failure should still be recorded as an event for traceability');
    assert.equal(failedEvent.data.statusChangeSkipped !== undefined, true);
    assert.equal(
      messageStore.messages.length,
      0,
      'no status actually changed, so no lifecycle notice should be posted',
    );
  });

  test('secrets in the run error text are redacted before being stored on the task', async () => {
    const taskStore = new TaskStore();
    const messageStore = messageStoreStub();
    const socketManager = socketManagerStub();
    const created = taskStore.create({
      threadId: 't1',
      title: '带密钥的失败',
      why: '',
      createdBy: 'user',
      ownerCatId: 'opus',
      status: 'doing',
    });

    const updated = await applyTaskRunOutcome({
      task: created,
      invocationId: 'inv-5',
      finalStatus: 'failed',
      errorText: 'infra_error: Bearer sk-secretvalue123456 rejected',
      deps: { taskStore, messageStore, socketManager },
    });

    assert.doesNotMatch(updated.failureReason ?? '', /sk-secretvalue123456/);
  });
});
