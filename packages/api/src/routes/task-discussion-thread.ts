import type { TaskItem } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';

export function formatTaskThreadTitle(title: string): string {
  const trimmed = title.trim();
  const shortTitle = trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed;
  return `${shortTitle || '任务'} (分支)`;
}

export function formatTaskSourceContent(task: { title: string; why?: string }): string {
  return [`📌 Task: ${task.title}`, task.why?.trim() ? `\n${task.why.trim()}` : ''].join('\n');
}

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
  const taskThread = await threadStore.create(userId, formatTaskThreadTitle(task.title), parentThread?.projectPath);

  if (parentThread?.participants?.length) {
    await threadStore.addParticipants(taskThread.id, parentThread.participants);
  }

  const originalSource = task.sourceMessageId ? await messageStore.getById(task.sourceMessageId) : null;
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
