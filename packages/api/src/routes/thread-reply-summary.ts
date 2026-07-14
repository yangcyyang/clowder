import { isDelivered, type StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import { canViewMessage, isUserVisibleUnreadMessage, type Viewer } from '../domains/cats/services/stores/visibility.js';

export interface ThreadReplyPreview {
  id: string;
  catId: string | null;
  content: string;
  timestamp: number;
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
  viewer: Viewer = { type: 'user' },
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
    },
  };
}
