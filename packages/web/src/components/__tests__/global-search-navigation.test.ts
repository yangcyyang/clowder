import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/ThreadSidebar/thread-navigation', () => ({
  getThreadIdFromPathname: (pathname: string) => {
    const match = pathname.match(/^\/thread\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1] ?? '') : 'default';
  },
}));

import { buildGlobalSearchHref } from '@/components/global-search-navigation';

describe('buildGlobalSearchHref', () => {
  it('preserves current thread as search referrer', () => {
    expect(buildGlobalSearchHref('/thread/thread-abc')).toBe('/search?from=thread-abc');
  });

  it('carries existing from param outside thread pages', () => {
    expect(buildGlobalSearchHref('/settings', '?from=thread-abc')).toBe('/search?from=thread-abc');
  });

  it('falls back to plain search when no referrer exists', () => {
    expect(buildGlobalSearchHref('/settings')).toBe('/search');
  });

  it('carries the quick-switch query into global search', () => {
    expect(buildGlobalSearchHref('/thread/thread-abc', '', '设计 agent')).toBe(
      '/search?from=thread-abc&q=%E8%AE%BE%E8%AE%A1+agent',
    );
  });
});
