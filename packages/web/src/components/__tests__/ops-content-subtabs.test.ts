import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({
  apiFetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  API_URL: 'http://localhost:3102',
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById: () => null, cats: [] }),
  formatCatName: () => '',
}));
vi.mock('@/stores/chatStore', () => {
  const hook = Object.assign(() => ({}), { getState: () => ({}) });
  return { useChatStore: hook };
});
vi.mock('../BrakeSettingsPanel', () => ({
  BrakeSettingsPanel: () => React.createElement('div', null, 'BrakeSettingsPanel'),
}));
vi.mock('../HubGovernanceTab', () => ({
  HubGovernanceTab: () => React.createElement('div', null, 'HubGovernanceTab'),
}));
vi.mock('../HubClaudeRescueSection', () => ({
  HubClaudeRescueSection: () => React.createElement('div', null, 'HubClaudeRescueSection'),
}));
vi.mock('../HubCommandsTab', () => ({
  HubCommandsTab: () => React.createElement('div', null, 'HubCommandsTab'),
}));
vi.mock('../HubRoutingPolicyTab', () => ({
  HubRoutingPolicyTab: () => React.createElement('div', null, 'HubRoutingPolicyTab'),
}));
vi.mock('../HubToolUsageTab', () => ({
  HubToolUsageTab: () => React.createElement('div', null, 'HubToolUsageTab'),
}));
vi.mock('../HubObservabilityTab', () => ({
  HubObservabilityTab: () => React.createElement('div', null, 'HubObservabilityTab'),
}));
vi.mock('../HubLeaderboardTab', () => ({
  HubLeaderboardTab: () => React.createElement('div', null, 'HubLeaderboardTab'),
}));
vi.mock('../settings/DangerousActionAuditPanel', () => ({
  DangerousActionAuditPanel: () => React.createElement('div', null, 'DangerousActionAuditPanel'),
}));

import { OpsContent } from '../settings/OpsContent';

describe('OpsContent sub-tabs', () => {
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

  it('renders common ops tabs first and keeps advanced sections collapsed', () => {
    act(() => {
      root.render(React.createElement(OpsContent));
    });
    const buttons = Array.from(container.querySelectorAll('button'));
    const tabLabels = buttons.map((b) => b.textContent);
    expect(tabLabels).toContain('治理与刹车');
    expect(tabLabels).toContain('命令速查');
    expect(tabLabels).toContain('紧急救援');
    expect(container.textContent).toContain('高级');
    expect(container.textContent).toContain('实验区');
    expect(tabLabels).not.toContain('用量/配额');
    expect(tabLabels).not.toContain('排行榜');
  });

  it('defaults to 治理与刹车 tab', () => {
    act(() => {
      root.render(React.createElement(OpsContent));
    });
    const buttons = Array.from(container.querySelectorAll('button'));
    const healthBtn = buttons.find((b) => b.textContent === '治理与刹车');
    expect(healthBtn?.className).toContain('bg-cafe-accent');
  });

  it('reveals advanced ops tabs when the advanced group is expanded', () => {
    act(() => {
      root.render(React.createElement(OpsContent));
    });
    const advancedToggle = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('高级'),
    );
    expect(advancedToggle).not.toBeNull();

    act(() => {
      advancedToggle!.click();
    });

    const buttons = Array.from(container.querySelectorAll('button'));
    const tabLabels = buttons.map((b) => b.textContent);
    expect(tabLabels).toContain('用量/配额');
    expect(tabLabels).toContain('监控面板');
    expect(tabLabels).toContain('审计日志');
  });

  it('switches active tab on click', () => {
    act(() => {
      root.render(React.createElement(OpsContent));
    });
    const buttons = Array.from(container.querySelectorAll('button'));
    const rescueBtn = buttons.find((b) => b.textContent === '紧急救援');
    expect(rescueBtn).not.toBeNull();

    act(() => {
      rescueBtn!.click();
    });

    expect(rescueBtn!.className).toContain('bg-cafe-accent');
    const healthBtn = buttons.find((b) => b.textContent === '治理与刹车');
    expect(healthBtn!.className).not.toContain('bg-cafe-accent');
  });
});
