'use client';

import { usePathname } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { usePersistedState } from '@/hooks/usePersistedState';
import { ActivityBar } from './ActivityBar';
import { ThreadSidebar } from './ThreadSidebar';
import { ResizeHandle } from './workspace/ResizeHandle';

const CHROMELESS_ROUTES = ['/story-export', '/pixel-brawl', '/showcase'];

interface AppShellProps {
  children: React.ReactNode;
}

const SIDEBAR_HIDDEN_ROUTES = ['/settings', '/signals', '/memory', '/mission'];
const SIDEBAR_DEFAULT_WIDTH = 260;
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 340;

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname() ?? '/';
  const [isExport, setIsExport] = useState(false);
  const [sidebarWidth, setSidebarWidth, resetSidebarWidth] = usePersistedState(
    'cat-cafe:sidebarWidth',
    SIDEBAR_DEFAULT_WIDTH,
  );
  const handleSidebarResize = useCallback(
    (delta: number) => {
      setSidebarWidth((prev) => Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, prev + delta)));
    },
    [setSidebarWidth],
  );

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
            <div
              className="hidden md:block flex-shrink-0 border-r border-[var(--slock-border-color)]"
              style={{ width: sidebarWidth }}
            >
              <ThreadSidebar className="w-full h-full" />
            </div>
            <div className="hidden md:flex">
              <ResizeHandle
                direction="horizontal"
                onResize={handleSidebarResize}
                onDoubleClick={resetSidebarWidth}
              />
            </div>
          </Suspense>
        )}
        <div className="flex-1 min-w-0 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
