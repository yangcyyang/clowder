import type { TaskItem } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadStore, Thread, ThreadRelationV1 } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';

export function formatTaskThreadTitle(title: string): string {
  const trimmed = title.trim();
  const shortTitle = trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed;
  return `${shortTitle || '任务'} (分支)`;
}

export function formatTaskSourceContent(task: { title: string; why?: string }): string {
  return [`📌 Task: ${task.title}`, task.why?.trim() ? `\n${task.why.trim()}` : ''].join('\n');
}

/**
 * 理智线批相邻的 #404 whisper 钉：这份合成 sourceMessage 曾经不带 visibility/
 * whisperTo/revealedAt，导致下游（任务卡渲染）无法判断真实来源消息是不是
 * whisper——一条通过 whisper 发送、被 F194 自动收纳成任务的指令，其内容会
 * 通过任务卡"看起来是公开的"泄露给无权 viewer。补齐这三个字段，让
 * canViewerSeeThreadMessage() 之类的下游过滤器能正确判断。
 */
export function toTaskThreadMessage(message: StoredMessage) {
  return {
    id: message.id,
    threadId: message.threadId,
    userId: message.userId,
    catId: message.catId,
    content: message.content,
    mentions: message.mentions,
    timestamp: message.timestamp,
    ...(message.editedAt ? { editedAt: message.editedAt } : {}),
    ...(message.origin ? { origin: message.origin } : {}),
    ...(message.visibility ? { visibility: message.visibility } : {}),
    ...(message.whisperTo ? { whisperTo: message.whisperTo } : {}),
    ...(message.revealedAt ? { revealedAt: message.revealedAt } : {}),
  };
}

/**
 * F194 §3 step 2: does `message` already have a live anchored branch thread
 * (recorded via `extra.slockThread.branchThreadId`, the same field both
 * ensureMessageAnchoredThread and the task-thread path below write)?
 * Returns the branch thread + its first (anchor) message when so, else null.
 * A dangling pointer (thread deleted, or thread lost its first message) is
 * treated as "no anchor" so callers fall back to creating a fresh branch.
 */
async function findLiveAnchorBranch(
  message: Pick<StoredMessage, 'extra'>,
  deps: { threadStore: IThreadStore; messageStore: IMessageStore },
): Promise<{ thread: Thread; firstMessage: StoredMessage } | null> {
  const branchThreadId = message.extra?.slockThread?.branchThreadId;
  if (!branchThreadId) return null;
  const thread = await deps.threadStore.get(branchThreadId);
  if (!thread) return null;
  // NOTE: getByThread(id, limit) returns the *most recent* `limit` messages
  // (oldest-first among those) — not literally "the first N ever posted". A
  // generous limit is required so index [0] still lands on the true anchor
  // message for any realistically-sized branch (mirrors the existing 100
  // convention used by ensureTaskDiscussionThread's fast path above).
  const messages = await deps.messageStore.getByThread(branchThreadId, 100);
  const firstMessage = messages[0];
  if (!firstMessage) return null;
  return { thread, firstMessage };
}

/** Copies `source` into a freshly created thread as its first message — same field set as the historical inline copy. */
async function copyMessageIntoNewBranch(
  source: StoredMessage,
  branchThreadId: string,
  deps: { messageStore: IMessageStore },
): Promise<StoredMessage> {
  return deps.messageStore.append({
    userId: source.userId,
    catId: source.catId,
    content: source.content,
    mentions: [...source.mentions],
    timestamp: source.timestamp,
    threadId: branchThreadId,
    ...(source.contentBlocks ? { contentBlocks: source.contentBlocks } : {}),
    ...(source.metadata ? { metadata: source.metadata } : {}),
    ...(source.origin ? { origin: source.origin } : {}),
    ...(source.source ? { source: source.source } : {}),
    ...(source.visibility ? { visibility: source.visibility } : {}),
    ...(source.whisperTo ? { whisperTo: [...source.whisperTo] } : {}),
    ...(source.revealedAt !== undefined ? { revealedAt: source.revealedAt } : {}),
  });
}

/**
 * F194 §3 step 2 (thread-first): generic, task-agnostic version of the branch
 * creation done below for tasks. "有分支就复用、没有就建带 relation 的分支+复制源消息":
 * if `sourceMessage` already points at a live branch (via extra.slockThread),
 * reuse it; otherwise create one, copy the source message in, and record the
 * pointer back onto `sourceMessage` so later callers (including the task path)
 * discover and reuse the same branch instead of creating a second one.
 */
