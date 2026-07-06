import { describe, expect, it } from 'vitest';
import { classifyRuntimeSystemEvent, classifyRuntimeWarning } from '../runtime-notices';

describe('runtime notices', () => {
  it('classifies skills budget warnings as runtime warnings', () => {
    const warning = classifyRuntimeWarning(
      'Exceeded skills context budget of 2%. 263 skills were not included in the model-visible skills list.',
    );

    expect(warning?.title).toBe('Skill 目录已裁剪');
    expect(warning?.severity).toBe('warning');
  });

  it('classifies startup-reconciler notices as system events', () => {
    const event = classifyRuntimeSystemEvent({
      id: 'notice-1',
      content: '运行服务已恢复，已自动接续 opus 的 1 个进行中请求；已发送的消息会保留。',
      source: {
        connector: 'startup-reconciler',
        label: '重启通知',
        icon: '⚠️',
        meta: { presentation: 'system_notice' },
      },
      threadId: 'thread_1',
      timestamp: 123,
    });

    expect(event?.kind).toBe('startup_recovery');
    expect(event?.threadId).toBe('thread_1');
  });

  it('classifies task-system notices as system events without matching content text', () => {
    const event = classifyRuntimeSystemEvent({
      id: 'task-notice-1',
      content: 'task #2 状态：待办 → 进行中。',
      source: {
        connector: 'task-system',
        label: 'Task',
        icon: '📋',
        meta: { presentation: 'system_notice', eventType: 'task_status_changed' },
      },
      threadId: 'thread_1',
      timestamp: 456,
    });

    expect(event?.kind).toBe('task_system_notice');
    expect(event?.title).toBe('任务系统事件');
  });

  it('does not classify unrelated system_notice connectors as runtime events', () => {
    const event = classifyRuntimeSystemEvent({
      id: 'routing-hint-1',
      content: '把 @gpt52 单独放到新起一行开头，才能交接。',
      source: {
        connector: 'inline-mention-hint',
        label: '路由提示',
        icon: '💡',
        meta: { presentation: 'system_notice' },
      },
    });

    expect(event).toBeNull();
  });
});
