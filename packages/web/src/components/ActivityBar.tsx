'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useCafeTheme } from '@/hooks/useCafeTheme';
import { usePinnedSections } from '@/hooks/usePinnedSections';
import { HubIcon } from './hub-icons';
import { MemoryIcon } from './icons/MemoryIcon';
import { isDailySettingsSection, SETTINGS_SECTIONS } from './settings/settings-nav-config';
import { getThreadIdFromPathname } from './ThreadSidebar/thread-navigation';

type VisualTheme = 'claude' | 'slockv1' | 'slock' | 'kami';

const VISUAL_THEME_STORAGE_KEY = 'clowder:visual-theme';
const VISUAL_THEME_DEFAULT_MIGRATION_KEY = 'clowder:visual-theme-default:v4';
const VISUAL_THEME_ORDER: VisualTheme[] = ['claude', 'slockv1', 'slock', 'kami'];
const DEFAULT_VISUAL_THEME: VisualTheme = 'slock';

const NAV_ITEMS = [
  { id: 'home', path: '/', label: '对话', match: (p: string) => p === '/' || p.startsWith('/thread/') },
  { id: 'mission', path: '/mission-hub', label: '任务', match: (p: string) => p.startsWith('/mission') },
  { id: 'memory', path: '/memory', label: '记忆', match: (p: string) => p.startsWith('/memory') },
] as const;

function ChatIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <title>对话</title>
      <path
        d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MissionIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <title>Mission Hub</title>
      <path
        d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M15 3v4a1 1 0 0 0 1 1h4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 13h6" strokeLinecap="round" />
      <path d="M9 17h3" strokeLinecap="round" />
    </svg>
  );
}

function SunIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <title>日间模式</title>
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function MoonIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <title>夜间模式</title>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SettingsIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <title>设置</title>
      <circle cx="12" cy="12" r="3" />
      <path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function VisualThemeIcon({ theme }: { theme: VisualTheme }) {
  const label =
    theme === 'slockv1'
      ? 'V1'
      : theme === 'kami'
        ? 'K'
        : theme === 'slock'
            ? 'SL'
            : 'C';

  return (
    <span className="text-[11px] font-bold leading-none tracking-[-0.02em]" aria-hidden="true">
      {label}
    </span>
  );
}

function getVisualThemeLabel(theme: VisualTheme): string {
  if (theme === 'kami') return 'KAMI';
  if (theme === 'slockv1') return 'Slock v1';
  if (theme === 'slock') return 'Slock';
  return 'Claude';
}

function normalizeVisualTheme(theme: string | null): VisualTheme {
  if (theme === 'tesla') return 'slockv1';
  return VISUAL_THEME_ORDER.includes(theme as VisualTheme) ? (theme as VisualTheme) : DEFAULT_VISUAL_THEME;
}

const ICON_MAP: Record<string, ({ className }: { className?: string }) => JSX.Element> = {
  home: ChatIcon,
  memory: MemoryIcon,
  mission: MissionIcon,
  settings: SettingsIcon,
};

interface ActivityBarProps {
  className?: string;
}

function PinnedSections({ pinned, onNav }: { pinned: readonly string[]; onNav: (path: string) => void }) {
  const searchParams = useSearchParams();
  const activeSection = searchParams?.get('s') ?? '';
  const isStandalone = searchParams?.get('standalone') === '1';

  const pinnedSections = pinned
    .map((id) => SETTINGS_SECTIONS.find((s) => s.id === id))
    .filter((s): s is (typeof SETTINGS_SECTIONS)[number] => s != null && isDailySettingsSection(s));

  if (pinnedSections.length === 0) return null;

  return (
    <>
      <div className="my-1 h-px w-6 bg-[var(--console-border-soft)] opacity-50" />
      {pinnedSections.map((sec) => {
        const active = isStandalone && activeSection === sec.id;
        return (
          <button
            key={sec.id}
            type="button"
            onClick={() => onNav(`/settings?s=${sec.id}&standalone=1`)}
            className={`console-activity-button flex h-10 w-10 items-center justify-center rounded-[9px] transition-all ${
              active
                ? 'bg-[var(--console-rail-active)] shadow-[0_5px_14px_rgba(43,37,32,0.07)]'
                : 'bg-[var(--console-rail-item)] hover:bg-[var(--console-hover-bg)]'
            }`}
            title={sec.label}
            aria-current={active ? 'page' : undefined}
            data-active={active ? 'true' : 'false'}
          >
            <HubIcon name={sec.icon} className="h-[18px] w-[18px]" />
          </button>
        );
      })}
    </>
  );
}

function SettingsButton({ pathname, onNav }: { pathname: string; onNav: (path: string) => void }) {
  const searchParams = useSearchParams();
  const isSettingsRoute = pathname.startsWith('/settings');
  const isStandalone = isSettingsRoute && searchParams?.get('standalone') === '1';
  const isSettings = isSettingsRoute && !isStandalone;

  return (
    <button
      type="button"
      onClick={() => onNav('/settings')}
      className={`console-activity-button flex h-10 w-10 items-center justify-center rounded-[9px] transition-all ${
        isSettings
          ? 'bg-[var(--console-rail-active)] shadow-[0_5px_14px_rgba(43,37,32,0.07)]'
          : 'bg-[var(--console-rail-item)] hover:bg-[var(--console-hover-bg)]'
      }`}
      title="设置"
      aria-current={isSettings ? 'page' : undefined}
      data-active={isSettings ? 'true' : 'false'}
      data-guide-id="hub.trigger"
    >
      <SettingsIcon className="h-5 w-5" />
    </button>
  );
}

