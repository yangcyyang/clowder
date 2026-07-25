'use client';

/**
 * Client for the batch 3-D Activity aggregated inbox API
 * (GET/POST /api/activity/*, see packages/api/src/routes/activity.ts).
 *
 * Every function here is best-effort: on any failure (network error, 401,
 * 501 when Redis/follow-store isn't configured) it resolves to `null`
 * instead of throwing, so ActivityBar can gracefully fall back to the
 * pre-existing client-derived activity-inbox.ts heuristic rather than
 * breaking the panel.
 */

import { apiFetch } from './api-client';

export type ActivityFeedFilter = 'all' | 'unread' | 'mentions';
export type ActivityFeedItemKind = 'reply' | 'mention' | 'task_status';

export interface ActivityFeedItem {
  id: string;
  kind: ActivityFeedItemKind;
  /** Thread the underlying message physically lives in (may be a task-discussion branch). */
  threadId: string;
  /** The followed thread this item is attributed to — same as threadId unless isBranch. */
  sourceThreadId: string;
  threadTitle: string;
  isBranch: boolean;
  messageId: string;
  content: string;
  catId: string | null;
  timestamp: number;
  read: boolean;
}

export interface ActivityFeedResponse {
  items: ActivityFeedItem[];
  nextCursor: string | null;
  hasMore: boolean;
  unreadCount: number;
}

function isActivityFeedItem(value: unknown): value is ActivityFeedItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<ActivityFeedItem>;
  return (
    typeof item.id === 'string' &&
    typeof item.kind === 'string' &&
    typeof item.threadId === 'string' &&
    typeof item.sourceThreadId === 'string' &&
    typeof item.messageId === 'string' &&
    typeof item.timestamp === 'number'
  );
}

/** Returns null on any failure — callers should fall back to the local heuristic. */
export async function fetchActivityFeed(
  filter: ActivityFeedFilter,
  options: { cursor?: string; limit?: number } = {},
): Promise<ActivityFeedResponse | null> {
  try {
    const params = new URLSearchParams({ filter });
    if (options.cursor) params.set('cursor', options.cursor);
    if (options.limit) params.set('limit', String(options.limit));
    const res = await apiFetch(`/api/activity?${params.toString()}`);
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<ActivityFeedResponse>;
    const items = Array.isArray(data.items) ? data.items.filter(isActivityFeedItem) : [];
    return {
      items,
      nextCursor: typeof data.nextCursor === 'string' ? data.nextCursor : null,
      hasMore: data.hasMore === true,
      unreadCount: typeof data.unreadCount === 'number' ? data.unreadCount : 0,
    };
  } catch {
    return null;
  }
}

/** Best-effort — the panel already updates optimistically on click. */
export async function ackActivityItem(threadId: string, messageId: string): Promise<void> {
  try {
    await apiFetch('/api/activity/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId, messageId }),
    });
  } catch {
    // best-effort
  }
}

/** Best-effort. */
export async function ackAllActivity(): Promise<void> {
  try {
    await apiFetch('/api/activity/read-all', { method: 'POST' });
  } catch {
    // best-effort
  }
}
