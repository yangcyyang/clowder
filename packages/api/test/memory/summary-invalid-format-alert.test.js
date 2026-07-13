import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';

const CONFIG = {
  pendingMessageThreshold: 20,
  pendingTokenThreshold: 1500,
  cooldownHours: 2,
  quietWindowMinutes: 10,
  perTickBudget: 5,
  backfillIntervalMs: 2000,
  driftAlertTokenThreshold: 800,
  maxTopicSegments: 3,
  minSplitMessageCount: 8,
  minSplitTokenCount: 600,
  schedulerIntervalMs: 30 * 60 * 1000,
};

function identity(modelId = 'codex-cli:gpt52:gpt-5.5', promptVersion = 'g2-thread-abstract-v2') {
  return { providerId: 'codex-cli', modelId, promptVersion };
}

function invalidOutcome(modelId, promptVersion) {
  return { kind: 'invalid_format', attempts: 2, identity: identity(modelId, promptVersion) };
}

function validOutcome(messages, modelId = 'codex-cli:gpt52:gpt-5.5') {
  return {
    kind: 'ok',
    attempts: 1,
    identity: identity(modelId),
    result: {
      segments: [
        {
          summary:
            '当前状态/任务：验证摘要告警。\n已确认决策/约束：仅格式错误重试。\n下一步：写入摘要。\n风险/锚点：回看消息水位。',
          topicKey: 'summary-alert',
          topicLabel: 'Summary Alert',
          boundaryReason: 'single batch',
          boundaryConfidence: 'high',
          fromMessageId: messages[0].id,
          toMessageId: messages.at(-1).id,
          messageCount: messages.length,
        },
      ],
    },
  };
}

function setupDb(applyMigrations) {
  const db = new Database(':memory:');
  applyMigrations(db);
  db.prepare(
    `INSERT INTO evidence_docs (anchor, kind, status, title, summary, updated_at)
     VALUES (?, 'thread', 'active', ?, ?, ?)`,
  ).run('thread-alert-thread', 'Alert Thread', 'Previous summary', new Date().toISOString());
  db.prepare(
    `INSERT INTO summary_state
     (thread_id, pending_message_count, pending_token_count, pending_signal_flags, summary_type)
     VALUES (?, 25, 2000, 0, 'concat')`,
  ).run('alert-thread');
  return db;
}

function makeMessages() {
  return Array.from({ length: 25 }, (_, index) => ({
    id: `msg-${String(index + 1).padStart(3, '0')}`,
    content: `Summary alert message ${index + 1}`,
    catId: 'codex',
    timestamp: Date.now() - (25 - index) * 60_000,
  }));
}