export function ActivityBar({ className }: ActivityBarProps) {
  const pathname = usePathname() ?? '/';
  const router = useRouter();
  const { toggleTheme, resolvedTheme } = useCafeTheme();
  const { pinned } = usePinnedSections();
  const [mounted, setMounted] = useState(false);
  const [visualTheme, setVisualTheme] = useState<VisualTheme>(DEFAULT_VISUAL_THEME);

  useEffect(() => {
    // Honor any stored valid theme; default-version bumps must never reset a user's explicit choice.
    // The migration key is still written for backward compatibility with older builds.
    const storedTheme = window.localStorage.getItem(VISUAL_THEME_STORAGE_KEY);
    const nextTheme = normalizeVisualTheme(storedTheme);
    setVisualTheme(nextTheme);
    document.documentElement.dataset.visualTheme = nextTheme;
    window.localStorage.setItem(VISUAL_THEME_STORAGE_KEY, nextTheme);
    window.localStorage.setItem(VISUAL_THEME_DEFAULT_MIGRATION_KEY, '1');
    setMounted(true);
  }, []);

  const toggleVisualTheme = useCallback(() => {
    setVisualTheme((current) => {
      const currentIndex = VISUAL_THEME_ORDER.indexOf(current);
      const nextTheme = VISUAL_THEME_ORDER[(currentIndex + 1) % VISUAL_THEME_ORDER.length] ?? DEFAULT_VISUAL_THEME;
      document.documentElement.dataset.visualTheme = nextTheme;
      window.localStorage.setItem(VISUAL_THEME_STORAGE_KEY, nextTheme);
      return nextTheme;
    });
  }, []);

  const handleNav = useCallback(
    (path: string) => {
      const threadId = getThreadIdFromPathname(pathname);
      let referrer = threadId !== 'default' ? threadId : null;
      if (!referrer && typeof window !== 'undefined') {
        referrer = new URLSearchParams(window.location.search).get('from');
      }
      if (path === '/') {
        const fromParam =
          typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('from') : null;
        router.push(fromParam ? `/thread/${fromParam}` : '/');
      } else if (referrer) {
        const sep = path.includes('?') ? '&' : '?';
        router.push(`${path}${sep}from=${encodeURIComponent(referrer)}`);
      } else {
        router.push(path);
      }
    },
    [pathname, router],
  );

  return (
    <nav
      className={`console-activity-rail flex w-[var(--slock-rail-width)] flex-shrink-0 flex-col items-center gap-1.5 border-r border-[var(--slock-border-color)] bg-[var(--console-rail-bg)] px-[6px] py-2.5 text-[var(--console-rail-fg)] ${className ?? ''}`}
      aria-label="主导航"
    >
      {NAV_ITEMS.map((item) => {
        const Icon = ICON_MAP[item.id];
        const active = item.match(pathname);
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => handleNav(item.path)}
            className={`console-activity-button flex h-10 w-10 items-center justify-center rounded-[9px] transition-all ${
              active
                ? 'bg-[var(--console-rail-active)] shadow-[0_5px_14px_rgba(43,37,32,0.07)]'
                : 'bg-[var(--console-rail-item)] hover:bg-[var(--console-hover-bg)]'
            }`}
            title={item.label}
            aria-current={active ? 'page' : undefined}
            data-active={active ? 'true' : 'false'}
            data-guide-id={`nav.${item.id}`}
          >
            <Icon className="h-5 w-5" />
          </button>
        );
      })}

      <Suspense>
        <PinnedSections pinned={pinned} onNav={handleNav} />
      </Suspense>

      <div className="mt-auto flex flex-col items-center gap-1.5">
        <button
          type="button"
          onClick={toggleVisualTheme}
          className="console-activity-button flex h-10 w-10 items-center justify-center rounded-[9px] bg-[var(--console-rail-item)] hover:bg-[var(--console-hover-bg)] transition-all"
          title={mounted ? `当前 ${getVisualThemeLabel(visualTheme)} 风格，点击切换下一套` : '切换视觉风格'}
          aria-label={mounted ? `当前 ${getVisualThemeLabel(visualTheme)} 风格，点击切换下一套` : '切换视觉风格'}
          data-active="false"
        >
          <VisualThemeIcon theme={mounted ? visualTheme : DEFAULT_VISUAL_THEME} />
        </button>
        <button
          type="button"
          onClick={toggleTheme}
          className="console-activity-button flex h-10 w-10 items-center justify-center rounded-[9px] bg-[var(--console-rail-item)] hover:bg-[var(--console-hover-bg)] transition-all"
          title={mounted && resolvedTheme === 'dark' ? '切换到日间模式' : '切换到夜间模式'}
          data-active="false"
        >
          {mounted && resolvedTheme === 'dark' ? <MoonIcon className="h-5 w-5" /> : <SunIcon className="h-5 w-5" />}
        </button>
        <Suspense
          fallback={
            <button
              type="button"
              className="console-activity-button flex h-10 w-10 items-center justify-center rounded-[9px] bg-[var(--console-rail-item)] transition-all"
              title="设置"
              data-active="false"
              data-guide-id="hub.trigger"
            >
              <SettingsIcon className="h-5 w-5" />
            </button>
          }
        >
          <SettingsButton pathname={pathname} onNav={handleNav} />
        </Suspense>
      </div>
    </nav>
  );
}
