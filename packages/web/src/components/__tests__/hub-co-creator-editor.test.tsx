import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
}));

import { HubCoCreatorEditor } from '@/components/HubCoCreatorEditor';

const mockApiFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

function queryButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!button) throw new Error(`Missing button: ${text}`);
  return button as HTMLButtonElement;
}

function queryTextArea(container: HTMLElement, ariaLabel: string): HTMLTextAreaElement {
  const el = container.querySelector(`textarea[aria-label="${ariaLabel}"]`);
  if (!el) throw new Error(`Missing textarea: ${ariaLabel}`);
  return el as HTMLTextAreaElement;
}

/** Simulates typing into a React-controlled textarea/input without @testing-library. */
function setNativeValue(element: HTMLTextAreaElement, value: string) {
  const proto = Object.getPrototypeOf(element) as { constructor: { prototype: unknown } };
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value') ?? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  descriptor?.set?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Default /api/user-profile GET response used by tests that don't care about prefill content. */
function emptyUserProfileResponse() {
  return jsonResponse({ sections: { preferences: '', constraints: '', facts: '' }, rawExists: false, tokenEstimate: 0 });
}

describe('HubCoCreatorEditor', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('keeps uploaded avatar path out of the form UI while preserving it in the save payload', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ ok: true }));
    const onSaved = vi.fn(() => Promise.resolve());
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(HubCoCreatorEditor, {
          open: true,
          coCreator: {
            name: 'Co-worker',
            aliases: ['共创伙伴'],
            mentionPatterns: ['@co-worker', '@owner'],
            avatar: '/uploads/owner-lang.png',
            color: { primary: '#D4A76A', secondary: '#FFF8F0' },
          },
          onClose,
          onSaved,
        }),
      );
    });
    await flushEffects();

    expect(container.querySelector('input[aria-label="Owner Avatar"]')).toBeNull();
    expect(container.textContent).not.toContain('/uploads/owner-lang.png');

    await act(async () => {
      queryButton(container, '保存').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const patchCall = mockApiFetch.mock.calls.find(([path]) => path === '/api/config/co-creator');
    expect(patchCall?.[1]?.method).toBe('PATCH');
    const payload = JSON.parse(String(patchCall?.[1]?.body));
    expect(payload.avatar).toBe('/uploads/owner-lang.png');
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe('铲屎官画像 section (batch 3-H)', () => {
    it('prefills the three profile textareas from GET /api/user-profile on open', async () => {
      mockApiFetch.mockImplementation(async (path: string) => {
        if (path === '/api/user-profile') {
          return jsonResponse({
            sections: { preferences: '偏好A', constraints: '约束B', facts: '事实C' },
            rawExists: true,
            tokenEstimate: 12,
          });
        }
        return jsonResponse({ ok: true });
      });

      await act(async () => {
        root.render(
          React.createElement(HubCoCreatorEditor, {
            open: true,
            coCreator: null,
            onClose: vi.fn(),
            onSaved: vi.fn(() => Promise.resolve()),
          }),
        );
      });
      await flushEffects();
      await flushEffects();

      expect(queryTextArea(container, 'Owner Profile Preferences').value).toBe('偏好A');
      expect(queryTextArea(container, 'Owner Profile Constraints').value).toBe('约束B');
      expect(queryTextArea(container, 'Owner Profile Facts').value).toBe('事实C');
      expect(mockApiFetch.mock.calls.some(([path]) => path === '/api/user-profile')).toBe(true);
    });

    it('submits edited profile sections via PUT /api/user-profile alongside the existing save button', async () => {
      mockApiFetch.mockImplementation(async (path: string) => {
        if (path === '/api/user-profile') return emptyUserProfileResponse();
        return jsonResponse({ ok: true });
      });
      const onSaved = vi.fn(() => Promise.resolve());
      const onClose = vi.fn();

      await act(async () => {
        root.render(
          React.createElement(HubCoCreatorEditor, {
            open: true,
            coCreator: {
              name: 'Owner',
              aliases: [],
              mentionPatterns: ['@owner'],
              avatar: '',
              color: { primary: '#111111', secondary: '#222222' },
            },
            onClose,
            onSaved,
          }),
        );
      });
      await flushEffects();

      await act(async () => {
        setNativeValue(queryTextArea(container, 'Owner Profile Preferences'), '新偏好');
        setNativeValue(queryTextArea(container, 'Owner Profile Constraints'), '新硬约束');
        setNativeValue(queryTextArea(container, 'Owner Profile Facts'), '新事实');
      });
      await flushEffects();

      await act(async () => {
        queryButton(container, '保存').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await flushEffects();

      const putCall = mockApiFetch.mock.calls.find(([path, init]) => path === '/api/user-profile' && init?.method === 'PUT');
      expect(putCall).toBeDefined();
      const payload = JSON.parse(String(putCall?.[1]?.body));
      expect(payload).toEqual({ preferences: '新偏好', constraints: '新硬约束', facts: '新事实' });
      expect(onSaved).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('shows the over-budget warning once combined section text exceeds the 1000-token estimate', async () => {
      mockApiFetch.mockImplementation(async (path: string) => {
        if (path === '/api/user-profile') return emptyUserProfileResponse();
        return jsonResponse({ ok: true });
      });

      await act(async () => {
        root.render(
          React.createElement(HubCoCreatorEditor, {
            open: true,
            coCreator: null,
            onClose: vi.fn(),
            onSaved: vi.fn(() => Promise.resolve()),
          }),
        );
      });
      await flushEffects();

      expect(container.textContent).not.toContain('超出注入预算');

      await act(async () => {
        // ~4 chars/token estimate: 4001 chars ≈ 1001 tokens, just over the 1000 budget.
        setNativeValue(queryTextArea(container, 'Owner Profile Preferences'), 'x'.repeat(4001));
      });
      await flushEffects();

      expect(container.textContent).toContain('超出注入预算');
    });
  });
});
