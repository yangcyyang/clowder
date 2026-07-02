import { getThreadIdFromPathname } from './ThreadSidebar/thread-navigation';

export function buildGlobalSearchHref(pathname: string, currentSearch = ''): string {
  const threadId = getThreadIdFromPathname(pathname);
  let referrer = threadId !== 'default' ? threadId : null;

  if (!referrer && currentSearch) {
    referrer = new URLSearchParams(currentSearch).get('from');
  }

  return referrer ? `/search?from=${encodeURIComponent(referrer)}` : '/search';
}
