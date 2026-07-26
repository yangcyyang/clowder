import { useMemo } from 'react';
import type { SocketCallbacks } from '@/hooks/useSocket';
import { useChatStore } from '@/stores/chatStore';
import { type TaskItem, useTaskStore } from '@/stores/taskStore';

interface ExternalDeps {
  threadId: string;
  handleAgentMessage: SocketCallbacks['onMessage'];
  resetTimeout: () => void;
  clearDoneTimeout: (threadId?: string) => void;
  handleAuthRequest: NonNullable<SocketCallbacks['onAuthorizationRequest']>;
  handleAuthResponse: NonNullable<SocketCallbacks['onAuthorizationResponse']>;
  onIndexEvent?: SocketCallbacks['onIndexEvent'];
}

/**
 * Socket event callbacks for a chat thread.
 * Extracted from ChatContainer to reduce file size.
 */
export function useChatSocketCallbacks({
  threadId,
  handleAgentMessage,
  resetTimeout,
  clearDoneTimeout,
  handleAuthRequest,
  handleAuthResponse,
  onIndexEvent,
}: ExternalDeps): SocketCallbacks {
  const {
    updateThreadTitle,
    updateThreadParticipants,
    setLoading,
    setHasActiveInvocation,
    setIntentMode,
    setTargetCats,
    addActiveInvocation,
    removeThreadMessage,
    patchMessage,
    requestStreamCatchUp,
  } = useChatStore();
  const { addTask, updateTask } = useTaskStore();

  return useMemo<SocketCallbacks>(
    () => ({
      clearDoneTimeout,
      onMessage: (msg) => {
        handleAgentMessage(msg);
        return true;
      },
      onThreadUpdated: (data) => {
        if (data.title !== undefined) updateThreadTitle(data.threadId, data.title);
        if (data.participants !== undefined) updateThreadParticipants(data.threadId, data.participants);
      },
      onIntentMode: (data) => {
        // Socket layer (useSocket) already applies dual-pointer guard + background routing.
        // This callback only fires for the truly active thread.
        setLoading(true);
        setHasActiveInvocation(true);
        setIntentMode(data.mode as 'ideate' | 'execute');
        setTargetCats((data as { targetCats?: string[] }).targetCats ?? []);
      },
      onSpawnStarted: (data) => {
        // F118 D2: Earliest signal — fires before intent_mode.
        // Per-cat setCatStatus('spawning') is handled by the socket layer.
        const startedAt = Date.now();
        setLoading(true);
        setHasActiveInvocation(true);
        const targetCats = data.targetCats ?? [];
        setTargetCats(targetCats);
        targetCats.forEach((catId, index) => {
          const invocationId = index === 0 ? data.invocationId : `${data.invocationId}-${catId}`;
          addActiveInvocation(invocationId, catId, 'execute', startedAt);
        });
      },
      onTaskCreated: (task) => {
        const t = task as Record<string, unknown>;
        if (t.threadId !== threadId || t.kind === 'pr_tracking') return;
        addTask(task as unknown as TaskItem);
        // [thread-task-design §3 step 1.2] Give the source message an immediate,
        // prominent "已建任务 …" inline notice the moment task_created lands live —
        // history reload naturally drops this transient marker and the persistent
        // MessageTaskBadge chip (driven by taskStore) takes over from then on.
        const sourceMessageId = typeof t.sourceMessageId === 'string' ? t.sourceMessageId : undefined;
        const taskThreadId = typeof t.taskThreadId === 'string' ? t.taskThreadId : undefined;
        const taskId = typeof t.id === 'string' ? t.id : undefined;
        if (sourceMessageId && taskThreadId && taskId) {
          patchMessage(sourceMessageId, {
            extra: { taskCreatedNotice: { taskId, taskThreadId } },
          });
        }
      },
      onTaskUpdated: (task) => {
        const t = task as Record<string, unknown>;
        if (t.threadId !== threadId || t.kind === 'pr_tracking') return;
        updateTask(task as unknown as TaskItem);
      },
      // onThreadSummary removed (clowder-ai#343): summaries no longer injected into chat flow.
      onHeartbeat: (data) => {
        if (data.threadId === threadId) resetTimeout();
      },
      onMessageDeleted: (data: { messageId: string; threadId: string }) =>
        removeThreadMessage(data.threadId, data.messageId),
      onMessageRestored: (data: { messageId: string; threadId: string }) => {
        requestStreamCatchUp(data.threadId);
      },
      onMessageEdited: (data: { messageId: string; threadId: string; content: string; editedAt: number }) => {
        if (data.threadId === threadId) {
          patchMessage(data.messageId, { content: data.content, editedAt: data.editedAt });
          return;
        }
        requestStreamCatchUp(data.threadId);
      },
      onMessageReactionsUpdated: (data) => {
        if (data.threadId === threadId) {
          patchMessage(data.messageId, { extra: { reactions: data.reactions } });
          return;
        }
        requestStreamCatchUp(data.threadId);
      },
      onThreadBranched: (data) => {
        if (data.sourceThreadId !== threadId) return;
        // [thread-task-design §2 root cause 2 / §3 step 1.1] This event can legitimately
        // re-fire for a message that already has live reply activity (e.g. reconnect
        // replay, or the branch being re-announced) — hardcoding replyCount:0 here used
        // to clobber a real count that thread_reply_count_updated had already pushed in,
        // killing the entry indicator. Preserve any existing count/latestReply instead of
        // stomping it; a genuinely brand-new branch has no prior slockThread, so it still
        // correctly starts at 0.
        const existing = useChatStore.getState().messages.find((m) => m.id === data.fromMessageId)?.extra
          ?.slockThread;
        patchMessage(data.fromMessageId, {
          extra: {
            slockThread: {
              ...existing,
              branchThreadId: data.newThreadId,
              replyCount: existing?.replyCount ?? 0,
            },
          },
        });
      },
      onThreadReplyCountUpdated: (data) => {
        // [thread-task-design §3 step 1.1] Live counterpart to deriveThreadReplySummary:
        // server pushes the authoritative count so the entry indicator moves without a
        // refetch. Broadcast lands on the MAIN thread's room regardless of whether this
        // viewer ever joined the branch room (see useSocket.ts onThreadReplyCountUpdated).
        const existing = useChatStore.getState().messages.find((m) => m.id === data.sourceMessageId)?.extra
          ?.slockThread;
        patchMessage(data.sourceMessageId, {
          extra: {
            slockThread: {
              ...existing,
              branchThreadId: data.branchThreadId,
              replyCount: data.replyCount,
            },
          },
        });
      },
      onAuthorizationRequest: handleAuthRequest,
      onAuthorizationResponse: handleAuthResponse,
      onIndexEvent,
    }),
    [
      handleAgentMessage,
      updateThreadTitle,
      updateThreadParticipants,
      setLoading,
      setHasActiveInvocation,
      setIntentMode,
      setTargetCats,
      addActiveInvocation,
      addTask,
      updateTask,
      removeThreadMessage,
      patchMessage,
      requestStreamCatchUp,
      resetTimeout,
      clearDoneTimeout,
      handleAuthRequest,
      handleAuthResponse,
      onIndexEvent,
      threadId,
    ],
  );
}
