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

  const wakeButtonLabel =
    wakeState === 'working'
      ? '正在唤醒…'
      : wakeState === 'done'
        ? '已唤醒'
        : wakeState === 'error'
          ? '重试立即唤醒'
          : '立即唤醒';

  // cy 2026-07-26: "交接已排队"忙线挂号卡压扁成一行——"是觉得它占地方了，你把它调矮
  // 一点，整体高度都窄一些"。原三层结构（标题行 + 内容行 + 独立按钮行）收敛成一行
  // 紧凑条：⏳ @猫 忙线排队 · 空闲自动唤醒 [立即唤醒]。wakeNow/canWakeNow/wakeState
  // 回调逻辑完全不变，只改这一分支的布局。targetCatId 优先读结构化 meta 字段，历史
  // 消息缺这个字段时回退到从 content 里的 "@xxx" 前缀解析，两条路径都覆盖测试。
  if (canWakeNow) {
    const metaTargetCatId = typeof source.meta?.targetCatId === 'string' ? source.meta.targetCatId : undefined;
    const contentMention = message.content.match(/^@(\S+)/)?.[1];
    const mentionLabel = metaTargetCatId ? `@${metaTargetCatId}` : contentMention ? `@${contentMention}` : '';

    return (
      <div data-message-id={message.id} data-notice-tone={tone} className="flex justify-center mb-3">
        <div
          data-testid="a2a-pending-compact"
          className="system-notice-bar flex w-fit max-w-[85%] items-center gap-2 rounded-[var(--slock-radius-sm)] px-3 py-1.5 text-cafe-secondary"
        >
          <span aria-hidden="true" className="shrink-0 leading-none">
            ⏳
          </span>
          <span className="min-w-0 truncate text-sm">{mentionLabel ? `${mentionLabel} ` : ''}忙线排队 · 空闲自动唤醒</span>
          <span className="shrink-0 text-xs text-cafe-muted">{formatTime(message.timestamp)}</span>
          <button
            type="button"
            onClick={wakeNow}
            disabled={wakeState === 'working' || wakeState === 'done'}
            className="ml-auto shrink-0 border border-cafe-border px-2 py-0.5 text-xs font-medium disabled:opacity-50"
          >
            {wakeButtonLabel}
          </button>
        </div>
      </div>
    );
  }

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
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
