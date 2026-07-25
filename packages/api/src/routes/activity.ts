/**
 * Activity aggregated inbox (batch 3-D).
 *
 * docs/research/clowder-raft-thread-task-design.md §1 + §3 step 2 + §5B.3:
 * "参与/被 @ 自动 follow 该 thread → 新回复进 Activity + 未读徽标；任务状态变化
 * 同样入 Activity。" / "DM 必 ping、follow 的 thread 回复 ping、被 @ ping，
 * 其余进 Activity——能等一小时的就不该 ping。"
 *
 * GET  /api/activity                 → aggregated feed (filter=all|unread|mentions, cursor pagination)
 * POST /api/activity/follow          → manual follow ({ threadId })
 * POST /api/activity/unfollow        → unfollow ({ threadId })
 * POST /api/activity/read            → ack one item read ({ threadId, messageId })
 * POST /api/activity/read-all        → ack every followed thread (+ its task branches) to latest
 *
 * Read watermark: reuses IThreadReadStateStore (F069) rather than a new key —
 * an Activity item's underlying message is a real StoredMessage in some
 * threadId (the followed thread itself, or one of its task-discussion
 * branches), so the existing per-user/per-thread cursor already answers
 * "has the user seen this" for free, and stays in sync with the sidebar's
 * unread badge (reading a thread there also clears its Activity items).
 * When no cursor exists yet for a thread (never opened), a synthetic
 * watermark id is derived from the follow's `followedAt` timestamp — using
 * generateSortableId's own `{16-digit ts}-{seq}-{uuid8}` layout — so newly
 * followed old threads don't dump their entire history as "unread".
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { IFollowStore } from '../domains/cats/services/stores/ports/FollowStore.js';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadReadStateStore } from '../domains/cats/services/stores/ports/ThreadReadStateStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { isUserVisibleUnreadMessage } from '../domains/cats/services/stores/visibility.js';
import { resolveUserId } from '../utils/request-identity.js';

export interface ActivityRoutesOptions {
  followStore?: IFollowStore;
  threadStore: IThreadStore;
  messageStore: IMessageStore;
  taskStore: ITaskStore;
  readStateStore?: IThreadReadStateStore;
}

export type ActivityItemKind = 'reply' | 'mention' | 'task_status';

export interface ActivityFeedItem {
  id: string;
  kind: ActivityItemKind;
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

const PER_THREAD_FETCH_LIMIT = 100;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

const feedQuerySchema = z.object({
  filter: z.enum(['all', 'unread', 'mentions']).default('all'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

const followBodySchema = z.object({
  threadId: z.string().min(1).max(200),
});

const readBodySchema = z.object({
  threadId: z.string().min(1).max(200),
  messageId: z.string().min(1).max(100),
});

/** Same {16-digit ts}-{seq}-{uuid8} layout as generateSortableId (MessageStore.ts) — see module doc. */
export function syntheticWatermarkId(timestamp: number): string {
  return `${String(Math.max(0, Math.floor(timestamp))).padStart(16, '0')}-000000-00000000`;
}

function excerpt(content: string): string {
  const singleLine = content.replace(/\s+/g, ' ').trim();
  if (!singleLine) return '（无正文）';
  return singleLine.length <= 160 ? singleLine : `${singleLine.slice(0, 160)}...`;
}

export interface CandidateThread {
  threadId: string;
  sourceThreadId: string;
  isBranch: boolean;
}

/** Followed threads, plus any task-discussion branch hanging off a followed thread (design doc: "含任务讨论分支"). */
export async function resolveCandidateThreads(
  deps: Pick<ActivityRoutesOptions, 'followStore' | 'taskStore'>,
  userId: string,
): Promise<CandidateThread[]> {
  if (!deps.followStore) return [];
  const followedIds = await deps.followStore.listFollowedThreadIds(userId);
  const candidates = new Map<string, CandidateThread>();
  for (const threadId of followedIds) {
    candidates.set(threadId, { threadId, sourceThreadId: threadId, isBranch: false });
  }
  for (const threadId of followedIds) {
    const tasks = await deps.taskStore.listByThread(threadId);
    for (const task of tasks) {
      if (task.taskThreadId && !candidates.has(task.taskThreadId)) {
        candidates.set(task.taskThreadId, { threadId: task.taskThreadId, sourceThreadId: threadId, isBranch: true });
      }
    }
  }
  return [...candidates.values()];
}

