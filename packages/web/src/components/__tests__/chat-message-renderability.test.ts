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

  it('keeps user messages and assistant messages with visible content', () => {
    expect(shouldRenderChatMessage(message({ type: 'user', catId: undefined, content: '' }))).toBe(true);
    expect(shouldRenderChatMessage(message({ content: '交付完成' }))).toBe(true);
  });

  it('keeps meaningful assistant non-text surfaces', () => {
    expect(shouldRenderChatMessage(message({ thinking: 'reasoning' }))).toBe(true);
    expect(shouldRenderChatMessage(message({ toolEvents: [{ label: 'build' }] as ChatMessage['toolEvents'] }))).toBe(
      true,
    );
    expect(
      shouldRenderChatMessage(
        message({ extra: { rich: { v: 1, blocks: [{ title: 'done' }] as NonNullable<NonNullable<ChatMessage['extra']>['rich']>['blocks'] } } }),
      ),
    ).toBe(true);
  });
});
