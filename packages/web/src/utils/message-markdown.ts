'use client';

/**
 * Shared "Copy Markdown" quote-block formatting for the Raft-parity message context menu
 * (MessageContextMenu.tsx) — used both for a single message's "Copy Markdown" action and for
 * MessageSelectionBar's bulk copy of a multi-select. Kept as pure, dependency-free functions so
 * both call sites (and their tests) stay simple.
 */

export interface MessageMarkdownQuoteInput {
  /** Resolved display name — see resolveMessageAuthorLabel. */
  author: string;
  timestamp: number;
  content: string;
}

/**
 * Same format as ChatMessage.tsx's internal formatTime() (zh-CN, no year, MM/DD HH:mm) — reused
 * here so the quoted header matches what the reader already sees rendered under the message.
 */
export function formatQuoteTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Mirrors InlineThreadParentMessageCard's authorLabel derivation (cat displayName → raw catId →
 * '你' for the current user) so the quoted author line reads the same way the parent-message
 * card already does.
 */
export function resolveMessageAuthorLabel(
  message: { catId?: string },
  getCatById?: (catId: string) => { displayName: string } | undefined,
): string {
  if (message.catId) {
    return getCatById?.(message.catId)?.displayName ?? message.catId;
  }
  return '你';
}

/** Renders one message as a markdown blockquote with an author + timestamp header line. */
export function buildMessageMarkdownQuote({ author, timestamp, content }: MessageMarkdownQuoteInput): string {
  const header = `> **${author}** · ${formatQuoteTimestamp(timestamp)}`;
  const bodyLines = content.split('\n').map((line) => `> ${line}`.trimEnd());
  return [header, ...bodyLines].join('\n');
}

/** Multiple messages, each its own quote block, separated by a blank line (Select Message bulk copy). */
export function buildMessagesMarkdownQuote(inputs: MessageMarkdownQuoteInput[]): string {
  return inputs.map(buildMessageMarkdownQuote).join('\n\n');
}
