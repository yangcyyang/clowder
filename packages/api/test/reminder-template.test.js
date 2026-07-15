import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { SCHEDULER_TRIGGER_PREFIX } from '@cat-cafe/shared';
import { reminderTemplate } from '../dist/infrastructure/scheduler/templates/reminder.js';

describe('reminderTemplate', () => {
  it('gate returns run:true with thread workItem when deliveryThreadId set', async () => {
    const spec = reminderTemplate.createSpec('rem-1', {
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { message: '喝水提醒' },
      deliveryThreadId: 'th-abc',
    });
    const result = await spec.admission.gate({ taskId: 'rem-1', lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, true);
    assert.equal(result.workItems[0].subjectKey, 'thread-th-abc');
    assert.equal(result.workItems[0].signal, '喝水提醒');
  });

  it('gate returns run:false when no deliveryThreadId', async () => {
    const spec = reminderTemplate.createSpec('rem-2', {
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { message: 'test' },
      deliveryThreadId: null,
    });
    const result = await spec.admission.gate({ taskId: 'rem-2', lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, false);
  });

  it('execute calls deliver with message content and threadId', async () => {
    const deliverMock = mock.fn(async () => 'msg-1');
    const triggerMock = { trigger: mock.fn() };
    const spec = reminderTemplate.createSpec('rem-3', {
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { message: '喝水提醒' },
      deliveryThreadId: 'th-abc',
    });
    await spec.run.execute('喝水提醒', 'thread-th-abc', {
      assignedCatId: 'opus',
      deliver: deliverMock,
      invokeTrigger: triggerMock,
    });
    assert.equal(deliverMock.mock.calls.length, 1);
    const arg = deliverMock.mock.calls[0].arguments[0];
    assert.equal(arg.content, `${SCHEDULER_TRIGGER_PREFIX} 喝水提醒`);
    assert.equal(arg.threadId, 'th-abc');
    assert.equal(arg.catId, undefined);
    assert.equal(arg.extra.scheduler.hiddenTrigger, true);
  });

  it('marks window-primer replies as silent receipts without silencing ordinary reminders', async () => {
    const triggerMock = { trigger: mock.fn() };
    const primerSpec = reminderTemplate.createSpec('rem-primer', {
      trigger: { type: 'cron', expression: '0 10 * * *' },
      params: { message: 'window-primer：只需回复「Codex 窗口已激活 + 当前时间」' },
      deliveryThreadId: 'th-primer',
    });
    await primerSpec.run.execute('primer', 'thread-th-primer', {
      assignedCatId: 'gpt52',
      deliver: mock.fn(async () => 'msg-primer'),
      invokeTrigger: triggerMock,
    });

    const primerPolicy = triggerMock.trigger.mock.calls[0].arguments[6];
    assert.equal(primerPolicy.sourceCategory, 'scheduled');
    assert.equal(primerPolicy.responsePresentation, 'silent_receipt');

    triggerMock.trigger.mock.resetCalls();
    const mentionedPrimerSpec = reminderTemplate.createSpec('rem-mentioned-primer', {
      trigger: { type: 'cron', expression: '0 10 * * *' },
      params: { message: '@研究生 window-primer：只需回复「Claude 窗口已激活 + 当前时间」' },
      deliveryThreadId: 'th-mentioned-primer',
    });
    await mentionedPrimerSpec.run.execute('mentioned primer', 'thread-th-mentioned-primer', {
      assignedCatId: 'claude-sonnet5',
      deliver: mock.fn(async () => 'msg-mentioned-primer'),
      invokeTrigger: triggerMock,
    });
    assert.equal(triggerMock.trigger.mock.calls[0].arguments[6].responsePresentation, 'silent_receipt');

    triggerMock.trigger.mock.resetCalls();
    const asciiMentionedPrimerSpec = reminderTemplate.createSpec('rem-ascii-mentioned-primer', {
      trigger: { type: 'cron', expression: '30 10 * * *' },
      params: { message: '@gpt52 window-primer: reply with the current time' },
      deliveryThreadId: 'th-ascii-mentioned-primer',
    });
    await asciiMentionedPrimerSpec.run.execute('ascii mentioned primer', 'thread-th-ascii-mentioned-primer', {
      assignedCatId: 'gpt52',
      deliver: mock.fn(async () => 'msg-ascii-mentioned-primer'),
      invokeTrigger: triggerMock,
    });
    assert.equal(triggerMock.trigger.mock.calls[0].arguments[6].responsePresentation, 'silent_receipt');

    triggerMock.trigger.mock.resetCalls();
    const ordinarySpec = reminderTemplate.createSpec('rem-water', {
      trigger: { type: 'cron', expression: '0 11 * * *' },
      params: { message: '喝水提醒' },
      deliveryThreadId: 'th-water',
    });
    await ordinarySpec.run.execute('喝水提醒', 'thread-th-water', {
      assignedCatId: 'gpt52',
      deliver: mock.fn(async () => 'msg-water'),
      invokeTrigger: triggerMock,
    });
    assert.equal(triggerMock.trigger.mock.calls[0].arguments[6].responsePresentation, undefined);

    triggerMock.trigger.mock.resetCalls();
    const markerSentenceSpec = reminderTemplate.createSpec('rem-marker-sentence', {
      trigger: { type: 'cron', expression: '0 12 * * *' },
      params: { message: '复盘 window-primer: 配置，不要隐藏这条提醒' },
      deliveryThreadId: 'th-marker-sentence',
    });
    await markerSentenceSpec.run.execute('marker sentence', 'thread-th-marker-sentence', {
      assignedCatId: 'gpt52',
      deliver: mock.fn(async () => 'msg-marker-sentence'),
      invokeTrigger: triggerMock,
    });
    assert.equal(triggerMock.trigger.mock.calls[0].arguments[6].responsePresentation, undefined);

    triggerMock.trigger.mock.resetCalls();
    const mentionedMarkerSentenceSpec = reminderTemplate.createSpec('rem-mentioned-marker-sentence', {
      trigger: { type: 'cron', expression: '0 12 * * *' },
      params: { message: '@研究生 请复盘 window-primer: 配置，不要隐藏这条提醒' },
      deliveryThreadId: 'th-mentioned-marker-sentence',
    });
    await mentionedMarkerSentenceSpec.run.execute('mentioned marker sentence', 'thread-th-mentioned-marker-sentence', {
      assignedCatId: 'claude-sonnet5',
      deliver: mock.fn(async () => 'msg-mentioned-marker-sentence'),
      invokeTrigger: triggerMock,
    });
    assert.equal(triggerMock.trigger.mock.calls[0].arguments[6].responsePresentation, undefined);
  });

  it('deliver payload stays cat-agnostic when assignedCatId is null', async () => {
    const deliverMock = mock.fn(async () => 'msg-2');
    const spec = reminderTemplate.createSpec('rem-4', {
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { message: 'test' },
      deliveryThreadId: 'th-xyz',
    });
    await spec.run.execute('test', 'thread-th-xyz', {
      assignedCatId: null,
      deliver: deliverMock,
    });
    assert.equal(deliverMock.mock.calls[0].arguments[0].catId, undefined);
  });

  it('keeps trigger visible when invokeTrigger is unavailable', async () => {
    const deliverMock = mock.fn(async () => 'msg-visible');
    const spec = reminderTemplate.createSpec('rem-visible', {
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { message: '看得见的提醒' },
      deliveryThreadId: 'th-visible',
    });
    await spec.run.execute('看得见的提醒', 'thread-th-visible', {
      assignedCatId: 'opus',
      deliver: deliverMock,
    });
    assert.equal(deliverMock.mock.calls[0].arguments[0].extra, undefined);
  });

  it('execute throws when deliver is not available', async () => {
    const spec = reminderTemplate.createSpec('rem-5', {
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { message: 'test' },
      deliveryThreadId: 'th-xyz',
    });
    await assert.rejects(
      () => spec.run.execute('test', 'thread-th-xyz', { assignedCatId: null }),
      /deliver not available/,
    );
  });

  it('execute uses targetCatId param over assignedCatId fallback', async () => {
    const deliverMock = mock.fn(async () => 'msg-target');
    const triggerMock = { trigger: mock.fn() };
    const spec = reminderTemplate.createSpec('rem-target', {
      trigger: { type: 'interval', ms: 180_000 },
      params: { message: '巡查新闻', targetCatId: 'gpt52' },
      deliveryThreadId: 'th-target',
    });
    await spec.run.execute('巡查新闻', 'thread-th-target', {
      assignedCatId: null,
      deliver: deliverMock,
      invokeTrigger: triggerMock,
    });
    // invokeTrigger should be called with gpt52, not opus
    assert.equal(triggerMock.trigger.mock.calls.length, 1);
    assert.equal(triggerMock.trigger.mock.calls[0].arguments[1], 'gpt52');
  });

  it('execute falls back to assignedCatId when no targetCatId', async () => {
    const deliverMock = mock.fn(async () => 'msg-assigned');
    const triggerMock = { trigger: mock.fn() };
    const spec = reminderTemplate.createSpec('rem-assigned', {
      trigger: { type: 'interval', ms: 180_000 },
      params: { message: '巡查新闻' },
      deliveryThreadId: 'th-assigned',
    });
    await spec.run.execute('巡查新闻', 'thread-th-assigned', {
      assignedCatId: 'sonnet',
      deliver: deliverMock,
      invokeTrigger: triggerMock,
    });
    assert.equal(triggerMock.trigger.mock.calls[0].arguments[1], 'sonnet');
  });

  it('uses default message when param is empty', async () => {
    const deliverMock = mock.fn(async () => 'msg-3');
    const spec = reminderTemplate.createSpec('rem-6', {
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: {},
      deliveryThreadId: 'th-abc',
    });
    const result = await spec.admission.gate({ taskId: 'rem-6', lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, true);
    assert.equal(result.workItems[0].signal, '定时提醒');
    await spec.run.execute('定时提醒', 'thread-th-abc', {
      assignedCatId: 'opus',
      deliver: deliverMock,
    });
    assert.equal(deliverMock.mock.calls[0].arguments[0].content, `${SCHEDULER_TRIGGER_PREFIX} 定时提醒`);
  });
});
