import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { isUnreadCountableChatMessage, isUserVisibleChatMessage, sanitizeAgentVisibleContent } from '../chat-message-visibility';

describe('chat-message-visibility', () => {
  it('hides context briefing messages from the main chat surface and unread counts', () => {
    const briefingMessage: ChatMessage = {
      id: 'briefing-1',
      threadId: 'thread-1',
      type: 'connector',
      content: 'CONTEXT BRIEFING',
      timestamp: Date.now(),
      origin: 'briefing',
      extra: {
        rich: {
          v: 1,
          blocks: [{ id: 'briefing-card-1', kind: 'card', v: 1, title: 'CONTEXT BRIEFING' }],
        },
      },
    } as Partial<ChatMessage> as ChatMessage;

    expect(isUserVisibleChatMessage(briefingMessage)).toBe(false);
    expect(isUnreadCountableChatMessage(briefingMessage)).toBe(false);
  });

  it('keeps progress heartbeat status visible but unread-neutral', () => {
    const heartbeatMessage: ChatMessage = {
      id: 'heartbeat-1',
      threadId: 'task-thread-1',
      type: 'connector',
      content: '老者-codex 正在推进：检查任务状态（1/3 已完成）',
      timestamp: Date.now(),
      extra: { systemKind: 'progress_heartbeat' },
    } as Partial<ChatMessage> as ChatMessage;

    expect(isUserVisibleChatMessage(heartbeatMessage)).toBe(true);
    expect(isUnreadCountableChatMessage(heartbeatMessage)).toBe(false);
  });

  it('strips internal shared-state and handoff runtime notices from visible assistant content', () => {
    const content = [
      '⚠️ Shared-state preflight: uncommitted shared-state files: cat-template.json, docs/ROADMAP.md. Please commit+push before continuing (shared-rules §14).',
      '{"type":"handoff_draft_window","catId":"gpt52","sessionId":"session_1","threadId":"default","healthSnapshot":{"usedTokens":277596,"windowTokens":353400,"fillRatio":0.7855,"source":"exact","measuredAt":1783658472680},"trust":"trusted"}',
      '结论：这行应该显示。',
    ].join('\n');

    expect(sanitizeAgentVisibleContent(content)).toBe('结论：这行应该显示。');
  });

  it('hides assistant messages that only contain internal runtime notices', () => {
    const internalOnlyMessage: ChatMessage = {
      id: 'internal-1',
      threadId: 'thread-1',
      type: 'assistant',
      content: [
        '⚠️ Shared-state preflight: uncommitted shared-state files: cat-template.json. Please commit+push before continuing (shared-rules §14).',
        '{"type":"handoff_draft_window","catId":"gpt52","sessionId":"session_1","threadId":"default"}',
      ].join('\n'),
      timestamp: Date.now(),
    } as Partial<ChatMessage> as ChatMessage;

    expect(isUserVisibleChatMessage(internalOnlyMessage)).toBe(false);
    expect(isUnreadCountableChatMessage(internalOnlyMessage)).toBe(false);
  });
});
