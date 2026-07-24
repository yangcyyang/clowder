'use client';

import { useCallback, useState } from 'react';
import { useAgentMessages } from '@/hooks/useAgentMessages';
import { useChatCommands } from '@/hooks/useChatCommands';
import type { DeliveryMode } from '@/stores/chat-types';
import { type ChatMessage as ChatMessageData, useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

export type UploadStatus = 'idle' | 'uploading' | 'failed';
export interface SendMessageResult {
  userMessageId?: string;
  optimisticMessageId: string;
  queued?: boolean;
}

/** F35: Whisper options for private messages */
export interface WhisperOptions {
  visibility: 'whisper';
  whisperTo: string[];
}

/**
 * Hook for sending messages (text + optional images + optional whisper).
 * Handles both JSON and multipart form data modes.
 */
export function useSendMessage(activeThreadId?: string) {
  const {
    addMessage,
    addMessageToThread,
    removeThreadMessage,
    patchThreadMessage,
    replaceThreadMessageId,
    setLoading,
    setHasActiveInvocation,
    setThreadLoading,
    setThreadHasActiveInvocation,
  } = useChatStore();
  const { resetRefs } = useAgentMessages();
  const { processCommand } = useChatCommands();
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>('idle');
  const [uploadError, setUploadError] = useState<string | null>(null);

  const createClientId = useCallback((): string => {
    if (globalThis.crypto?.randomUUID) {
      return globalThis.crypto.randomUUID();
    }

    const randomHex = (length: number) =>
      Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('');

    return [
      randomHex(8),
      randomHex(4),
      `4${randomHex(3)}`,
      `${['8', '9', 'a', 'b'][Math.floor(Math.random() * 4)]}${randomHex(3)}`,
      randomHex(12),
    ].join('-');
  }, []);

  const handleSend = useCallback(
    async (
      content: string,
      images?: File[],
      overrideThreadId?: string,
      whisper?: WhisperOptions,
      deliveryMode?: DeliveryMode,
      attachments?: File[],
    ): Promise<SendMessageResult | undefined> => {
      const activeThread = activeThreadId ?? useChatStore.getState().currentThreadId;
      const threadId = overrideThreadId ?? activeThread;
      const hasImages = Boolean(images && images.length > 0);
      const hasAttachments = Boolean(attachments && attachments.length > 0);
      const isQueueSend = deliveryMode === 'queue';

      const wasCommand = await processCommand(content, threadId, { hasPayload: hasImages || hasAttachments });
      if (wasCommand) return undefined;

      // Queue sends don't reset refs — cat is still streaming
      if (!isQueueSend) resetRefs();
      setUploadError(null);
      setUploadStatus(hasImages || hasAttachments ? 'uploading' : 'idle');

      const clientMessageId = createClientId();
      const optimisticMessageId = `user-${clientMessageId}`;

      // Create user message
      const userMsg: ChatMessageData = {
        id: optimisticMessageId,
        type: 'user',
        content,
        timestamp: Date.now(),
        sendStatus: 'sending',
        ...(whisper ? { visibility: whisper.visibility, whisperTo: whisper.whisperTo } : {}),
      };
      if (hasImages || hasAttachments) {
        userMsg.contentBlocks = [
          { type: 'text' as const, text: content },
          ...(images ?? []).map((img) => ({
            type: 'image' as const,
            url: URL.createObjectURL(img),
          })),
          ...(attachments ?? []).map((file) => ({
            type: 'file' as const,
            filename: file.name,
            url: '#',
            mimeType: file.type || 'application/octet-stream',
            size: file.size,
          })),
        ];
      }
      // F117: Queue sends skip optimistic insert — bubble appears only on messages_delivered
      // (prevents queued message from showing in chat timeline before delivery)
      if (!isQueueSend) {
        if (threadId !== activeThread) {
          addMessageToThread(threadId, userMsg);
        } else {
          addMessage(userMsg);
        }
      }

      // F39: Queue sends don't flip loading/invocation flags — cat is already running,
      // and queue_updated WS event will surface the entry in QueuePanel.
      if (!isQueueSend) {
        if (threadId !== activeThread) {
          setThreadLoading(threadId, true);
          setThreadHasActiveInvocation(threadId, true);
        } else {
          setLoading(true);
          setHasActiveInvocation(true);
        }
      }

      const reconcileQueuedResponse = (
        body: { status?: string; userMessageId?: string; gameThreadId?: string } | null,
      ) => {
        if (body?.status === 'duplicate') {
          // A retry with the same requestId should converge onto the original
          // user bubble instead of leaving a second optimistic message behind.
          if (body.userMessageId) {
            replaceThreadMessageId(threadId, optimisticMessageId, body.userMessageId);
          } else {
            removeThreadMessage(threadId, optimisticMessageId);
          }
          return true;
        }
        // Game started in independent thread — remove optimistic message from source
        // and clear loading/invocation flags (game runs in its own thread, source is idle).
        // Always use thread-scoped APIs here: by the time the HTTP response arrives,
        // the user may have navigated to the game thread (via game:thread_created),
        // so the source thread may no longer be active. Thread-scoped APIs check
        // currentThreadId at call-time, correctly targeting flat or background state.
        if (body?.status === 'game_started' && body.gameThreadId) {
          removeThreadMessage(threadId, optimisticMessageId);
          setThreadLoading(threadId, false);
          setThreadHasActiveInvocation(threadId, false);
          return true;
        }
        if (body?.status !== 'queued' || isQueueSend) return false;
        // Slock-style UX: normal sends remain visible immediately even if the
        // backend serializes execution internally. Explicit queue sends still
        // use the old invisible-until-delivered path above.
        if (body.userMessageId) {
          replaceThreadMessageId(threadId, optimisticMessageId, body.userMessageId);
        }
        return true;
      };

      try {
        const deliveryModePayload = deliveryMode ? { deliveryMode } : {};

        if (hasImages || hasAttachments) {
          const formData = new FormData();
          formData.append('content', content);
          formData.append('threadId', threadId);
          formData.append('idempotencyKey', clientMessageId);
          if (deliveryMode) formData.append('deliveryMode', deliveryMode);
          if (whisper) {
            formData.append('visibility', whisper.visibility);
            for (const catId of whisper.whisperTo) {
              formData.append('whisperTo', catId);
            }
          }
          for (const img of images ?? []) {
            formData.append('images', img);
          }
          for (const file of attachments ?? []) {
            formData.append('attachments', file);
          }
          const res = await apiFetch('/api/messages', {
            method: 'POST',
            body: formData,
          });
          if (!res.ok) {
            const body = await res.json().catch(() => null);
            throw new Error(body?.detail ?? `Server error: ${res.status}`);
          }
          const body = await res.json().catch(() => null);
          if (!reconcileQueuedResponse(body) && body?.userMessageId) {
            replaceThreadMessageId(threadId, optimisticMessageId, body.userMessageId);
          }
          if (body?.userMessageId) {
            // [thread-task-design §1.1] Smart-default 'queued' means the server is
            // still serializing execution internally — surface the "排队中" badge
            // until markMessagesDelivered() clears it on the messages_delivered event.
            patchThreadMessage(threadId, body.userMessageId, {
              sendStatus: undefined,
              sendError: undefined,
              ...(body?.status === 'queued' && !isQueueSend ? { deliveryStatus: 'queued' as const } : {}),
            });
          }
          const userMessageId = typeof body?.userMessageId === 'string' ? body.userMessageId : undefined;
          setUploadStatus('idle');
          setUploadError(null);
          window.dispatchEvent(new CustomEvent('guide:confirm', { detail: { target: 'chat.input' } }));
          return { optimisticMessageId, userMessageId, queued: body?.status === 'queued' };
        } else {
          const res = await apiFetch('/api/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content,
              threadId,
              idempotencyKey: clientMessageId,
              ...(whisper ? { visibility: whisper.visibility, whisperTo: whisper.whisperTo } : {}),
              ...deliveryModePayload,
            }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => null);
            throw new Error(body?.detail ?? `Server error: ${res.status}`);
          }
          const body = await res.json().catch(() => null);
          if (!reconcileQueuedResponse(body) && body?.userMessageId) {
            replaceThreadMessageId(threadId, optimisticMessageId, body.userMessageId);
          }
          if (body?.userMessageId) {
            // [thread-task-design §1.1] Smart-default 'queued' means the server is
            // still serializing execution internally — surface the "排队中" badge
            // until markMessagesDelivered() clears it on the messages_delivered event.
            patchThreadMessage(threadId, body.userMessageId, {
              sendStatus: undefined,
              sendError: undefined,
              ...(body?.status === 'queued' && !isQueueSend ? { deliveryStatus: 'queued' as const } : {}),
            });
          }
          const userMessageId = typeof body?.userMessageId === 'string' ? body.userMessageId : undefined;
          setUploadStatus('idle');
          setUploadError(null);
          window.dispatchEvent(new CustomEvent('guide:confirm', { detail: { target: 'chat.input' } }));
          return { optimisticMessageId, userMessageId, queued: body?.status === 'queued' };
        }
      } catch (err) {
        // F39: Only clear invocation flags for normal (non-queue, non-force) sends.
        // Queue sends never set them. Force sends target a thread where a cat is
        // already running — if the force request fails (network/server error), the
        // original invocation is still active; clearing flags would hide stop/queue UI.
        const shouldClearFlags = !isQueueSend && deliveryMode !== 'force';
        if (shouldClearFlags) {
          setThreadLoading(threadId, false);
          setThreadHasActiveInvocation(threadId, false);
        }
        const errorMessage = err instanceof Error ? err.message : 'Unknown';
        if (hasImages || hasAttachments) {
          setUploadStatus('failed');
          setUploadError(errorMessage);
        } else {
          setUploadStatus('idle');
        }
        patchThreadMessage(threadId, optimisticMessageId, {
          sendStatus: 'failed',
          sendError: errorMessage,
        });
        return undefined;
      }
    },
    [
      resetRefs,
      processCommand,
      addMessage,
      addMessageToThread,
      removeThreadMessage,
      patchThreadMessage,
      replaceThreadMessageId,
      setLoading,
      setHasActiveInvocation,
      setThreadLoading,
      setThreadHasActiveInvocation,
      activeThreadId,
      createClientId,
    ],
  );

  return { handleSend, uploadStatus, uploadError };
}
