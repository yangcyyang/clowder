'use client';

import { useState } from 'react';
import type { ChatMessage as ChatMessageType } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { HubIcon } from './hub-icons';
import { MarkdownContent } from './MarkdownContent';

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function getNoticeTone(meta: Readonly<Record<string, unknown>> | undefined): 'info' | 'warning' | 'error' {
  const tone = meta && typeof meta === 'object' ? (meta as Record<string, unknown>).noticeTone : undefined;
  return tone === 'warning' || tone === 'error' ? tone : 'info';
}

const ICON_MAP: Record<string, string> = {
  lightbulb: 'sparkles',
  '\u{1F4A1}': 'sparkles',
  warning: 'alert-triangle',
  '\u{26A0}\u{FE0F}': 'alert-triangle',
  error: 'alert-triangle',
  info: 'info',
};

function NoticeIcon({ icon }: { icon?: string }) {
  const name = ICON_MAP[icon ?? ''] ?? 'info';
  return <HubIcon name={name} className="h-4.5 w-4.5" />;
}

interface SystemNoticeBarProps {
  message: ChatMessageType;
}

export function SystemNoticeBar({ message }: SystemNoticeBarProps) {
  const [wakeState, setWakeState] = useState<'idle' | 'working' | 'done' | 'error'>('idle');
  const source = message.source;
  if (!source) return null;

  const tone = getNoticeTone(source.meta);
  const queueEntryId = typeof source.meta?.queueEntryId === 'string' ? source.meta.queueEntryId : undefined;
  const threadId = typeof source.meta?.threadId === 'string' ? source.meta.threadId : undefined;
  const canWakeNow = source.connector === 'a2a-pending' && queueEntryId && threadId;

  const wakeNow = async () => {
    if (!canWakeNow || wakeState === 'working') return;
    setWakeState('working');
    try {
      const response = await apiFetch(`/api/threads/${threadId}/queue/${queueEntryId}/steer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'immediate' }),
      });
      setWakeState(response.ok ? 'done' : 'error');
    } catch {
      setWakeState('error');
    }
  };

  return (
    <div data-message-id={message.id} data-notice-tone={tone} className="flex justify-center mb-3">
      <div className="w-fit max-w-[85%]">
        <div className="flex items-center gap-2 mb-1 px-1">
          <span className="system-notice-bar__label text-xs font-medium">{source.label}</span>
          <span className="text-xs text-cafe-muted">{formatTime(message.timestamp)}</span>
        </div>
        <div
          className={`system-notice-bar ${tone !== 'info' ? 'system-notice-bar--alert' : ''} rounded-[var(--slock-radius-sm)] px-3 py-2 text-cafe-secondary`}
        >
          <div className="flex items-start gap-2.5">
            <span className="system-notice-bar__icon leading-none mt-0.5">
              <NoticeIcon icon={source.icon} />
            </span>
            <div className="min-w-0 flex-1 text-sm leading-6">
              <MarkdownContent content={message.content} />
              {canWakeNow ? (
                <button
                  type="button"
                  onClick={wakeNow}
                  disabled={wakeState === 'working' || wakeState === 'done'}
                  className="mt-1.5 border border-cafe-border px-2 py-0.5 text-xs font-medium disabled:opacity-50"
                >
                  {wakeState === 'working'
                    ? '正在唤醒…'
                    : wakeState === 'done'
                      ? '已唤醒'
                      : wakeState === 'error'
                        ? '重试立即唤醒'
                        : '立即唤醒'}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