describe('summary invalid-format retry state', () => {
  it('latches on the third identical run and resets when the batch identity changes', async () => {
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    const { processThread, SummaryInvalidFormatAlertError } = await import(
      '../../dist/domains/memory/SummaryCompactionTask.js'
    );
    const db = setupDb(applyMigrations);
    let messages = makeMessages();
    let modelId = 'codex-cli:gpt52:gpt-5.5';
    let promptVersion = 'g2-thread-abstract-v2';
    const deps = {
      db,
      enabled: () => true,
      getThreadLastActivity: async () => ({
        threadId: 'alert-thread',
        lastMessageAt: Date.now() - 20 * 60 * 1000,
      }),
      getMessagesAfterWatermark: async () => ({
        messages,
        scannedThroughMessageId: messages.at(-1).id,
        excludedPrivateCount: 0,
      }),
      generateAbstractive: async () => invalidOutcome(modelId, promptVersion),
      logger: { info() {}, error() {} },
    };
    const state = db.prepare('SELECT * FROM summary_state WHERE thread_id = ?').get('alert-thread');

    assert.equal(await processThread(state, deps, CONFIG), false);
    assert.equal(await processThread(state, deps, CONFIG), false);
    await assert.rejects(() => processThread(state, deps, CONFIG), SummaryInvalidFormatAlertError);

    let persisted = db.prepare('SELECT * FROM summary_state WHERE thread_id = ?').get('alert-thread');
    assert.equal(persisted.invalid_format_streak, 3);
    assert.equal(persisted.invalid_format_latched, 1);

    assert.equal(await processThread(state, deps, CONFIG), false, 'latched runs remain fail-open');
    persisted = db.prepare('SELECT * FROM summary_state WHERE thread_id = ?').get('alert-thread');
    assert.equal(persisted.invalid_format_streak, 4);
    assert.equal(persisted.invalid_format_latched, 1);

    modelId = 'codex-cli:gpt52:gpt-5.6';
    assert.equal(await processThread(state, deps, CONFIG), false);
    persisted = db.prepare('SELECT * FROM summary_state WHERE thread_id = ?').get('alert-thread');
    assert.equal(persisted.invalid_format_streak, 1);
    assert.equal(persisted.invalid_format_latched, 0);

    promptVersion = 'g2-thread-abstract-v3';
    assert.equal(await processThread(state, deps, CONFIG), false);
    persisted = db.prepare('SELECT * FROM summary_state WHERE thread_id = ?').get('alert-thread');
    assert.equal(persisted.invalid_format_streak, 1);
    assert.equal(persisted.invalid_format_latched, 0);

    messages = messages.map((message, index) =>
      index === 0 ? { ...message, content: `${message.content} changed batch` } : message,
    );
    assert.equal(await processThread(state, deps, CONFIG), false);
    persisted = db.prepare('SELECT * FROM summary_state WHERE thread_id = ?').get('alert-thread');
    assert.equal(persisted.invalid_format_streak, 1);
    assert.equal(persisted.invalid_format_latched, 0);
  });

  it('success clears the persisted invalid streak in the same compaction transaction', async () => {
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    const { processThread } = await import('../../dist/domains/memory/SummaryCompactionTask.js');
    const db = setupDb(applyMigrations);
    const messages = makeMessages();
    let valid = false;
    const deps = {
      db,
      enabled: () => true,
      getThreadLastActivity: async () => ({
        threadId: 'alert-thread',
        lastMessageAt: Date.now() - 20 * 60 * 1000,
      }),
      getMessagesAfterWatermark: async () => ({
        messages,
        scannedThroughMessageId: messages.at(-1).id,
        excludedPrivateCount: 0,
      }),
      generateAbstractive: async () => (valid ? validOutcome(messages) : invalidOutcome()),
      logger: { info() {}, error() {} },
    };
    const state = db.prepare('SELECT * FROM summary_state WHERE thread_id = ?').get('alert-thread');
    await processThread(state, deps, CONFIG);
    await processThread(state, deps, CONFIG);
    valid = true;
    assert.equal(await processThread(state, deps, CONFIG), true);

    const persisted = db.prepare('SELECT * FROM summary_state WHERE thread_id = ?').get('alert-thread');
    assert.equal(persisted.invalid_format_batch_key, null);
    assert.equal(persisted.invalid_format_streak, 0);
    assert.equal(persisted.invalid_format_latched, 0);
  });

  it('still latches after three invalid runs on one fixed post-reset batch', async () => {
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    const { processThread, SummaryInvalidFormatAlertError } = await import(
      '../../dist/domains/memory/SummaryCompactionTask.js'
    );
    const db = setupDb(applyMigrations);
    const messages = makeMessages();
    const deps = {
      db,
      enabled: () => true,
      getThreadLastActivity: async () => ({
        threadId: 'alert-thread',
        lastMessageAt: Date.now() - 20 * 60 * 1000,
      }),
      getContextResetBoundary: async () => ({ contextEpoch: 1, resetAtMessageId: 'msg-000', resetAt: 1 }),
      getMessagesAfterWatermark: async () => ({
        messages,
        scannedThroughMessageId: messages.at(-1).id,
        excludedPrivateCount: 0,
      }),
      generateAbstractive: async () => invalidOutcome(),
      logger: { info() {}, error() {} },
    };
    const state = db.prepare('SELECT * FROM summary_state WHERE thread_id = ?').get('alert-thread');

    assert.equal(await processThread(state, deps, CONFIG), false);
    assert.equal(await processThread(state, deps, CONFIG), false);
    await assert.rejects(() => processThread(state, deps, CONFIG), SummaryInvalidFormatAlertError);
    const persisted = db.prepare('SELECT * FROM summary_state WHERE thread_id = ?').get('alert-thread');
    assert.equal(persisted.invalid_format_streak, 3);
    assert.equal(persisted.invalid_format_latched, 1);
  });

  it('records exactly one RUN_FAILED and one error log when the third run crosses the latch', async () => {
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    const { createSummaryCompactionTaskSpec } = await import('../../dist/domains/memory/SummaryCompactionTaskSpec.js');
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    const { RunLedger } = await import('../../dist/infrastructure/scheduler/RunLedger.js');
    const db = setupDb(applyMigrations);
    const messages = makeMessages();
    const errors = [];
    const logger = {
      info() {},
      error(message) {
        errors.push(message);
      },
    };
    const spec = createSummaryCompactionTaskSpec({
      db,
      enabled: () => true,
      getThreadLastActivity: async () => ({
        threadId: 'alert-thread',
        lastMessageAt: Date.now() - 20 * 60 * 1000,
      }),
      getMessagesAfterWatermark: async () => ({
        messages,
        scannedThroughMessageId: messages.at(-1).id,
        excludedPrivateCount: 0,
      }),
      generateAbstractive: async () => invalidOutcome(),
      logger,
    });
    const ledger = new RunLedger(db);
    const lifecycleNotices = [];
    const runner = new TaskRunnerV2({
      logger,
      ledger,
      notifyLifecycle: (notice) => lifecycleNotices.push(notice),
    });
    runner.register(spec);

    await runner.triggerNow('summary-compact');
    await runner.triggerNow('summary-compact');
    await runner.triggerNow('summary-compact');
    await runner.triggerNow('summary-compact');

    const runs = ledger.query('summary-compact', 10);
    assert.equal(runs.filter((run) => run.outcome === 'RUN_FAILED').length, 1);
    assert.equal(errors.length, 1);
    assert.equal(lifecycleNotices.length, 0, 'built-in summary task must not emit a channel lifecycle notice');
    assert.match(errors[0], /summary-compact\/thread-alert-thread: failed/);
  });
});