export function classifyMessage(msg: StoredMessage, viewerUserId: string): ActivityItemKind | null {
  if (msg.deletedAt || msg._tombstone) return null;
  // The human's own literally-typed message — nothing to notify them about.
  if (msg.catId === null && !msg.source && msg.userId === viewerUserId) return null;

  const eventType = (msg.source?.meta as { eventType?: string } | undefined)?.eventType;
  if (msg.source?.connector === 'task-system' && eventType === 'task_status_changed') return 'task_status';
  if (msg.mentionsUser) return 'mention';
  if (!isUserVisibleUnreadMessage(msg)) return null;
  return 'reply';
}

/** Builds the full (unpaginated) candidate item set — always "recent N per thread" so
 *  the same fetch backs all three filters and the unread badge count. */
export async function buildFeedItems(
  deps: ActivityRoutesOptions,
  userId: string,
): Promise<ActivityFeedItem[]> {
  const candidates = await resolveCandidateThreads(deps, userId);
  if (candidates.length === 0) return [];

  const threadTitleCache = new Map<string, string>();
  const resolveTitle = async (threadId: string): Promise<string> => {
    if (threadTitleCache.has(threadId)) return threadTitleCache.get(threadId)!;
    const thread = await deps.threadStore.get(threadId);
    const title = thread?.title ?? (threadId === 'default' ? '大厅' : '未命名对话');
    threadTitleCache.set(threadId, title);
    return title;
  };

  const items: ActivityFeedItem[] = [];

  for (const candidate of candidates) {
    const thread = await deps.threadStore.get(candidate.threadId);
    if (!thread || thread.deletedAt) continue; // defense-in-depth: soft-deleted thread not yet cascade-cleaned

    const readState = deps.readStateStore ? await deps.readStateStore.get(userId, candidate.threadId) : null;
    let watermark = readState?.lastReadMessageId;
    if (!watermark && deps.followStore) {
      // No cursor yet for this exact threadId (common for task-discussion branches,
      // which the sidebar never opens/acks directly) — fall back to "unread since
      // I started following the *source* thread" instead of "everything is unread".
      const followedAt = await deps.followStore.getFollowedAt(userId, candidate.sourceThreadId);
      watermark = followedAt != null ? syntheticWatermarkId(followedAt) : undefined;
    }

    const messages = await deps.messageStore.getByThread(candidate.threadId, PER_THREAD_FETCH_LIMIT, userId);
    const sourceTitle = await resolveTitle(candidate.sourceThreadId);

    for (const msg of messages) {
      const kind = classifyMessage(msg, userId);
      if (!kind) continue;
      const read = watermark ? msg.id <= watermark : false;
      items.push({
        id: `${kind}:${candidate.threadId}:${msg.id}`,
        kind,
        threadId: candidate.threadId,
        sourceThreadId: candidate.sourceThreadId,
        threadTitle: sourceTitle,
        isBranch: candidate.isBranch,
        messageId: msg.id,
        content: excerpt(msg.contentBlocks?.length ? msg.content || '附件消息' : msg.content),
        catId: msg.catId,
        timestamp: msg.timestamp,
        read,
      });
    }
  }

  items.sort((a, b) => b.timestamp - a.timestamp || (a.messageId < b.messageId ? 1 : -1));
  return items;
}

export function parseCursor(cursor: string | undefined): { timestamp: number; messageId: string } | null {
  if (!cursor) return null;
  const idx = cursor.indexOf(':');
  if (idx <= 0) return null;
  const timestamp = parseInt(cursor.slice(0, idx), 10);
  const messageId = cursor.slice(idx + 1);
  if (!Number.isFinite(timestamp) || !messageId) return null;
  return { timestamp, messageId };
}

export function isBeforeCursor(item: ActivityFeedItem, cursor: { timestamp: number; messageId: string }): boolean {
  if (item.timestamp !== cursor.timestamp) return item.timestamp < cursor.timestamp;
  return item.messageId < cursor.messageId;
}

