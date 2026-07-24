import type { TaskItem } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadStore, ThreadRelationV1 } from '../domains/cats/services/stores/ports/ThreadStore.js';
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
}> {
  const { taskStore, threadStore, messageStore, socketManager } = deps;
  if (task.taskThreadId) {
    const existingThread = await threadStore.get(task.taskThreadId);
    if (existingThread) {
      const messages = await messageStore.getByThread(task.taskThreadId, 100);
      const sourceMessage = messages[0];
      if (sourceMessage) {
        return { threadId: task.taskThreadId, sourceMessage: toTaskThreadMessage(sourceMessage), task, created: false };
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
  const relation: ThreadRelationV1 = {
    v: 1,
    kind: 'task_thread',
    parentThreadId: task.threadId,
    rootMessageId: relationRootMessageId,
  };
  const taskThread = await threadStore.create(userId, formatTaskThreadTitle(task.title), parentThread?.projectPath, {
    relation,
  });

  if (parentThread?.participants?.length) {
    await threadStore.addParticipants(taskThread.id, parentThread.participants);
  }

  const sourceMessage = await messageStore.append({
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

  const linked = await taskStore.linkTaskThreadIfAbsent(task.id, {
    taskThreadId: taskThread.id,
    ...(task.sourceMessageId ? {} : { sourceMessageId: sourceMessage.id }),
  });
  if (!linked.task) {
    await Promise.resolve(messageStore.deleteByThread(taskThread.id)).catch(() => undefined);
    await Promise.resolve(threadStore.delete(taskThread.id)).catch(() => undefined);
    throw new Error(`Task disappeared while linking discussion thread: ${task.id}`);
  }

  if (!linked.linked) {
    await Promise.resolve(messageStore.deleteByThread(taskThread.id)).catch(() => undefined);
    await Promise.resolve(threadStore.delete(taskThread.id)).catch(() => undefined);
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
    };
  }

  if (
    originalSource &&
    originalSource.threadId === task.threadId &&
    (!originalSource.extra?.slockThread || originalSource.extra.slockThread.branchThreadId === taskThread.id)
  ) {
    await messageStore.updateExtra(originalSource.id, {
      ...(originalSource.extra ?? {}),
      slockThread: { branchThreadId: taskThread.id, replyCount: 0 },
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
  };
}
