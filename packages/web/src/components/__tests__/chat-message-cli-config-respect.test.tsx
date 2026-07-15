import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { primeCoCreatorConfigCache, resetCoCreatorConfigCacheForTest } from '@/hooks/useCoCreatorConfig';
import type { ChatMessage as ChatMessageType } from '@/stores/chatStore';

// Dynamic backing for the chatStore.messages mock so tests can populate companion messages.
let storeMessages: ChatMessageType[] = [];
let globalCliOutputDefault: 'expanded' | 'collapsed' = 'collapsed';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      uiThinkingExpandedByDefault: false,
      threads: [],
      currentThreadId: null,
      isLoadingThreads: false,
      catStatuses: {},
      get messages() {
        return storeMessages;
      },
      globalBubbleDefaults: { thinking: 'collapsed', cliOutput: globalCliOutputDefault },
    }),
  resolveBubbleExpanded: (
    override: 'global' | 'expanded' | 'collapsed' | undefined,
    globalDefault: 'expanded' | 'collapsed',
  ) => {
    if (override && override !== 'global') return override === 'expanded';
    return globalDefault === 'expanded';
  },
}));

vi.mock('@/hooks/useTts', () => ({
  useTts: () => ({ state: 'idle', synthesize: vi.fn(), activeMessageId: null }),
}));

vi.mock('@/components/CatAvatar', () => ({
  CatAvatar: () => React.createElement('span', null, 'avatar'),
}));
vi.mock('@/components/ConnectorBubble', () => ({ ConnectorBubble: () => null }));
vi.mock('@/components/EvidencePanel', () => ({ EvidencePanel: () => null }));
vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) =>
    React.createElement('span', { 'data-testid': 'rendered-markdown' }, content),
}));
vi.mock('@/components/MetadataBadge', () => ({ MetadataBadge: () => null }));
vi.mock('@/components/SummaryCard', () => ({ SummaryCard: () => null }));
vi.mock('@/components/rich/RichBlocks', () => ({ RichBlocks: () => null }));
vi.mock('@/components/TimeoutDiagnosticsPanel', () => ({ TimeoutDiagnosticsPanel: () => null }));
vi.mock('@/components/TtsPlayButton', () => ({ TtsPlayButton: () => null }));

const opusCat = (): CatData =>
  ({
    id: 'opus',
    displayName: '布偶猫',
    breedId: 'ragdoll',
    color: { primary: '#FFD700', secondary: '#FFF8DC' },
  }) as unknown as CatData;

const INVOCATION_ID = 'inv-default-expand-test';

function makeStreamMessage(overrides: Partial<ChatMessageType> = {}): ChatMessageType {
  return {
    id: 'msg-stream',
    type: 'assistant',
    catId: 'opus',
    origin: 'stream',
    content: 'default stream content',
    contentBlocks: [],
    toolEvents: [{ id: 'te-1', type: 'tool_use', label: 'opus → Read', timestamp: 100 }],
    timestamp: Date.now(),
    isStreaming: false,
    extra: { stream: { invocationId: INVOCATION_ID } },
    ...overrides,
  } as ChatMessageType;
}

function makeCallbackCompanion(): ChatMessageType {
  return {
    id: 'msg-callback-companion',
    type: 'assistant',
    catId: 'opus',
    origin: 'callback',
    content: 'final speech via post_message',
    contentBlocks: [],
    timestamp: Date.now(),
    isStreaming: false,
    extra: { stream: { invocationId: INVOCATION_ID } },
  } as ChatMessageType;
}

describe('ChatMessage Slock-like CLI suppression', () => {
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
    storeMessages = [];
    globalCliOutputDefault = 'collapsed';
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

  it('A. stream-origin + text content + NO callback companion → stdout is rendered as normal text, no CLI Output chrome', () => {
    const MARKER = 'STDOUT_HINT';
    storeMessages = [];

    renderMessage(
      makeStreamMessage({
        content: `${MARKER} 这是 4.6 native final speech via stream.`,
      }),
    );

    expect(container.textContent).toContain(MARKER);
    expect(container.textContent).not.toContain('CLI Output');
    expect(container.querySelector('[data-testid="cli-output-body"]')).toBeNull();
  });

  it('A2. stream-origin + text content + expanded config → still no CLI Output chrome', () => {
    const MARKER = 'STREAM_FINAL_SPEECH_MARKER_42';
    globalCliOutputDefault = 'expanded';
    storeMessages = [];

    renderMessage(
      makeStreamMessage({
        content: `这是 4.6 native final speech via stream. ${MARKER}`,
      }),
    );

    expect(container.textContent).toContain(MARKER);
    expect(container.textContent).not.toContain('CLI Output');
    expect(container.querySelector('[data-testid="cli-output-body"]')).toBeNull();
  });

  it('B. stream-origin + text content + callback companion → no CLI Output chrome', () => {
    const STDOUT_MARKER = 'STDOUT_MARKER_47_CODEX';
    storeMessages = [
      makeStreamMessage({ id: 'msg-stream-target', content: `narrative ${STDOUT_MARKER}` }),
      makeCallbackCompanion(),
    ];

    renderMessage(
      makeStreamMessage({
        id: 'msg-stream-target',
        content: `narrative ${STDOUT_MARKER}`,
      }),
    );

    expect(container.textContent).toContain(STDOUT_MARKER);
    expect(container.textContent).not.toContain('CLI Output');
    expect(container.querySelector('[data-testid="cli-output-body"]')).toBeNull();
  });

  it('C. stream-origin + tools but NO text content → pure tool message is hidden', () => {
    storeMessages = [];

    renderMessage(
      makeStreamMessage({
        content: '', // empty
      }),
    );

    expect(container.textContent).not.toContain('CLI Output');
    expect(container.textContent).not.toContain('Read');
    expect(container.querySelector('[data-testid="cli-output-body"]')).toBeNull();
  });

  it('D. callback-origin message → content remains visible and CLI Output chrome is hidden', () => {
    storeMessages = [];

    renderMessage(
      makeStreamMessage({
        origin: 'callback',
        content: 'callback speech',
        toolEvents: [{ id: 'te-1', type: 'tool_use', label: 'opus → Read', timestamp: 100 }],
        extra: undefined,
      }),
    );

    expect(container.textContent).toContain('callback speech');
    expect(container.textContent).not.toContain('CLI Output');
    expect(container.querySelector('[data-testid="cli-output-body"]')).toBeNull();
  });

  it('E. model signature and model metadata lines are hidden from assistant text', () => {
    storeMessages = [];

    renderMessage(
      makeStreamMessage({
        content: [
          '在，任务我来处理。',
          '当前会话身份标注为：',
          '@gpt52 · model=gpt-5.5',
          '请确认输入范围。',
          '[砚砚/GPT-5.5🐾]',
        ].join('\n'),
      }),
    );

    expect(container.textContent).toContain('在，任务我来处理。');
    expect(container.textContent).toContain('请确认输入范围。');
    expect(container.textContent).not.toContain('当前会话身份标注');
    expect(container.textContent).not.toContain('model=gpt');
    expect(container.textContent).not.toContain('[砚砚/GPT-5.5🐾]');
  });

  it('F. model signature lines are hidden even when cat data is missing', () => {
    storeMessages = [];

    renderMessage(
      makeStreamMessage({
        catId: 'missing-cat',
        content: ['自然语言结论保留。', '[分工师/GPT-5.5🐾]'].join('\n'),
      }),
    );

    expect(container.textContent).toContain('自然语言结论保留。');
    expect(container.textContent).not.toContain('[分工师/GPT-5.5🐾]');
  });
});
