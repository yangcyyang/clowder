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
});
