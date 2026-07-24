import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import { isDelivered, type StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { canViewMessage, isUserVisibleUnreadMessage, type Viewer } from '../domains/cats/services/stores/visibility.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';

export interface ThreadReplyPreview {
  id: string;
  catId: string | null;
  content: string;
  timestamp: number;
  /**
   * whisper-hygiene consistency fix (twin of the InlineThreadReplyPreview live-socket fix):
   * `isFoldVisibleReply` below already gates message selection through `canViewMessage`, so
   * this backend function itself never leaks an invisible whisper to whatever `viewer` it's
   * called with. But the *output* previously dropped these fields entirely, so a downstream
   * frontend mirror filter (canViewerSeeThreadMessage) had nothing to check — carrying them
   * through closes that consistency gap without changing today's behavior (the current call
   * site passes {type:'user'}, which is the correct, already-authorized web-display viewer).
   */
  visibility?: 'public' | 'whisper';
  whisperTo?: readonly string[];
  revealedAt?: number | null;
}

export interface ThreadReplySummary {
  replyCount: number;
  latestReply?: ThreadReplyPreview;
}

function isSourceCopy(source: StoredMessage, candidate: StoredMessage): boolean {
  return (
    candidate.timestamp === source.timestamp && candidate.content === source.content && candidate.catId === source.catId
  );
}

function isFoldVisibleReply(message: StoredMessage, viewer: Viewer): boolean {
  if (!isDelivered(message) || message.deletedAt || message._tombstone) return false;
  if (!canViewMessage(message, viewer)) return false;
  if (message.userId === 'system' || message.catId === 'system') return false;
  if (message.source?.connector === 'task-system') return false;
  return isUserVisibleUnreadMessage(message);
}

function compactPreview(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function findSourceCopyIndex(sourceMessage: StoredMessage, branchMessages: readonly StoredMessage[]): number {
  for (let index = branchMessages.length - 1; index >= 0; index--) {
    const candidate = branchMessages[index];
    if (candidate && isSourceCopy(sourceMessage, candidate)) return index;
  }
  return -1;
}

export function deriveThreadReplySummary(
  sourceMessage: StoredMessage,
  branchMessages: readonly StoredMessage[],
  viewer: Viewer,
): ThreadReplySummary {
  // Branch 复制的是“截至 source 的全部上下文”；内容/时间完全相同的旧消息可能重复，
  // 因而必须以最后一个匹配项作为 source copy 边界。
  const sourceIndex = findSourceCopyIndex(sourceMessage, branchMessages);
  const candidates =
    sourceIndex >= 0
      ? branchMessages.slice(sourceIndex + 1)
      : branchMessages.filter((message) => message.timestamp > sourceMessage.timestamp);
  const visibleReplies = candidates.filter((message) => isFoldVisibleReply(message, viewer));
  const latest = visibleReplies.at(-1);

  if (!latest) return { replyCount: 0 };

  return {
    replyCount: visibleReplies.length,
    latestReply: {
      id: latest.id,
      catId: latest.catId,
      content: compactPreview(latest.content) || (latest.contentBlocks?.length ? '附件消息' : '回复'),
      timestamp: latest.timestamp,
      ...(latest.visibility ? { visibility: latest.visibility } : {}),
      ...(latest.whisperTo ? { whisperTo: latest.whisperTo } : {}),
      ...(latest.revealedAt !== undefined ? { revealedAt: latest.revealedAt } : {}),
    },
  };
}

/**
 * Socket event contract for {@link notifyBranchThreadReply}.
 * Event name: 'thread_reply_count_updated'. Room: `thread:{parentThreadId}` —
 * i.e. the MAIN thread the branch hangs off of, not the branch room itself, so
 * viewers who never joined the branch still see the count move (F194 §2 root
 * cause 2: "用户没 join 分支 thread room 收不到分支动静").
 */
export interface ThreadReplyCountUpdatedEvent {
  sourceMessageId: string;
  branchThreadId: string;
  replyCount: number;
}

export interface BranchReplyNotifyDeps {
  threadStore: Pick<IThreadStore, 'get'>;
  messageStore: Pick<IMessageStore, 'getById' | 'updateExtra' | 'countByThread'>;
  socketManager: Pick<SocketManager, 'broadcastToRoom'>;
}

/**
 * F194 可见性修复 (§2 root cause 2 / docs/research/clowder-raft-thread-task-design.md):
 * whenever a message lands in a durable branch thread (relation-bearing —
 * inline_reply / edit_branch / task_thread), refresh the anchor message's
 * persisted `extra.slockThread.replyCount` and ping the thread the branch hangs
 * off of so users who never opened/joined the branch panel still see the reply
 * count move in real time.
 *
 * Deliberately cheap: one ZCARD-equivalent count (IMessageStore#countByThread),
 * no per-message hydration/filtering pass. The accurate, viewer-scoped count is
 * still computed on read via deriveThreadReplySummary() above — this is only
 * the live "something changed" nudge, not the source of truth.
 *
 * Race-safe by construction: this only refreshes a message that ALREADY carries
 * `extra.slockThread.branchThreadId === branchThreadId`. During initial thread
 * setup (history copy in thread-branch.ts, or the single source-copy append in
 * ensureTaskDiscussionThread) that link has not been claimed yet, so this never
 * contends with claimBranchThreadLink's / ensureTaskDiscussionThread's own CAS.
 *
 * Known limitation: the "-1" assumes exactly one source-copy message preceded
 * the first real reply. That is always true for task_thread (single source
 * copy) but undercounts for legacy inline_reply/edit_branch threads created
 * with a full history copy (see design doc §2 root cause 6 / §3 step 2.5,
 * tracked separately) — those are corrected on next history fetch via
 * deriveThreadReplySummary regardless.
 */
export async function notifyBranchThreadReply(
  deps: BranchReplyNotifyDeps,
  input: { branchThreadId: string },
): Promise<{ notified: boolean; replyCount?: number }> {
  const branchThread = await deps.threadStore.get(input.branchThreadId);
  const relation = branchThread?.relation;
  if (!relation) return { notified: false };

  const source = await deps.messageStore.getById(relation.rootMessageId);
  if (!source?.extra?.slockThread || source.extra.slockThread.branchThreadId !== input.branchThreadId) {
    return { notified: false };
  }

  const total = await deps.messageStore.countByThread(input.branchThreadId);
  const replyCount = Math.max(0, total - 1);

  if (replyCount !== source.extra.slockThread.replyCount) {
    await deps.messageStore.updateExtra(relation.rootMessageId, {
      ...source.extra,
      slockThread: { branchThreadId: input.branchThreadId, replyCount },
    });
  }

  const event: ThreadReplyCountUpdatedEvent = {
    sourceMessageId: relation.rootMessageId,
    branchThreadId: input.branchThreadId,
    replyCount,
  };
  deps.socketManager.broadcastToRoom(`thread:${relation.parentThreadId}`, 'thread_reply_count_updated', event);

  return { notified: true, replyCount };
}
