/**
 * 复刻 Raft 的"长消息默认折叠"体验（铲屎官带截图指定，2026-07-27）——ChatMessage.tsx
 * 接线层面的红→绿证据。CollapsibleMessageBody.test.ts 已经覆盖组件自身的折叠/展开/
 * 阈值缓冲逻辑，这份测试专门盯 ChatMessage.tsx 里"什么时候该套上新折叠、什么时候
 * 绝对不能套"的判断：
 *   ④ 流式消息（message.isStreaming）不折叠——猫正在写的时候必须能实时看到全文；
 *   ⑤ 已有专属折叠形态的消息不重复折叠：sanity_handoff（SanityHandoffCard 自己折叠）、
 *      CLI 输出块（F097 CliOutputBlock 自己折叠）、connector 系统通知条（SystemNoticeBar）
 *      ——这些走各自路径的早退分支，绝不能再套一层 Show more/Collapse。
 * 同时覆盖 ①②③ 在真实 ChatMessage 场景（assistant + user 两条分支）下的接线正确性。
 *
 * 红→绿：CollapsibleMessageBody 接入前，ChatMessage.tsx 对长文本走的是
 * CollapsibleMarkdown（其折叠开关 shouldFoldText 恒返回 false——见 utils/textFold.ts
 * 的桩实现），永远不会出现 "Show more" 文案；这里断言新文案出现，接入前必然失败（红）。
 *
 * jsdom 不跑真实布局：用 HTMLElement.prototype.scrollHeight getter 打桩模拟"渲染后的
 * 真实内容高度"（做法同 CollapsibleMessageBody.test.ts / scroll-to-bottom-button.test.ts）。
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { primeCoCreatorConfigCache, resetCoCreatorConfigCacheForTest } from '@/hooks/useCoCreatorConfig';
import type { ChatMessage as ChatMessageType } from '@/stores/chatStore';

let storeMessages: ChatMessageType[] = [];
let mockScrollHeight = 0;
let originalScrollHeightDescriptor: PropertyDescriptor | undefined;

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      uiThinkingExpandedByDefault: false,
      threads: [],
      currentThreadId: null,
      isLoadingThreads: false,
      catStatuses: {},
      globalCatActivity: {},
      get messages() {
        return storeMessages;
      },
      globalBubbleDefaults: { thinking: 'collapsed', cliOutput: 'collapsed' },
    }),
  resolveBubbleExpanded: (
    override: 'global' | 'expanded' | 'collapsed' | undefined,
    globalDefault: 'expanded' | 'collapsed',
  ) => {
    if (override && override !== 'global') return override === 'expanded';
    return globalDefault === 'expanded';
  },
}));

vi.mock('@/components/CatAvatar', () => ({
  CatAvatar: () => React.createElement('span', null, 'avatar'),
}));
vi.mock('@/components/ConnectorBubble', () => ({ ConnectorBubble: () => null }));
vi.mock('@/components/EvidencePanel', () => ({ EvidencePanel: () => null }));
vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) =>
    React.createElement('div', { 'data-testid': 'rendered-markdown' }, content),
}));
vi.mock('@/components/MetadataBadge', () => ({ MetadataBadge: () => null }));
vi.mock('@/components/SummaryCard', () => ({ SummaryCard: () => null }));
vi.mock('@/components/rich/RichBlocks', () => ({ RichBlocks: () => null }));
vi.mock('@/components/TimeoutDiagnosticsPanel', () => ({ TimeoutDiagnosticsPanel: () => null }));
vi.mock('@/components/SystemNoticeBar', () => ({
  SystemNoticeBar: () => React.createElement('div', { 'data-testid': 'system-notice-bar-stub' }, 'system notice'),
}));

const opusCat = (): CatData =>
  ({
    id: 'opus',
    displayName: '布偶猫',
    breedId: 'ragdoll',
    color: { primary: '#FFD700', secondary: '#FFF8DC' },
  }) as unknown as CatData;

const LONG_TEXT = 'Raft 长消息默认折叠回归验证段落。'.repeat(60);
const SHORT_TEXT = '短消息，不该出现任何折叠控件。';

function makeAssistantMessage(overrides: Partial<ChatMessageType> = {}): ChatMessageType {
  return {
    id: 'msg-assistant-1',
    type: 'assistant',
    catId: 'opus',
    origin: 'stream',
    content: LONG_TEXT,
    contentBlocks: [],
    timestamp: Date.now(),
    isStreaming: false,
    ...overrides,
  } as ChatMessageType;
}

function makeUserMessage(overrides: Partial<ChatMessageType> = {}): ChatMessageType {
  return {
    id: 'msg-user-1',
    type: 'user',
    catId: null,
    content: LONG_TEXT,
    contentBlocks: [],
    timestamp: Date.now(),
    ...overrides,
  } as ChatMessageType;
}

describe('ChatMessage long-body fold wiring', () => {
  let container: HTMLDivElement;
  let root: Root;
  let ChatMessage: React.FC<{ message: ChatMessageType; getCatById: (id: string) => CatData | undefined }>;

  beforeAll(async () => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    originalScrollHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return mockScrollHeight;
      },
    });
    const mod = await import('@/components/ChatMessage');
    ChatMessage = mod.ChatMessage;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    if (originalScrollHeightDescriptor) {
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeightDescriptor);
    }
  });

  beforeEach(() => {
    storeMessages = [];
    mockScrollHeight = 0;
    resetCoCreatorConfigCacheForTest();
    primeCoCreatorConfigCache({
      name: '铲屎官',
      aliases: [],
      mentionPatterns: ['@owner'],
      avatar: '/uploads/owner.png',
      color: { primary: '#000', secondary: '#FFF' },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetCoCreatorConfigCacheForTest();
    storeMessages = [];
  });

  function renderMessage(message: ChatMessageType): void {
    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          message,
          getCatById: (id: string) => (id === 'opus' ? opusCat() : undefined),
        }),
      );
    });
  }

  function getToggle(): HTMLButtonElement | null {
    return container.querySelector('[data-testid="collapsible-message-toggle"]');
  }

  // ① + ② assistant branch
  it('① long assistant message folds with a Show more control; ② expands to Collapse and back', async () => {
    mockScrollHeight = 900;
    renderMessage(makeAssistantMessage());

    expect(getToggle()?.textContent).toBe('Show more');
    expect(container.textContent).toContain(LONG_TEXT);

    await act(async () => {
      getToggle()?.click();
    });
    expect(getToggle()?.textContent).toBe('Collapse');

    await act(async () => {
      getToggle()?.click();
    });
    expect(getToggle()?.textContent).toBe('Show more');
  });

  it('① long USER message also folds — the other ChatMessage call site is wired too', () => {
    mockScrollHeight = 900;
    renderMessage(makeUserMessage());

    expect(getToggle()?.textContent).toBe('Show more');
  });

  // ③
  it('③ short assistant message renders no fold controls', () => {
    mockScrollHeight = 100;
    renderMessage(makeAssistantMessage({ content: SHORT_TEXT }));

    expect(getToggle()).toBeNull();
    expect(container.textContent).toContain(SHORT_TEXT);
  });

  it('③ short user message renders no fold controls', () => {
    mockScrollHeight = 100;
    renderMessage(makeUserMessage({ content: SHORT_TEXT }));

    expect(getToggle()).toBeNull();
  });

  // ④ NOTE on fixture shape: isUserVisibleChatMessage() (utils/chat-message-visibility.ts)
  // already hides `type==='assistant' && origin==='stream' && isStreaming` messages
  // ENTIRELY (ChatMessage returns null before our fold logic ever runs) — that's the
  // pre-existing "Slock-like" live-typing buffer (growing tokens are shown by the input
  // area's typing indicator, not the timeline bubble). Every live call site that sets
  // isStreaming:true on a fresh token (useAgentMessages.ts) pairs it with origin:'stream',
  // so that case never reaches us at all. The case OUR guard actually has to handle is a
  // *recovered* in-flight message whose origin is whatever the server persisted — see
  // useChatHistory.ts:610 ("#80: Restore streaming indicator for draft messages recovered
  // from Redis") and InlineThreadPanel's normalizeInlineThreadMessage, neither of which
  // forces origin to 'stream'. So these tests use origin:'callback' + isStreaming:true to
  // exercise the actual reachable path.
  it('④ a recovered long assistant message still marked streaming (non-stream origin) is never folded, full text stays visible', () => {
    mockScrollHeight = 900;
    renderMessage(makeAssistantMessage({ isStreaming: true, origin: 'callback' }));

    expect(getToggle()).toBeNull();
    expect(container.querySelector('[data-testid="collapsible-message-fade"]')).toBeNull();
    expect(container.textContent).toContain(LONG_TEXT);
  });

  it('④ once streaming ends, the same (now-complete) long message becomes eligible for folding', () => {
    mockScrollHeight = 900;
    const message = makeAssistantMessage({ isStreaming: true, origin: 'callback' });
    renderMessage(message);
    expect(getToggle()).toBeNull();

    renderMessage({ ...message, isStreaming: false });
    expect(getToggle()?.textContent).toBe('Show more');
  });

  it('④b documents the OTHER mechanism: a live-typing stream-origin message is hidden entirely by the pre-existing buffering gate before our fold logic even runs (not dead code — the two guards cover different cases)', () => {
    mockScrollHeight = 900;
    renderMessage(makeAssistantMessage({ isStreaming: true })); // origin defaults to 'stream'

    expect(container.textContent).toBe('');
  });

  // ⑤ sanity_handoff — must keep SanityHandoffCard's own fold, no double wrap
  it('⑤ a long sanity_handoff system message keeps its own SanityHandoffCard fold and is not double-wrapped', () => {
    mockScrollHeight = 900;
    renderMessage({
      id: 'msg-sanity',
      type: 'system',
      catId: null,
      content: LONG_TEXT,
      timestamp: Date.now(),
      extra: { systemKind: 'sanity_handoff' },
    } as unknown as ChatMessageType);

    expect(container.querySelector('[data-testid="sanity-handoff-card"]')).toBeTruthy();
    expect(getToggle()).toBeNull();
    expect(container.textContent).not.toContain('Show more');
    expect(container.textContent).not.toContain('Collapse');
  });

  // ⑤ CLI output block — must keep CliOutputBlock's own fold, no double wrap.
  //
  // NOTE on fixture shape: mockScrollHeight is a single global stub applied via
  // HTMLElement.prototype (see beforeAll) — it affects every element uniformly, and
  // CliOutputBlock never reads scrollHeight at all (grepped: no match), so the only
  // thing it can realistically represent here is "the text body's own rendered height".
  // Two scenarios below cover both a short and a long text body sharing the message
  // with toolEvents, so the "no double wrap" claim is proven under both, not just one.
  it('⑤a message with SHORT text + CLI tool events: no fold control for the short text, CliOutputBlock still shows', () => {
    mockScrollHeight = 100; // genuinely short — text body must not fold
    renderMessage(
      makeAssistantMessage({
        content: SHORT_TEXT,
        toolEvents: [{ id: 'te-1', type: 'tool_use', label: 'opus → Read', timestamp: 100 }],
      }),
    );

    expect(container.textContent).toContain('CLI Output');
    expect(getToggle()).toBeNull();
  });

  it('⑤b a message with LONG text + CLI tool events: my fold applies to the text body only, CliOutputBlock keeps its own separate (Chinese-labeled) fold — exactly one toggle of each kind', () => {
    mockScrollHeight = 900; // genuinely long — text body should fold
    renderMessage(
      makeAssistantMessage({
        content: LONG_TEXT,
        toolEvents: [{ id: 'te-1', type: 'tool_use', label: 'opus → Read', timestamp: 100 }],
      }),
    );

    expect(getToggle()?.textContent).toBe('Show more');
    expect(container.textContent).toContain('CLI Output');
    // Exactly one of MY toggle exists — CliOutputBlock is not additionally wrapped in it.
    expect(container.querySelectorAll('[data-testid="collapsible-message-toggle"]').length).toBe(1);
  });

  it('⑤ system-notice connector messages route to SystemNoticeBar and are not double-wrapped', () => {
    mockScrollHeight = 900;
    renderMessage({
      id: 'msg-notice',
      type: 'connector',
      content: LONG_TEXT,
      timestamp: Date.now(),
      source: { connector: 'system', label: 'System', icon: 'system', meta: { presentation: 'system_notice' } },
    } as unknown as ChatMessageType);

    expect(container.querySelector('[data-testid="system-notice-bar-stub"]')).toBeTruthy();
    expect(getToggle()).toBeNull();
  });
});
