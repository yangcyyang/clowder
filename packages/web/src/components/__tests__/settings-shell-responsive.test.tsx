import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsShell } from '../settings/SettingsShell';

vi.mock('@/hooks/usePinnedSections', () => ({
  usePinnedSections: () => ({ pinned: [], pin: vi.fn(), unpin: vi.fn(), isPinned: () => false }),
}));

vi.mock('../settings/SettingsContent', () => ({
  SettingsContent: ({ section }: { section: string }) => (
    <div data-testid="settings-content">Settings section: {section}</div>
  ),
}));

describe('SettingsShell responsive layout', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('keeps the desktop settings sidebar and adds a mobile section strip', async () => {
    await act(async () => {
      root.render(React.createElement(SettingsShell));
    });

    const desktopNav = container.querySelector('[data-console-panel="settings-nav"]');
    const mobileNav = container.querySelector('[data-console-panel="settings-mobile-nav"]');

    expect(desktopNav?.className).toContain('hidden');
    expect(desktopNav?.className).toContain('md:flex');
    expect(mobileNav?.className).toContain('md:hidden');
    expect(mobileNav?.textContent).toContain('成员管理');
    expect(container.textContent).toContain('Settings section: members');
  });
});
