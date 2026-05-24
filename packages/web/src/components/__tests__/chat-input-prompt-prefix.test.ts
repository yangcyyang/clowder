import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from '@/components/ChatInput';

vi.mock('@/components/icons/AttachIcon', () => ({
  AttachIcon: () => React.createElement('span', null, 'attach'),
}));
vi.mock('@/components/ImagePreview', () => ({
  ImagePreview: () => null,
}));
vi.mock('@/utils/compressImage', () => ({
  compressImage: (file: File) => Promise.resolve(file),
}));
vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [
      {
        id: 'codex',
        displayName: 'Codex',
        color: { primary: '#888', secondary: '#666' },
        avatar: '/avatars/codex.png',
        mentionPatterns: ['codex'],
        provider: 'test',
        defaultModel: 'test',
        roleDescription: '',
        personality: '',
      },
    ],
    isLoading: false,
  }),
}));

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
});

function getTextarea(): HTMLTextAreaElement {
  return container.querySelector('textarea') as HTMLTextAreaElement;
}

function typeInto(textarea: HTMLTextAreaElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  nativeSetter.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function getSendButton(): HTMLButtonElement {
  return container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement;
}

describe('ChatInput prompt prefix menu', () => {
  it('prepends the selected common prompt before sending', async () => {
    const onSend = vi.fn();
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-1', onSend }));
    });

    const prefixButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('提示词'),
    ) as HTMLButtonElement;
    expect(prefixButton).toBeTruthy();

    act(() => {
      prefixButton.click();
    });
    expect(container.querySelector('[data-testid="prompt-prefix-menu"]')).toBeTruthy();

    const planOption = Array.from(container.querySelectorAll('[role="menuitemradio"]')).find((button) =>
      button.textContent?.includes('方案规划'),
    ) as HTMLButtonElement;
    expect(planOption).toBeTruthy();

    act(() => {
      planOption.click();
      typeInto(getTextarea(), '@codex 帮我拆一下这个功能');
    });

    await act(async () => {
      getSendButton().click();
    });

    expect(onSend).toHaveBeenCalledTimes(1);
    const sentContent = onSend.mock.calls[0][0] as string;
    expect(sentContent).toContain('[PLAN_MODE]');
    expect(sentContent).toContain('用户原始需求：');
    expect(sentContent).toContain('@codex 帮我拆一下这个功能');
  });

  it('migrates the legacy interview toggle to the requirements prefix', async () => {
    window.localStorage.setItem('cat-cafe:cvoMode', '1');
    const onSend = vi.fn();

    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-1', onSend }));
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain('需求前置');

    act(() => {
      typeInto(getTextarea(), '帮我写需求');
    });
    await act(async () => {
      getSendButton().click();
    });

    const sentContent = onSend.mock.calls[0][0] as string;
    expect(sentContent).toContain('[CVO_MODE]');
    expect(sentContent).toContain('帮我写需求');
  });
});
