import { useEffect, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { type CatData, formatCatName, useCatData } from '@/hooks/useCatData';
import { ExportButton } from './ExportButton';

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
  const isDirectMessage = isHydrated ? Boolean(currentThread?.isDM) : false;

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  const openSkillDashboard = () => {
    window.open('/api/skills/dashboard', '_blank', 'noopener,noreferrer');
  };

  return (
    <header className="safe-area-top">
      <div className="h-11 border-b border-[var(--slock-border-color)] px-5 flex items-center gap-2">
        <button
          onClick={onToggleSidebar}
          className="p-1 rounded-md hover:bg-[var(--console-hover-bg)] transition-colors md:hidden"
          title={sidebarOpen ? '收起侧栏' : '展开侧栏'}
          aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
        >
          <svg className="w-4 h-4 text-cafe-secondary" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z"
              clipRule="evenodd"
            />
          </svg>
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <ThreadIndicator threadId={threadId} />
          <ThreadMemberAvatars threadId={threadId} />
        </div>
        <ExportButton threadId={threadId} />
        <button
          type="button"
          onClick={openSkillDashboard}
          className="hidden rounded-lg border border-[var(--slock-border-color)] bg-[var(--console-card-soft-bg)] px-3 py-1 text-xs font-semibold text-[var(--cafe-text-secondary)] transition-colors hover:bg-[var(--console-hover-bg)] hover:text-[var(--cafe-text)] sm:inline-flex"
          title="打开静态 Skill 仪表板"
          aria-label="打开静态 Skill 仪表板"
        >
          技能库
        </button>
        <button
          type="button"
          onClick={onOpenKnowledgeCapture}
          className="hidden rounded-lg border border-[var(--slock-border-color)] bg-[var(--console-card-soft-bg)] px-2.5 py-1 text-xs font-semibold text-[var(--cafe-text-secondary)] transition-colors hover:bg-[var(--console-hover-bg)] hover:text-[var(--cafe-text)] sm:inline-flex"
          title="沉淀为知识"
          aria-label="沉淀为知识"
        >
          沉淀为知识
        </button>
        {!isDirectMessage && (
          <button
            type="button"
            onClick={onOpenChannelSettings}
            className="p-1 rounded-lg hover:bg-[var(--console-hover-bg)] transition-colors ml-1"
            title="频道设置"
            aria-label="频道设置"
          >
            <svg className="w-5 h-5 text-cafe-secondary" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
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
          onClick={onOpenMobileStatus}
          className="p-1 rounded-lg hover:bg-[var(--console-hover-bg)] transition-colors ml-1 lg:hidden"
          title="打开状态面板"
          aria-label="打开状态面板"
        >
          <svg className="w-5 h-5 text-cafe-secondary" viewBox="0 0 20 20" fill="currentColor">
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

/** Thread indicator: shows which thread you're currently chatting in */
function ThreadIndicator({ threadId }: { threadId: string }) {
  const threads = useChatStore((s) => s.threads);
  const currentThread = threads.find((t) => t.id === threadId);

  if (threadId === 'default') {
    return <p className="text-base font-bold text-cafe truncate min-w-0">大厅</p>;
  }

  const title = currentThread?.title ?? '未命名对话';

  return (
    <p className="text-base font-bold text-cafe truncate min-w-0" title={title}>
      {title}
    </p>
  );
}

function ThreadMemberAvatars({ threadId }: { threadId: string }) {
  const threads = useChatStore((s) => s.threads);
  const currentThread = threads.find((t) => t.id === threadId);
  const memberIds = currentThread?.participatingCats ?? currentThread?.preferredCats ?? [];
  const { getCatById } = useCatData();
  const members = memberIds.map((id) => getCatById(id)).filter((cat): cat is CatData => Boolean(cat));
  if (members.length === 0) return null;

  const visibleMembers = members.slice(0, 5);
  const overflow = members.length - visibleMembers.length;
  const title = members.map((cat) => formatCatName(cat)).join('、');

  return (
    <div className="hidden shrink-0 items-center sm:flex" title={`频道成员：${title}`}>
      <div className="flex -space-x-1.5">
        {visibleMembers.map((cat) => (
          <span
            key={cat.id}
            className="flex h-6 w-6 items-center justify-center rounded-md border-2 border-[var(--console-shell-bg)] text-[10px] font-bold text-[var(--cafe-accent-foreground)] shadow-sm"
            style={{ backgroundColor: cat.color.primary }}
          >
            {formatCatName(cat).slice(0, 1)}
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
      onClick={handleClick}
      className={`p-1 rounded-lg hover:bg-[var(--console-hover-bg)] transition-colors ml-1 hidden lg:block ${
        statusPanelOpen
          ? isWorkspace
            ? 'bg-[var(--color-cafe-accent)]/5 text-[var(--color-cafe-accent)]'
            : 'bg-cafe-surface-elevated'
          : ''
      }`}
      aria-label={label}
      title={label}
    >
      <svg className="w-5 h-5 text-cafe-secondary" viewBox="0 0 20 20" fill="currentColor">
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
