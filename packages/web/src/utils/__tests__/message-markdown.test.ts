import { describe, expect, it } from 'vitest';
import {
  buildMessageMarkdownQuote,
  buildMessagesMarkdownQuote,
  formatQuoteTimestamp,
  resolveMessageAuthorLabel,
} from '../message-markdown';

describe('message-markdown', () => {
  it('formats the timestamp the same way ChatMessage.tsx displays it (MM/DD HH:mm, zh-CN)', () => {
    const timestamp = new Date('2026-07-25T14:50:00').getTime();
    expect(formatQuoteTimestamp(timestamp)).toBe('07/25 14:50');
  });

  describe('resolveMessageAuthorLabel', () => {
    it('resolves a cat displayName via getCatById when catId is present', () => {
      const label = resolveMessageAuthorLabel(
        { catId: 'codex' },
        (id) => (id === 'codex' ? { displayName: 'Codex' } : undefined),
      );
      expect(label).toBe('Codex');
    });

    it('falls back to the raw catId when getCatById cannot resolve it', () => {
      expect(resolveMessageAuthorLabel({ catId: 'unknown-cat' }, () => undefined)).toBe('unknown-cat');
    });

    it('falls back to the raw catId when no getCatById is provided', () => {
      expect(resolveMessageAuthorLabel({ catId: 'codex' })).toBe('codex');
    });

    it("falls back to '你' for messages with no catId (the current user)", () => {
      expect(resolveMessageAuthorLabel({})).toBe('你');
    });
  });

  describe('buildMessageMarkdownQuote', () => {
    it('renders an author + timestamp header line followed by a blockquote body', () => {
      const timestamp = new Date('2026-07-25T14:50:00').getTime();
      const quote = buildMessageMarkdownQuote({ author: 'Codex', timestamp, content: 'line one\nline two' });
      expect(quote).toBe('> **Codex** · 07/25 14:50\n> line one\n> line two');
    });

    it('quote-prefixes every line of multi-line content', () => {
      const quote = buildMessageMarkdownQuote({ author: '你', timestamp: 0, content: 'a\nb\nc' });
      const lines = quote.split('\n');
      expect(lines[1]).toBe('> a');
      expect(lines[2]).toBe('> b');
      expect(lines[3]).toBe('> c');
    });
  });

  describe('buildMessagesMarkdownQuote', () => {
    it('joins multiple quote blocks with a blank line between them', () => {
      const result = buildMessagesMarkdownQuote([
        { author: 'A', timestamp: 0, content: 'first' },
        { author: 'B', timestamp: 0, content: 'second' },
      ]);
      expect(result).toContain('> **A**');
      expect(result).toContain('> **B**');
      expect(result.split('\n\n')).toHaveLength(2);
    });

    it('returns an empty string for an empty input list', () => {
      expect(buildMessagesMarkdownQuote([])).toBe('');
    });
  });
});