export async function ensureMessageAnchoredThread(
  sourceMessage: StoredMessage,
  deps: { threadStore: IThreadStore; messageStore: IMessageStore },
  options: { userId?: string; titleHint?: string } = {},
): Promise<{ threadId: string; anchorMessage: ReturnType<typeof toTaskThreadMessage>; created: boolean }> {
  const { threadStore, messageStore } = deps;

  const existing = await findLiveAnchorBranch(sourceMessage, { threadStore, messageStore });
  if (existing) {
    return { threadId: existing.thread.id, anchorMessage: toTaskThreadMessage(existing.firstMessage), created: false };
  }

  const parentThread = await threadStore.get(sourceMessage.threadId);
  const userId = options.userId ?? parentThread?.createdBy ?? sourceMessage.userId ?? 'default-user';
  const relation: ThreadRelationV1 = {
    v: 1,
    kind: 'message_thread',
    parentThreadId: sourceMessage.threadId,
    rootMessageId: sourceMessage.id,
  };
  const title = formatTaskThreadTitle(options.titleHint ?? sourceMessage.content);
  const branchThread = await threadStore.create(userId, title, parentThread?.projectPath, { relation });

  if (parentThread?.participants?.length) {
    await threadStore.addParticipants(branchThread.id, parentThread.participants);
  }

  const anchorMessage = await copyMessageIntoNewBranch(sourceMessage, branchThread.id, { messageStore });

  await messageStore.updateExtra(sourceMessage.id, {
    ...(sourceMessage.extra ?? {}),
    slockThread: { branchThreadId: branchThread.id, replyCount: 0 },
  });

  return { threadId: branchThread.id, anchorMessage: toTaskThreadMessage(anchorMessage), created: true };
}

