import Link from 'next/link';
import { useEffect, useState } from 'react';
import { type CatData, formatCatName, useCatData } from '@/hooks/useCatData';
import { useChatStore } from '@/stores/chatStore';
import { ExportButton } from './ExportButton';
import { derivePresentThreadAgents, resolveThreadBranch } from './ThreadSidebar/thread-perceptibility';
import { getThreadHref } from './ThreadSidebar/thread-navigation';
import { UserProfileCandidatesEntry } from './UserProfileCandidatesPanel';

interface ChatContainerHeaderProps {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  threadId: string;
  authPendingCount: number;
  viewMode: 'single' | 'split';
  onToggleViewMode: () => void;
  onOpenMobileStatus: () => void;
  statusPanelOpen: boolean;
  onToggleStatusPanel: () => void;
  onOpenChannelSettings: () => void;
  onOpenKnowledgeCapture: () => void;
}

type HeaderThreadKind = 'channel' | 'dm' | 'unknown';

export function ChatContainerHeader({
  sidebarOpen,
  onToggleSidebar,
  threadId,
  authPendingCount,
  // F099/OQ-4: viewMode toggle hidden — candidate for removal (KD-7)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  viewMode: _viewMode,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onToggleViewMode: _onToggleViewMode,
  onOpenMobileStatus,
  statusPanelOpen,
  onToggleStatusPanel,
  onOpenChannelSettings,
  onOpenKnowledgeCapture,
}: ChatContainerHeaderProps) {
  const [isHydrated, setIsHydrated] = useState(false);
  const currentThread = useChatStore((s) => s.threads.find((t) => t.id === threadId));
  const threadKind: HeaderThreadKind =
    threadId === 'default'
      ? 'channel'
      : !isHydrated || !currentThread
        ? 'unknown'
        : currentThread.isDM
          ? 'dm'
          : 'channel';

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  const openSkillDashboard = () => {
    window.open('/api/skills/dashboard', '_blank', 'noopener,noreferrer');
  };

  return (
    <header className="safe-area-top">
      <div className="slock-chat-header h-11 border-b border-[var(--slock-border-color)] px-5 flex items-center gap-1.5">
        <button
          type="button"
          onClick={onToggleSidebar}
          className="slock-header-action slock-header-action--icon inline-flex md:hidden"
          title={sidebarOpen ? '收起侧栏' : '展开侧栏'}
          aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
        >
          <svg aria-hidden="true" className="w-4 h-4 text-cafe-secondary" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z"
              clipRule="evenodd"
            />
          </svg>
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <ThreadIndicator threadId={threadId} showChannelStamp={threadKind === 'channel'} />
          {/* cy 2026-07-26: 频道头部参与猫头像堆已按铲屎官要求摘除挂载
              （"头部红圈头像堆感觉没什么作用，看能不能把它删掉"）。PresentAgentsIndicator
              定义本身保留在下方——它自己的单测 chat-container-header-present-agents.test.ts
              仍直接单测这个 export，全库确认无其他挂载点后再考虑连组件一起删。 */}
        </div>
        {/* 批次 3 F-E: 画像人审全局入口 — 铲屎官钦点位置，工具栏图标区最左侧 */}
        <UserProfileCandidatesEntry />
        <ExportButton threadId={threadId} />
        <button
          type="button"
          onClick={openSkillDashboard}
          className="slock-header-action slock-header-action--icon hidden sm:inline-flex"
          title="打开静态 Skill 仪表板"
          aria-label="打开静态 Skill 仪表板"
        >
          <svg
            aria-hidden="true"
            className="h-4 w-4 text-cafe-secondary"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          >
            <rect x="3" y="3" width="5" height="5" />
            <rect x="12" y="3" width="5" height="5" />
            <rect x="3" y="12" width="5" height="5" />
            <path d="M12 14.5h5M14.5 12v5" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onOpenKnowledgeCapture}
          className="slock-header-action slock-header-action--icon hidden sm:inline-flex"
          title="沉淀为知识"
          aria-label="沉淀为知识"
        >
          <svg
            aria-hidden="true"
            className="h-4 w-4 text-cafe-secondary"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          >
            <path d="M5 3.5h7.5A2.5 2.5 0 0 1 15 6v10.5H7.5A2.5 2.5 0 0 1 5 14z" />
            <path d="M5 14a2.5 2.5 0 0 1 2.5-2.5H15M9 6.5h3" />
          </svg>
        </button>
        {threadKind === 'channel' && (
          <button
            type="button"
            onClick={onOpenChannelSettings}
            className="slock-header-action slock-header-action--icon inline-flex"
            title="频道设置"
            aria-label="频道设置"
          >
            <svg className="h-4 w-4 text-cafe-secondary" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path
                fillRule="evenodd"
                d="M11.49 3.17a1.5 1.5 0 00-2.98 0l-.08.55a6.95 6.95 0 00-1.4.58l-.45-.33a1.5 1.5 0 00-2.11 2.11l.33.45c-.24.45-.44.92-.58 1.4l-.55.08a1.5 1.5 0 000 2.98l.55.08c.14.49.34.96.58 1.4l-.33.45a1.5 1.5 0 002.11 2.11l.45-.33c.45.24.92.44 1.4.58l.08.55a1.5 1.5 0 002.98 0l.08-.55c.49-.14.96-.34 1.4-.58l.45.33a1.5 1.5 0 002.11-2.11l-.33-.45c.24-.45.44-.92.58-1.4l.55-.08a1.5 1.5 0 000-2.98l-.55-.08a6.95 6.95 0 00-.58-1.4l.33-.45a1.5 1.5 0 00-2.11-2.11l-.45.33a6.95 6.95 0 00-1.4-.58l-.08-.55zM10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        )}
        {authPendingCount > 0 && (
          <span
            className="inline-flex items-center justify-center h-5 min-w-[20px] px-1 rounded-full bg-conn-amber-bg text-conn-amber-text text-[10px] font-bold animate-pulse-subtle"
            title={`${authPendingCount} 个授权请求等待处理`}
          >
            🔐 {authPendingCount}
          </span>
        )}
        <button
          type="button"
          onClick={onOpenMobileStatus}
          className="slock-header-action slock-header-action--icon inline-flex lg:hidden"
          title="打开状态面板"
          aria-label="打开状态面板"
        >
          <svg aria-hidden="true" className="h-4 w-4 text-cafe-secondary" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
              clipRule="evenodd"
            />
          </svg>
        </button>
        <RightPanelToggle onToggleStatusPanel={onToggleStatusPanel} statusPanelOpen={statusPanelOpen} />
      </div>
    </header>
  );
}

/** Thread indicator: pairs confirmed channel titles with the Raft-style # stamp.
 *  D2: durable branch threads render a 分支 badge + parent breadcrumb (link back)
 *  instead of the # stamp; orphaned branches degrade to an orphan marker without
 *  ever exposing the raw parentThreadId. */
export function ThreadIndicator({ threadId, showChannelStamp }: { threadId: string; showChannelStamp: boolean }) {
  const threads = useChatStore((s) => s.threads);
  const currentThread = threads.find((t) => t.id === threadId);
  const title = threadId === 'default' ? '大厅' : (currentThread?.title ?? '未命名对话');
  const branch = threadId === 'default' ? { kind: 'root' as const } : resolveThreadBranch(currentThread, threads);

  if (branch.kind !== 'root') {
    const parentTitle =
      branch.kind === 'branch' ? (branch.parent.title ?? (branch.parent.id === 'default' ? '大厅' : '未命名对话')) : null;
    return (
      <div className="slock-channel-title flex min-w-0 items-center gap-1.5">
        <span
          className="slock-branch-badge inline-flex shrink-0 items-center gap-0.5 rounded-md bg-[var(--console-hover-bg)] px-1.5 py-0.5 text-[10px] font-semibold text-cafe-accent"
          data-testid="branch-badge"
          title="这是一个分支对话"
        >
          <svg aria-hidden="true" className="h-2.5 w-2.5" viewBox="0 0 16 16" fill="currentColor">
            <path d="M3 2.5a.75.75 0 011.5 0v3.025A4.751 4.751 0 008.75 10h2.95a1.75 1.75 0 110 1.5H8.75A6.25 6.25 0 013 5.525V2.5z" transform="rotate(180 8 8)" />
          </svg>
          分支
        </span>
        {branch.kind === 'branch' ? (
          <Link
            href={getThreadHref(branch.parent.id)}
            data-testid="branch-breadcrumb"
            className="shrink-0 truncate max-w-32 text-xs text-cafe-secondary underline decoration-dotted underline-offset-2 hover:text-cafe-accent"
            title={`返回父对话：${parentTitle}`}
          >
            {parentTitle}
          </Link>
        ) : (
          <span data-testid="branch-breadcrumb" className="shrink-0 text-xs text-cafe-muted" title="父对话已不可用">
            孤立 Thread
          </span>
        )}
        <span aria-hidden="true" className="shrink-0 text-cafe-muted">
          /
        </span>
        <p className="min-w-0 truncate text-base font-bold text-cafe" title={title}>
          {title}
        </p>
      </div>
    );
  }

  return (
    <div className="slock-channel-title flex min-w-0 items-center gap-2">
      {showChannelStamp && (
        <span className="slock-channel-stamp shrink-0" data-testid="channel-stamp" aria-hidden="true">
          #
        </span>
      )}
      <p className="min-w-0 truncate text-base font-bold text-cafe" title={title}>
        {title}
      </p>
    </div>
  );
}

/**
 * D3: Present-agents indicator — which agents are ACTUALLY in this thread.
 * Derived from the visible message set (posted or @-mentioned in THIS thread),
 * never from the config roster (participatingCats/preferredCats). The web client
 * is the user viewer; whisper safety is enforced upstream by the API and mirrored
 * by derivePresentThreadAgents' visibility filter.
 */
export function PresentAgentsIndicator({ threadId }: { threadId: string }) {
  const threadState = useChatStore((s) => s.threadStates?.[threadId]);
  const { getCatById } = useCatData();
  const present = derivePresentThreadAgents(threadState, { type: 'user' });
  const members = present
    .map((entry) => ({ ...entry, cat: getCatById(entry.catId) }))
    .filter((entry): entry is typeof entry & { cat: CatData } => Boolean(entry.cat));
  if (members.length === 0) return null;

  const visibleMembers = members.slice(0, 5);
  const overflow = members.length - visibleMembers.length;
  const title = members
    .map((entry) => `${formatCatName(entry.cat)}${entry.active ? '（进行中）' : ''}`)
    .join('、');

  return (
    <div className="hidden shrink-0 items-center sm:flex" data-testid="present-agents" title={`在场成员：${title}`}>
      <div className="flex -space-x-1.5">
        {visibleMembers.map((entry) => (
          <span
            key={entry.catId}
            data-testid={`present-agent-${entry.catId}`}
            data-active={entry.active ? 'true' : 'false'}
            className={`relative flex h-6 w-6 items-center justify-center rounded-md border-2 border-[var(--console-shell-bg)] text-[10px] font-bold text-[var(--cafe-accent-foreground)] shadow-sm ${
              entry.active ? 'ring-1 ring-cafe-accent' : ''
            }`}
            style={{ backgroundColor: entry.cat.color.primary }}
          >
            {formatCatName(entry.cat).slice(0, 1)}
            {entry.active && (
              <span
                aria-hidden="true"
                className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-cafe-accent animate-pulse-subtle"
              />
            )}
          </span>
        ))}
      </div>
      {overflow > 0 && (
        <span className="ml-1 rounded-full bg-[var(--console-hover-bg)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--cafe-text-muted)]">
          +{overflow}
        </span>
      )}
    </div>
  );
}

/**
 * F099: Pure state-transition logic for the right panel toggle.
 * Exported for testability — the component delegates to this function.
 */
export function rightPanelToggleTransition(
  statusPanelOpen: boolean,
  rightPanelMode: 'status' | 'workspace',
  callbacks: {
    onToggleStatusPanel: () => void;
    setRightPanelMode: (mode: 'status' | 'workspace') => void;
  },
) {
  if (!statusPanelOpen) {
    callbacks.onToggleStatusPanel();
    callbacks.setRightPanelMode('status');
  } else if (rightPanelMode !== 'workspace') {
    callbacks.setRightPanelMode('workspace');
  } else {
    callbacks.onToggleStatusPanel();
    callbacks.setRightPanelMode('status');
  }
}

/** F099: Unified right panel toggle — cycles closed → status → workspace → closed */
function RightPanelToggle({
  onToggleStatusPanel,
  statusPanelOpen,
}: {
  onToggleStatusPanel: () => void;
  statusPanelOpen: boolean;
}) {
  const rightPanelMode = useChatStore((s) => s.rightPanelMode);
  const setRightPanelMode = useChatStore((s) => s.setRightPanelMode);

  const handleClick = () => {
    rightPanelToggleTransition(statusPanelOpen, rightPanelMode, {
      onToggleStatusPanel,
      setRightPanelMode,
    });
  };

  const isWorkspace = rightPanelMode === 'workspace';
  const label = !statusPanelOpen ? '打开面板' : isWorkspace ? '关闭面板' : '工作区';

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`slock-header-action slock-header-action--icon hidden lg:inline-flex ${
        statusPanelOpen ? (isWorkspace ? 'slock-header-action--active' : 'slock-header-action--muted-active') : ''
      }`}
      aria-label={label}
      title={label}
    >
      <svg aria-hidden="true" className="h-4 w-4 text-cafe-secondary" viewBox="0 0 20 20" fill="currentColor">
        <path
          fillRule="evenodd"
          d="M3 4a1 1 0 011-1h12a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V4zm2 0v12h10V4H5z"
          clipRule="evenodd"
        />
        {statusPanelOpen && <rect x="12" y="4" width="4" height="12" rx="0.5" opacity="0.3" />}
      </svg>
    </button>
  );
}
