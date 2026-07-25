/**
 * 批次 3 F-E: 画像人审 UI 全局入口 (UserProfileCandidatesPanel.tsx) —
 * 入口小红点 / 列表渲染 / 批准·驳回调用 / 空态。
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  candidateActionLabel,
  formatCandidateTimestamp,
  UserProfileCandidatesEntry,
  type UserProfileCandidate,
} from '@/components/UserProfileCandidatesPanel';

const apiFetchMock = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const CANDIDATE_A: UserProfileCandidate = {
  id: 'cand-a',
  content: '完成了发票模块 Phase 3，测试全部通过。',
  sourceCatId: 'kimi',
  threadId: 'thread-1',
  action: 'candidate',
  conflict: null,
  createdAt: new Date('2026-07-25T10:30:00').getTime(),
};

const CANDIDATE_B: UserProfileCandidate = {
  id: 'cand-b',
  content: '硬约束：只用 pnpm，不允许 npm install。',
  sourceCatId: 'opus',
  threadId: 'thread-2',
  action: 'hold',
  conflict: null,
  suggestion: '与既有条目重叠，建议合并为一条。',
  createdAt: new Date('2026-07-25T11:00:00').getTime(),
};

describe('UserProfileCandidatesEntry (batch 3 F-E)', () => {
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
    apiFetchMock.mockReset();
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function renderEntry() {
    root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(UserProfileCandidatesEntry));
    });
  }

  function getButton(): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="user-profile-candidates-entry-button"]',
    );
    expect(button).not.toBeNull();
    return button as HTMLButtonElement;
  }

  describe('pending-count badge', () => {
    it('renders no badge when the initial fetch returns pendingCount 0', async () => {
      apiFetchMock.mockResolvedValue(jsonResponse(200, { candidates: [], pendingCount: 0 }));
      await renderEntry();
      expect(container.querySelector('[data-testid="user-profile-candidates-badge"]')).toBeNull();
    });

    it('shows a badge with the pending count after the initial fetch resolves', async () => {
      apiFetchMock.mockResolvedValue(jsonResponse(200, { candidates: [CANDIDATE_A, CANDIDATE_B], pendingCount: 2 }));
      await renderEntry();
      const badge = container.querySelector('[data-testid="user-profile-candidates-badge"]');
      expect(badge).not.toBeNull();
      expect(badge?.textContent).toBe('2');
    });

    it('caps the badge display at "99+"', async () => {
      apiFetchMock.mockResolvedValue(jsonResponse(200, { candidates: [], pendingCount: 123 }));
      await renderEntry();
      const badge = container.querySelector('[data-testid="user-profile-candidates-badge"]');
      expect(badge?.textContent).toBe('99+');
    });
  });

  describe('list rendering', () => {
    it('opening the panel shows content / 来源猫 / action / 时间 for each candidate', async () => {
      apiFetchMock.mockResolvedValue(jsonResponse(200, { candidates: [CANDIDATE_A], pendingCount: 1 }));
      await renderEntry();

      await act(async () => {
        getButton().click();
      });

      const panel = container.querySelector('[data-testid="user-profile-candidates-panel"]');
      expect(panel).not.toBeNull();
      const row = container.querySelector(`[data-testid="user-profile-candidate-${CANDIDATE_A.id}"]`);
      expect(row).not.toBeNull();
      expect(row?.textContent).toContain(CANDIDATE_A.content);
      expect(row?.textContent).toContain('来源猫：kimi');
      expect(row?.textContent).toContain(candidateActionLabel(CANDIDATE_A.action));
      expect(row?.textContent).toContain(formatCandidateTimestamp(CANDIDATE_A.createdAt));
    });

    it('renders the optional suggestion text when present, and omits it when absent', async () => {
      apiFetchMock.mockResolvedValue(jsonResponse(200, { candidates: [CANDIDATE_A, CANDIDATE_B], pendingCount: 2 }));
      await renderEntry();
      await act(async () => {
        getButton().click();
      });

      const rowWithSuggestion = container.querySelector(`[data-testid="user-profile-candidate-${CANDIDATE_B.id}"]`);
      expect(rowWithSuggestion?.textContent).toContain('建议：与既有条目重叠，建议合并为一条。');

      const rowWithoutSuggestion = container.querySelector(`[data-testid="user-profile-candidate-${CANDIDATE_A.id}"]`);
      expect(rowWithoutSuggestion?.textContent).not.toContain('建议：');
    });

    it('falls back to "未知" when sourceCatId is null (pre-batch-3 ledger entries)', async () => {
      const legacy: UserProfileCandidate = { ...CANDIDATE_A, sourceCatId: null };
      apiFetchMock.mockResolvedValue(jsonResponse(200, { candidates: [legacy], pendingCount: 1 }));
      await renderEntry();
      await act(async () => {
        getButton().click();
      });
      const row = container.querySelector(`[data-testid="user-profile-candidate-${legacy.id}"]`);
      expect(row?.textContent).toContain('来源猫：未知');
    });
  });

  describe('empty state', () => {
    it('shows "暂无待审候选" when the queue is empty and the panel is open', async () => {
      apiFetchMock.mockResolvedValue(jsonResponse(200, { candidates: [], pendingCount: 0 }));
      await renderEntry();
      await act(async () => {
        getButton().click();
      });
      const empty = container.querySelector('[data-testid="user-profile-candidates-empty"]');
      expect(empty).not.toBeNull();
      expect(empty?.textContent).toBe('暂无待审候选');
    });
  });

  describe('approve / reject actions', () => {
    it('clicking 批准 POSTs to .../:id/approve and removes the item + decrements the badge', async () => {
      apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/user-profile/candidates' && (!init || !init.method)) {
          return jsonResponse(200, { candidates: [CANDIDATE_A], pendingCount: 1 });
        }
        if (url === `/api/user-profile/candidates/${CANDIDATE_A.id}/approve` && init?.method === 'POST') {
          return jsonResponse(200, { status: 'approved', id: CANDIDATE_A.id, section: '账号级事实' });
        }
        throw new Error(`unexpected apiFetch call: ${url}`);
      });
      await renderEntry();
      await act(async () => {
        getButton().click();
      });
      expect(container.querySelector(`[data-testid="user-profile-candidate-${CANDIDATE_A.id}"]`)).not.toBeNull();

      const approveBtn = container.querySelector<HTMLButtonElement>(
        `[data-testid="user-profile-candidate-approve-${CANDIDATE_A.id}"]`,
      );
      expect(approveBtn).not.toBeNull();
      await act(async () => {
        approveBtn?.click();
      });

      expect(apiFetchMock).toHaveBeenCalledWith(`/api/user-profile/candidates/${CANDIDATE_A.id}/approve`, {
        method: 'POST',
      });
      expect(container.querySelector(`[data-testid="user-profile-candidate-${CANDIDATE_A.id}"]`)).toBeNull();
      expect(container.querySelector('[data-testid="user-profile-candidates-badge"]')).toBeNull();
    });

    it('clicking 驳回 POSTs to .../:id/reject and removes the item', async () => {
      apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/user-profile/candidates' && (!init || !init.method)) {
          return jsonResponse(200, { candidates: [CANDIDATE_B], pendingCount: 1 });
        }
        if (url === `/api/user-profile/candidates/${CANDIDATE_B.id}/reject` && init?.method === 'POST') {
          return jsonResponse(200, { status: 'rejected', id: CANDIDATE_B.id });
        }
        throw new Error(`unexpected apiFetch call: ${url}`);
      });
      await renderEntry();
      await act(async () => {
        getButton().click();
      });

      const rejectBtn = container.querySelector<HTMLButtonElement>(
        `[data-testid="user-profile-candidate-reject-${CANDIDATE_B.id}"]`,
      );
      expect(rejectBtn).not.toBeNull();
      await act(async () => {
        rejectBtn?.click();
      });

      expect(apiFetchMock).toHaveBeenCalledWith(`/api/user-profile/candidates/${CANDIDATE_B.id}/reject`, {
        method: 'POST',
      });
      expect(container.querySelector(`[data-testid="user-profile-candidate-${CANDIDATE_B.id}"]`)).toBeNull();
    });

    it('shows an inline error and keeps the item when approve fails', async () => {
      apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/user-profile/candidates' && (!init || !init.method)) {
          return jsonResponse(200, { candidates: [CANDIDATE_A], pendingCount: 1 });
        }
        if (url === `/api/user-profile/candidates/${CANDIDATE_A.id}/approve`) {
          return jsonResponse(409, { error: '该候选已被处理（状态：approved）' });
        }
        throw new Error(`unexpected apiFetch call: ${url}`);
      });
      await renderEntry();
      await act(async () => {
        getButton().click();
      });
      const approveBtn = container.querySelector<HTMLButtonElement>(
        `[data-testid="user-profile-candidate-approve-${CANDIDATE_A.id}"]`,
      );
      await act(async () => {
        approveBtn?.click();
      });

      expect(container.textContent).toContain('该候选已被处理（状态：approved）');
    });
  });
});
