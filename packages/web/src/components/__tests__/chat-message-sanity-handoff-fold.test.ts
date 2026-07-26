/**
 * cy 2026-07-26: 理智线自动交接包默认折叠。
 * 铲屎官原话："理智线交接的这种内容属于系统消息，可以折叠起来，我有需要再自己点击展开"。
 *
 * 判定字段：message.extra?.systemKind === 'sanity_handoff'（见
 * packages/api/.../invoke-single-cat.ts generateAndPersistSanityHandoff() 的
 * messageStore.append({ extra: { systemKind: 'sanity_handoff' } })）。
 *
 * 红→绿：改动前，这类消息走 ChatMessage 的通用 isSystem 兜底气泡——整段长文原文
 * 全部可见、无折叠。本测试断言"新行为"（折叠为一行摘要），在改动前必然失败（红），
 * 在 ChatMessage.tsx 接入 SanityHandoffCard 后转绿。
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import type { ChatMessage as ChatMessageType } from '@/stores/chatStore';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      uiThinkingExpandedByDefault: false,
      threads: [],
    }),
}));

vi.mock('@/components/CatAvatar', () => ({
  CatAvatar: () => React.createElement('span', null, 'avatar'),
}));
vi.mock('@/components/SystemNoticeBar', () => ({ SystemNoticeBar: () => null }));
vi.mock('@/components/ConnectorBubble', () => ({ ConnectorBubble: () => null }));
vi.mock('@/components/EvidencePanel', () => ({ EvidencePanel: () => null }));
vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => React.createElement('pre', null, content),
}));
vi.mock('@/components/MetadataBadge', () => ({ MetadataBadge: () => null }));
vi.mock('@/components/SummaryCard', () => ({ SummaryCard: () => null }));
vi.mock('@/components/rich/RichBlocks', () => ({ RichBlocks: () => null }));

const CAPSULE_CONTENT = [
  '## 理智线自动交接包（🔴 红区）',
  '目标（推断，非精确）：（消息推断）修复 F183 seq gap 检测',
  '背景：未明确',
  '约束：禁止 git stash',
  '已完成：修复了 seq 越界判定这段绝不能在折叠态泄露',
  '已验证：回归全绿',
  '废弃方案：未明确',
  '未解决：待补充边界测试',
  '下一步：继续推进 Phase D',
  '必读文件：packages/web/src/hooks/useAgentMessages.ts',
].join('\n');

describe('ChatMessage sanity handoff fold', () => {
  let container: HTMLDivElement;
  let root: Root;
  let ChatMessage: React.FC<{ message: ChatMessageType; getCatById: (id: string) => CatData | undefined }>;

  beforeAll(async () => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const mod = await import('@/components/ChatMessage');
    ChatMessage = mod.ChatMessage;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const renderHandoffMessage = () => {
    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          getCatById: (() => undefined) as never,
          message: {
            id: 'sanity-handoff-1',
            type: 'system',
            catId: null,
            content: CAPSULE_CONTENT,
            timestamp: Date.now(),
            extra: { systemKind: 'sanity_handoff' },
          } as unknown as ChatMessageType,
        }),
      );
    });
  };

  it('renders the sanity handoff capsule collapsed by default (one-line summary, no leaked body text)', () => {
    renderHandoffMessage();

    expect(container.querySelector('[data-testid="sanity-handoff-card"]')).toBeTruthy();
    expect(container.textContent).toContain('理智线交接包');
    expect(container.textContent).toContain('点击展开');
    // The full capsule body must NOT be visible while collapsed.
    expect(container.textContent).not.toContain('修复了 seq 越界判定这段绝不能在折叠态泄露');
  });

  it('expands to reveal the full capsule text on click', async () => {
    renderHandoffMessage();
    const toggle = container.querySelector('[data-testid="sanity-handoff-toggle"]') as HTMLButtonElement;
    expect(toggle).toBeTruthy();

    await act(async () => {
      toggle.click();
    });

    expect(container.textContent).toContain('修复了 seq 越界判定这段绝不能在折叠态泄露');
  });
});
