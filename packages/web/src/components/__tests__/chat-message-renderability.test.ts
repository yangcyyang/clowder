import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chatStore';
import { shouldRenderChatMessage } from '../ChatMessage';

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'msg-1',
    type: 'assistant',
    content: '',
    timestamp: Date.now(),
    ...overrides,
  } as ChatMessage;
}

describe('shouldRenderChatMessage', () => {
  it('hides completed assistant placeholders with no visible content', () => {
    expect(shouldRenderChatMessage(message({ isStreaming: false }))).toBe(false);
  });

  it('hides skills budget warning-only assistant messages', () => {
    expect(
      shouldRenderChatMessage(
        message({
          content:
            '⚠️ Exceeded skills context budget of 2%. All skill descriptions were removed and 257 additional skills were not included in the model-visible skills list.',
        }),
      ),
    ).toBe(false);
  });

  it('hides startup recovery connector notices from the main chat flow', () => {
    expect(
      shouldRenderChatMessage(
        message({
          type: 'connector',
          content: '运行服务已恢复，已自动接续 opus 的 1 个进行中请求；已发送的消息会保留。',
          source: {
            connector: 'startup-reconciler',
            label: '重启通知',
            icon: '⚠️',
            meta: { presentation: 'system_notice' },
          },
        }),
      ),
    ).toBe(false);
  });

  it('hides task-system notices from the main chat flow', () => {
    expect(
      shouldRenderChatMessage(
        message({
          type: 'connector',
          content: 'task #2 状态：待办 → 进行中。',
          source: {
            connector: 'task-system',
            label: 'Task',
            icon: '📋',
            meta: { presentation: 'system_notice', eventType: 'task_status_changed' },
          },
        }),
      ),
    ).toBe(false);
  });

  it('keeps user-facing system_notice connector hints visible', () => {
    expect(
      shouldRenderChatMessage(
        message({
          type: 'connector',
          content: '把 @gpt52 单独放到新起一行开头，才能交接。',
          source: {
            connector: 'inline-mention-hint',
            label: '路由提示',
            icon: '💡',
            meta: { presentation: 'system_notice' },
          },
        }),
      ),
    ).toBe(true);
  });

  it('keeps user messages and assistant messages with visible content', () => {
    expect(shouldRenderChatMessage(message({ type: 'user', catId: undefined, content: '' }))).toBe(true);
    expect(shouldRenderChatMessage(message({ content: '交付完成' }))).toBe(true);
  });

  it('keeps thinking visible while hiding pure tool-only telemetry surfaces', () => {
    expect(shouldRenderChatMessage(message({ thinking: 'reasoning' }))).toBe(true);
    expect(shouldRenderChatMessage(message({ toolEvents: [{ label: 'build' }] as ChatMessage['toolEvents'] }))).toBe(
      false,
    );
    expect(
      shouldRenderChatMessage(
        message({ content: 'Codex 本轮已完成，但没有输出最终总结。最后进度：command_execution completed exit_code=0' }),
      ),
    ).toBe(false);
  });

  it('keeps meaningful assistant non-text user-visible surfaces', () => {
    expect(
      shouldRenderChatMessage(
        message({ extra: { rich: { v: 1, blocks: [{ title: 'done' }] as NonNullable<NonNullable<ChatMessage['extra']>['rich']>['blocks'] } } }),
      ),
    ).toBe(true);
  });
});