export async function ensureTaskDiscussionThread(
  task: TaskItem,
  deps: {
    taskStore: ITaskStore;
    threadStore: IThreadStore;
    messageStore: IMessageStore;
    socketManager: SocketManager;
  },
  options: { userId?: string; broadcastUpdate?: boolean } = {},
): Promise<{
  threadId: string;
  sourceMessage: ReturnType<typeof toTaskThreadMessage>;
  task: TaskItem;
  created: boolean;
  /**
   * F194 §3 step 2: true when `threadId` was an already-live branch this call
   * reused (e.g. a thread-first anchor from ensureMessageAnchoredThread)
   * rather than a brand-new thread this call itself created. Callers use this
   * to avoid re-announcing a branch (thread_branched) that was already
   * broadcast once when it was first created.
   */
  branchReused: boolean;
}> {
  const { taskStore, threadStore, messageStore, socketManager } = deps;
  if (task.taskThreadId) {
    const existingThread = await threadStore.get(task.taskThreadId);
    if (existingThread) {
      const messages = await messageStore.getByThread(task.taskThreadId, 100);
      const sourceMessage = messages[0];
      if (sourceMessage) {
        return {
          threadId: task.taskThreadId,
          sourceMessage: toTaskThreadMessage(sourceMessage),
          task,
          created: false,
          branchReused: true,
        };
      }
    }
  }

  const parentThread = await threadStore.get(task.threadId);
  const userId = options.userId ?? task.userId ?? parentThread?.createdBy ?? 'default-user';

  // Fetched before thread creation (moved up from below) so its id can seed the
  // branch `relation` — mirrors the manual-branch shape (thread-branch.ts) so the
  // data model stays consistent between manual and task-auto-admitted branches.
  // Not for sidebar visibility (task threads stay filtered out there by design,
  // see docs/research/clowder-raft-thread-task-design.md §3 step 1.4) — this is
  // purely so downstream relation-aware features (reply-count nudges, "jump to
  // branch" entry points) work the same way for both branch kinds.
  const originalSource = task.sourceMessageId ? await messageStore.getById(task.sourceMessageId) : null;
  const relationRootMessageId =
    originalSource && originalSource.threadId === task.threadId ? originalSource.id : (task.sourceMessageId ?? task.id);

  // F194 §3 step 2: a thread-first channel may have already anchored this
  // exact source message to a branch (ensureMessageAnchoredThread, run before
  // the task-card judgment in messages.ts). Reuse it instead of creating a
  // second, competing branch for the same message.
  const reusableAnchor =
    originalSource && originalSource.threadId === task.threadId
      ? await findLiveAnchorBranch(originalSource, { threadStore, messageStore })
      : null;

  let taskThread: Thread;
  let sourceMessage: StoredMessage;
  const reusedExistingBranch = Boolean(reusableAnchor);
  if (reusableAnchor) {
    taskThread = reusableAnchor.thread;
    sourceMessage = reusableAnchor.firstMessage;
  } else {
    const relation: ThreadRelationV1 = {
      v: 1,
      kind: 'task_thread',
      parentThreadId: task.threadId,
      rootMessageId: relationRootMessageId,
    };
    taskThread = await threadStore.create(userId, formatTaskThreadTitle(task.title), parentThread?.projectPath, {
      relation,
    });

    if (parentThread?.participants?.length) {
      await threadStore.addParticipants(taskThread.id, parentThread.participants);
    }

    sourceMessage = await messageStore.append({
      userId: originalSource?.userId ?? userId,
      catId: originalSource?.catId ?? null,
      content: originalSource?.content ?? formatTaskSourceContent(task),
      mentions: originalSource?.mentions ? [...originalSource.mentions] : [],
      timestamp: originalSource?.timestamp ?? task.createdAt,
      threadId: taskThread.id,
      ...(originalSource?.contentBlocks ? { contentBlocks: originalSource.contentBlocks } : {}),
      ...(originalSource?.metadata ? { metadata: originalSource.metadata } : {}),
      ...(originalSource?.origin ? { origin: originalSource.origin } : {}),
      ...(originalSource?.source ? { source: originalSource.source } : {}),
      ...(originalSource?.visibility ? { visibility: originalSource.visibility } : {}),
      ...(originalSource?.whisperTo ? { whisperTo: [...originalSource.whisperTo] } : {}),
      ...(originalSource?.revealedAt !== undefined ? { revealedAt: originalSource.revealedAt } : {}),
    });
  }

  const linked = await taskStore.linkTaskThreadIfAbsent(task.id, {
    taskThreadId: taskThread.id,
    ...(task.sourceMessageId ? {} : { sourceMessageId: sourceMessage.id }),
  });
  if (!linked.task) {
    // Only ours to clean up if we exclusively created it this call — a reused
    // anchor may already be routing live replies and must survive this failure.
    if (!reusedExistingBranch) {
      await Promise.resolve(messageStore.deleteByThread(taskThread.id)).catch(() => undefined);
      await Promise.resolve(threadStore.delete(taskThread.id)).catch(() => undefined);
    }
    throw new Error(`Task disappeared while linking discussion thread: ${task.id}`);
  }

  if (!linked.linked) {
    if (!reusedExistingBranch) {
      await Promise.resolve(messageStore.deleteByThread(taskThread.id)).catch(() => undefined);
      await Promise.resolve(threadStore.delete(taskThread.id)).catch(() => undefined);
    }
    const winnerThreadId = linked.task.taskThreadId;
    if (!winnerThreadId) throw new Error(`Task discussion thread race produced no winner: ${task.id}`);
    const winnerMessages = await messageStore.getByThread(winnerThreadId, 100);
    const winnerSource = winnerMessages[0];
    if (!winnerSource) throw new Error(`Task discussion thread winner has no source message: ${winnerThreadId}`);
    return {
      threadId: winnerThreadId,
      sourceMessage: toTaskThreadMessage(winnerSource),
      task: linked.task,
      created: false,
      branchReused: true,
    };
  }

  if (
    originalSource &&
    originalSource.threadId === task.threadId &&
    (!originalSource.extra?.slockThread || originalSource.extra.slockThread.branchThreadId === taskThread.id)
  ) {
    // Preserve an already-accrued reply count when attaching a task to a
    // pre-existing thread-first anchor — only a genuinely fresh branch starts at 0.
    const preservedReplyCount =
      originalSource.extra?.slockThread?.branchThreadId === taskThread.id
        ? originalSource.extra.slockThread.replyCount
        : 0;
    await messageStore.updateExtra(originalSource.id, {
      ...(originalSource.extra ?? {}),
      slockThread: { branchThreadId: taskThread.id, replyCount: preservedReplyCount },
    });
  }

  if (options.broadcastUpdate !== false) {
    socketManager.broadcastToRoom(`thread:${task.threadId}`, 'task_updated', linked.task);
  }

  return {
    threadId: taskThread.id,
    sourceMessage: toTaskThreadMessage(sourceMessage),
    task: linked.task,
    created: true,
    branchReused: reusedExistingBranch,
  };
}
