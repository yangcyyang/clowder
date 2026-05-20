import { describe, expect, it } from 'vitest';
import { normalizeInlineThreadMessage } from '@/components/InlineThreadPanel';
import type { ChatMessage } from '@/stores/chatStore';

describe('InlineThreadPanel streaming normalization', () => {
  it('maps API draft replies to streaming messages so ChatMessage hides partial content', () => {
    const draftMessage = {
      id: 'draft-inv-1',
      type: 'assistant',
      catId: 'codex',
      content: 'partial reply',
      timestamp: 123,
      origin: 'stream',
      isDraft: true,
    } as ChatMessage & { isDraft: true };

    const normalized = normalizeInlineThreadMessage(draftMessage);

    expect(normalized.isStreaming).toBe(true);
    expect('isDraft' in normalized).toBe(false);
  });

  it('keeps completed replies unchanged', () => {
    const finalMessage = {
      id: 'm-final',
      type: 'assistant',
      catId: 'codex',
      content: 'complete reply',
      timestamp: 456,
      origin: 'stream',
      isStreaming: false,
    } as ChatMessage;

    expect(normalizeInlineThreadMessage(finalMessage)).toBe(finalMessage);
  });
});