export const activityRoutes: FastifyPluginAsync<ActivityRoutesOptions> = async (app, opts) => {
  // GET /api/activity — aggregated feed
  app.get('/api/activity', async (request, reply) => {
    const userId = resolveUserId(request, { defaultUserId: 'default-user' });
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }
    if (!opts.followStore) {
      reply.status(501);
      return { error: 'Follow store not available' };
    }

    const parseResult = feedQuerySchema.safeParse(request.query);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid query', details: parseResult.error.issues };
    }
    const { filter, cursor, limit } = parseResult.data;

    const allItems = await buildFeedItems(opts, userId);
    const unreadCount = allItems.reduce((total, item) => total + (item.read ? 0 : 1), 0);

    let filtered = allItems;
    if (filter === 'unread') filtered = allItems.filter((item) => !item.read);
    else if (filter === 'mentions') filtered = allItems.filter((item) => item.kind === 'mention');

    const cursorBoundary = parseCursor(cursor);
    const afterCursor = cursorBoundary ? filtered.filter((item) => isBeforeCursor(item, cursorBoundary)) : filtered;

    const hasMore = afterCursor.length > limit;
    const page = afterCursor.slice(0, limit);
    const last = page.at(-1);
    const nextCursor = hasMore && last ? `${last.timestamp}:${last.messageId}` : null;

    return { items: page, nextCursor, hasMore, unreadCount };
  });

  // POST /api/activity/follow — manual follow
  app.post('/api/activity/follow', async (request, reply) => {
    const userId = resolveUserId(request, { defaultUserId: 'default-user' });
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }
    if (!opts.followStore) {
      reply.status(501);
      return { error: 'Follow store not available' };
    }
    const parseResult = followBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parseResult.error.issues };
    }
    const thread = await opts.threadStore.get(parseResult.data.threadId);
    if (!thread || thread.deletedAt) {
      reply.status(404);
      return { error: 'Thread not found' };
    }
    const followed = await opts.followStore.follow(userId, parseResult.data.threadId, 'manual');
    return { followed };
  });

  // POST /api/activity/unfollow
  app.post('/api/activity/unfollow', async (request, reply) => {
    const userId = resolveUserId(request, { defaultUserId: 'default-user' });
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }
    if (!opts.followStore) {
      reply.status(501);
      return { error: 'Follow store not available' };
    }
    const parseResult = followBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parseResult.error.issues };
    }
    const unfollowed = await opts.followStore.unfollow(userId, parseResult.data.threadId);
    return { unfollowed };
  });

  // POST /api/activity/read — ack a single item's underlying message
  app.post('/api/activity/read', async (request, reply) => {
    const userId = resolveUserId(request, { defaultUserId: 'default-user' });
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }
    if (!opts.readStateStore) {
      reply.status(501);
      return { error: 'Read state store not available' };
    }
    const parseResult = readBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parseResult.error.issues };
    }
    const { threadId, messageId } = parseResult.data;
    const msg = await opts.messageStore.getById(messageId);
    if (!msg || msg.threadId !== threadId) {
      reply.status(400);
      return { error: 'messageId does not belong to threadId' };
    }
    const advanced = await opts.readStateStore.ack(userId, threadId, messageId);
    return { advanced };
  });

  // POST /api/activity/read-all — ack every followed thread (+ task branches) to latest
  app.post('/api/activity/read-all', async (request, reply) => {
    const userId = resolveUserId(request, { defaultUserId: 'default-user' });
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }
    if (!opts.followStore || !opts.readStateStore) {
      reply.status(501);
      return { error: 'Follow/read state store not available' };
    }

    const candidates = await resolveCandidateThreads(opts, userId);
    let advancedCount = 0;
    for (const candidate of candidates) {
      const messages = await opts.messageStore.getByThread(candidate.threadId, 1, userId);
      const latestId = messages[messages.length - 1]?.id;
      if (!latestId) continue;
      const advanced = await opts.readStateStore.ack(userId, candidate.threadId, latestId);
      if (advanced) advancedCount++;
    }
    return { advancedCount, totalThreads: candidates.length };
  });
};
