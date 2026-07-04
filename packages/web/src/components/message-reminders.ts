import type { CatData } from '@/hooks/useCatData';
import type { ChatMessage } from '@/stores/chatStore';

export interface AgentReminder {
  id: string;
  catId: string;
  threadId: string;
  sourceMessageId?: string;
  message: string;
  fireAt: number;
  status: 'scheduled' | 'fired' | 'canceled';
  createdAt: number;
  updatedAt: number;
}

export function getMessageReminderExcerpt(content: string, maxLength = 180): string {
  const text = content.replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

export function buildMessageReminderText(message: ChatMessage): string {
  const excerpt = getMessageReminderExcerpt(message.content || '这条消息');
  return `跟进这条消息：${excerpt}\n\n消息 ID：${message.id}`;
}

export function getDefaultReminderTargetCatId(message: ChatMessage, cats: CatData[]): string {
  if (message.catId) return message.catId;
  const explicitTarget = message.extra?.targetCats?.find((id) => cats.some((cat) => cat.id === id));
  if (explicitTarget) return explicitTarget;
  return cats[0]?.id ?? '';
}

export function getThirtyMinutesLater(now = Date.now()): number {
  return now + 30 * 60 * 1000;
}

export function getTonightReminderTime(now = Date.now()): number {
  const date = new Date(now);
  date.setHours(21, 0, 0, 0);
  if (date.getTime() <= now) {
    date.setDate(date.getDate() + 1);
  }
  return date.getTime();
}

export function toDatetimeLocalValue(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

export function parseDatetimeLocalValue(value: string): number | null {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function formatReminderFireTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}
