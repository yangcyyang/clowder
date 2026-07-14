import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import {
  getAgentVisibleContent,
  isUnreadCountableChatMessage,
  isUserVisibleChatMessage,
  sanitizeAgentVisibleContent,
} from '../chat-message-visibility';

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

  it('hides scheduler silent receipts from both timeline and unread counts', () => {
    const receipt: ChatMessage = {
      id: 'primer-new',
      threadId: 'default',
      type: 'assistant',
      catId: 'gpt52',
      content: 'Codex 窗口已激活，当前时间 2026-07-14 22:30。',
      origin: 'stream',
      extra: { scheduler: { hiddenReceipt: true } },
      timestamp: Date.now(),
    } as ChatMessage;

    expect(isUserVisibleChatMessage(receipt)).toBe(false);
    expect(isUnreadCountableChatMessage(receipt)).toBe(false);
  });

  it('hides only the five known legacy primer receipts, not similar manual replies', () => {
    const legacy: ChatMessage = {
      id: '0001783996224835-000088-8338059d',
      threadId: 'default',
      type: 'assistant',
      catId: 'gpt52',
      content: 'Codex 窗口已激活，当前时间 2026-07-14 10:30。',
      origin: 'stream',
      timestamp: 1783996224835,
    } as ChatMessage;
    const manual = { ...legacy, id: 'manual-window-activation', timestamp: Date.now() };

    expect(isUserVisibleChatMessage(legacy)).toBe(false);
    expect(isUserVisibleChatMessage(manual)).toBe(true);
  });

  it('migrates only the two exact legacy quota-noise messages', () => {
    const rawQuota: ChatMessage = {
      id: '0001784032228274-000001-03c48775',
      threadId: 'default',
      type: 'system',
      content: 'Error: Codex CLI raw quota URL and provider diagnostics',
      timestamp: 1784032228274,
    } as ChatMessage;
    const duplicate: ChatMessage = {
      id: '0001784032228288-000002-ac973f99',
      threadId: 'default',
      type: 'system',
      content: '[执行提醒]: gpt52 本轮没有返回可展示文本',
      timestamp: 1784032228288,
    } as ChatMessage;
    const similarNewError = { ...rawQuota, id: 'new-quota-error', timestamp: Date.now() };

    expect(isUserVisibleChatMessage(rawQuota)).toBe(true);
    expect(getAgentVisibleContent(rawQuota)).toBe('Error: Codex 额度超限，7/20 23:26 恢复');
    expect(isUserVisibleChatMessage(duplicate)).toBe(false);
    expect(isUnreadCountableChatMessage(duplicate)).toBe(false);
    expect(getAgentVisibleContent(similarNewError)).toContain('raw quota URL');
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

  it('hides system messages that only contain internal runtime notices', () => {
    const internalSystemMessage: ChatMessage = {
      id: 'internal-system-1',
      threadId: 'thread-1',
      type: 'system',
      variant: 'info',
      content: '{"type":"handoff_draft_window","catId":"gpt52","sessionId":"session_1","threadId":"default"}',
      timestamp: Date.now(),
    } as Partial<ChatMessage> as ChatMessage;

    expect(isUserVisibleChatMessage(internalSystemMessage)).toBe(false);
    expect(isUnreadCountableChatMessage(internalSystemMessage)).toBe(false);
  });
});
