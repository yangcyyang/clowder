import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatMessage as ChatMessageType } from '@/stores/chatStore';
import { SystemNoticeBar } from '../SystemNoticeBar';

vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => React.createElement('p', null, content),
}));

const mockApiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

function renderNotice(message: Partial<ChatMessageType> & Pick<ChatMessageType, 'content' | 'timestamp' | 'source'>) {
  return renderToStaticMarkup(
    <SystemNoticeBar
      message={
        {
          id: 'notice-1',
          type: 'connector',
          ...message,
        } as ChatMessageType
      }
    />,
  );
}

describe('SystemNoticeBar', () => {
  it('uses Clowder cafe surface styling for info notices instead of a generic blue card', () => {
    const html = renderNotice({
      content: '想交接给 @codex？把它单独放到新起一行开头，才能触发交接。',
      timestamp: new Date('2026-04-16T12:34:00+08:00').getTime(),
      source: {
        connector: 'inline-mention-hint',
        label: 'Routing hint',
        icon: 'lightbulb',
        meta: { noticeTone: 'info' },
      },
    });

    expect(html).toContain('data-notice-tone="info"');
    expect(html).toContain('system-notice-bar');
    expect(html).toContain('text-cafe-secondary');
    expect(html).not.toContain('bg-blue-50');
    expect(html).not.toContain('text-slate-900');
    expect(html).not.toMatch(/text-\[#[0-9A-Fa-f]{3,6}\]/);
    expect(html).not.toMatch(/border-\[#[0-9A-Fa-f]{3,6}\]/);
  });

  it('renders notices as compact fit-content bars instead of full-width cards', () => {
    const html = renderNotice({
      content: '已从消息创建 task #1：确认',
      timestamp: new Date('2026-04-16T12:34:00+08:00').getTime(),
      source: {
        connector: 'task-system',
        label: 'Task',
        icon: '📋',
        meta: { noticeTone: 'info' },
      },
    });

    expect(html).toContain('w-fit');
    expect(html).toContain('max-w-[85%]');
    expect(html).not.toContain(' w-full');
    expect(html).toContain('rounded-[var(--slock-radius-sm)]');
  });

  it('keeps warning emphasis in metadata while leaving the notice body on the shared cafe palette', () => {
    const html = renderNotice({
      content: '服务刚重启，opus 的进行中请求已中断，请重新发送。',
      timestamp: new Date('2026-04-16T12:34:00+08:00').getTime(),
      source: {
        connector: 'startup-reconciler',
        label: '重启通知',
        icon: '⚠️',
        meta: { noticeTone: 'warning' },
      },
    });

    expect(html).toContain('data-notice-tone="warning"');
    expect(html).toContain('system-notice-bar--alert');
    expect(html).toContain('text-cafe-muted');
    expect(html).toContain('text-cafe-secondary');
    expect(html).not.toContain('bg-conn-amber-bg');
    expect(html).not.toContain('text-amber-950');
    expect(html).not.toMatch(/text-\[#[0-9A-Fa-f]{3,6}\]/);
    expect(html).not.toMatch(/border-\[#[0-9A-Fa-f]{3,6}\]/);
  });

  it('renders an immediate wake control for durable A2A pending notices', () => {
    const html = renderNotice({
      content: '@codex 已排队，目标空闲后自动唤醒。',
      timestamp: Date.now(),
      source: {
        connector: 'a2a-pending',
        label: '交接已排队',
        icon: 'info',
        meta: {
          noticeTone: 'info',
          threadId: 'thread-1',
          queueEntryId: 'entry-1',
        },
      },
    });

    expect(html).toContain('立即唤醒');
    expect(html).toContain('button');
    expect(html).not.toContain('请稍后手动重试');
  });
});

/**
 * cy 2026-07-26: "交接已排队"忙线挂号卡压扁成一行。
 * 铲屎官原话："是觉得它占地方了，你把它调矮一点，整体高度都窄一些"。
 * 原三层结构（标题行"交接已排队 20:01" + 内容行"@opus-45 已排队，目标空闲后自动
 * 唤醒。" + 独立按钮行"立即唤醒"）收敛成一行：⏳ @opus-45 忙线排队 · 空闲自动唤醒
 *   [立即唤醒]。唤醒按钮的回调（wakeNow → POST /api/threads/:id/queue/:entry/steer）
 * 必须原样保留，只改布局。
 */
describe('SystemNoticeBar — compact a2a-pending bar (cy 2026-07-26)', () => {
  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  afterEach(() => {
    mockApiFetch.mockReset();
  });

  it('renders the a2a-pending notice as a single-line compact bar, not the old 3-tier layout', () => {
    const html = renderNotice({
      content: '@opus-45 已排队，目标空闲后自动唤醒。',
      timestamp: new Date('2026-07-26T20:01:00+08:00').getTime(),
      source: {
        connector: 'a2a-pending',
        label: '交接已排队',
        icon: 'info',
        meta: {
          noticeTone: 'info',
          threadId: 'thread-1',
          queueEntryId: 'entry-1',
          targetCatId: 'opus-45',
        },
      },
    });

    expect(html).toContain('data-testid="a2a-pending-compact"');
    expect(html).toContain('⏳');
    expect(html).toContain('@opus-45');
    expect(html).toContain('忙线排队');
    expect(html).toContain('空闲自动唤醒');
    expect(html).toContain('立即唤醒');
    // Old 3-tier layout must be gone: no more separate "交接已排队" title-row label.
    expect(html).not.toContain('system-notice-bar__label');
    expect(html).not.toContain('交接已排队');
  });

  it('falls back to the @mention parsed from content when meta has no targetCatId', () => {
    const html = renderNotice({
      content: '@codex 已排队，目标空闲后自动唤醒。',
      timestamp: Date.now(),
      source: {
        connector: 'a2a-pending',
        label: '交接已排队',
        icon: 'info',
        meta: { noticeTone: 'info', threadId: 'thread-1', queueEntryId: 'entry-1' },
      },
    });

    expect(html).toContain('@codex');
    expect(html).toContain('忙线排队 · 空闲自动唤醒');
  });

  it('keeps the wake-now callback wired: clicking the inline button still POSTs the steer request', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(SystemNoticeBar, {
          message: {
            id: 'notice-compact-1',
            type: 'connector',
            content: '@opus-45 已排队，目标空闲后自动唤醒。',
            timestamp: Date.now(),
            source: {
              connector: 'a2a-pending',
              label: '交接已排队',
              icon: 'info',
              meta: {
                noticeTone: 'info',
                threadId: 'thread-1',
                queueEntryId: 'entry-1',
                targetCatId: 'opus-45',
              },
            },
          } as ChatMessageType,
        }),
      );
    });

    const button = container.querySelector('button') as HTMLButtonElement;
    expect(button).toBeTruthy();
    expect(button.textContent).toBe('立即唤醒');

    await act(async () => {
      button.click();
    });

    expect(mockApiFetch).toHaveBeenCalledWith('/api/threads/thread-1/queue/entry-1/steer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'immediate' }),
    });
    expect(button.textContent).toBe('已唤醒');

    act(() => root.unmount());
    container.remove();
  });
});
