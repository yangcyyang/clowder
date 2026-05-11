'use client';

import { usePathname } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { ActivityBar } from './ActivityBar';
import { ThreadSidebar } from './ThreadSidebar';

const CHROMELESS_ROUTES = ['/story-export', '/pixel-brawl', '/showcase'];

interface AppShellProps {
  children: React.ReactNode;
}

const SIDEBAR_HIDDEN_ROUTES = ['/settings', '/signals', '/memory', '/mission'];

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname() ?? '/';
  const [isExport, setIsExport] = useState(false);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  useEffect(() => {
    setIsExport(new URLSearchParams(window.location.search).get('export') === 'true');
  }, [pathname]);
  if (isExport || CHROMELESS_ROUTES.some((r) => pathname.startsWith(r))) {
    return <>{children}</>;
  }
  const hideThreadSidebar = SIDEBAR_HIDDEN_ROUTES.some((r) => pathname.startsWith(r));
  return (
    <div className="console-shell flex h-screen h-dvh overflow-hidden">
      {/* Left: ActivityBar */}
      <Suspense fallback={<div className="w-12 flex-shrink-0" aria-hidden="true" />}>
        <ActivityBar />
      </Suspense>

      {/* Middle: ThreadSidebar + Main Content */}
      <div className="flex flex-1 min-w-0 overflow-hidden">
        {!hideThreadSidebar && (
          <Suspense fallback={<div className="hidden md:block w-[260px] flex-shrink-0" aria-hidden="true" />}>
            <div className="hidden md:block flex-shrink-0 border-r border-[var(--slock-border-color)]" style={{ width: 'var(--slock-channel-width)' }}>
              <ThreadSidebar className="w-full h-full" />
            </div>
          </Suspense>
        )}
        <div className="flex-1 min-w-0 overflow-y-auto">{children}</div>
      </div>

      {/* Right: Context Panel (collapsible slot) */}
      {rightPanelOpen && (
        <div className="hidden lg:block flex-shrink-0 border-l border-[var(--slock-border-color)] bg-[var(--console-panel-bg)]" style={{ width: 'var(--slock-context-width)' }}>
          {/* Phase 2: RightStatusPanel / TaskBoard / Evidence will be mounted here */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--console-border-soft)]">
            <span className="text-sm font-medium text-[var(--cafe-text-secondary)]">上下文面板</span>
            <button
              type="button"
              onClick={() => setRightPanelOpen(false)}
              className="text-xs text-[var(--cafe-text-muted)] hover:text-[var(--cafe-text)] transition-colors"
            >
              收起
            </button>
          </div>
          <div className="p-4 text-sm text-[var(--cafe-text-muted)]">
            任务、Agent 状态、证据将在此展示
          </div>
        </div>
      )}

      {/* Toggle button for right panel */}
      {!rightPanelOpen && (
        <button
          type="button"
          onClick={() => setRightPanelOpen(true)}
          className="hidden lg:flex flex-shrink-0 items-center justify-center w-6 border-l border-[var(--slock-border-color)] bg-[var(--console-rail-bg)] hover:bg-[var(--console-hover-bg)] transition-colors"
          title="打开上下文面板"
          aria-label="打开上下文面板"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-[var(--cafe-text-secondary)]" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </div>
  );
}
