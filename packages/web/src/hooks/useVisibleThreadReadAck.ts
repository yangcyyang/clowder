'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

type AttentionState = { visibilityState: DocumentVisibilityState; hasFocus: boolean };
type AckFetcher = (input: string, init: RequestInit) => Promise<{ ok: boolean }>;

interface SettleVisibleThreadReadAckOptions {
  threadId: string;
  attention: AttentionState;
  arm: (threadId: string) => void;
  confirm: (threadId: string) => void;
  fetcher?: AckFetcher;
}

export async function settleVisibleThreadReadAck({
  threadId,
  attention,
  arm,
  confirm,
  fetcher = apiFetch,
}: SettleVisibleThreadReadAckOptions): Promise<'skipped' | 'acknowledged' | 'failed'> {
  if (attention.visibilityState !== 'visible' || !attention.hasFocus) return 'skipped';

  arm(threadId);
  try {
    const response = await fetcher(`/api/threads/${encodeURIComponent(threadId)}/read/latest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    return response.ok ? 'acknowledged' : 'failed';
  } catch {
    return 'failed';
  } finally {
    // 成功、非 2xx、异常都必须结算 suppression ledger；失败由 hook 清 key 后重试。
    confirm(threadId);
  }
}

export function useVisibleThreadReadAck(threadId: string, messageCount: number, enabled = true): void {
  const armUnreadSuppression = useChatStore((state) => state.armUnreadSuppression);
  const confirmUnreadAck = useChatStore((state) => state.confirmUnreadAck);
  const lastAckKeyRef = useRef<string | null>(null);

  const acknowledge = useCallback(() => {
    if (!enabled || typeof document === 'undefined') return;
    const ackKey = `${threadId}:${messageCount}`;
    if (lastAckKeyRef.current === ackKey) return;
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
    lastAckKeyRef.current = ackKey;

    void settleVisibleThreadReadAck({
      threadId,
      attention: { visibilityState: document.visibilityState, hasFocus: document.hasFocus() },
      arm: armUnreadSuppression,
      confirm: confirmUnreadAck,
    }).then((result) => {
      if (result === 'failed' && lastAckKeyRef.current === ackKey) lastAckKeyRef.current = null;
    });
  }, [armUnreadSuppression, confirmUnreadAck, enabled, messageCount, threadId]);

  useEffect(() => {
    acknowledge();
  }, [acknowledge]);

  useEffect(() => {
    if (!enabled) return undefined;
    document.addEventListener('visibilitychange', acknowledge);
    window.addEventListener('focus', acknowledge);
    return () => {
      document.removeEventListener('visibilitychange', acknowledge);
      window.removeEventListener('focus', acknowledge);
    };
  }, [acknowledge, enabled]);
}
