import { getThreadIdFromPathname } from './ThreadSidebar/thread-navigation';

export function buildGlobalSearchHref(pathname: string, currentSearch = '', query = ''): string {
  const threadId = getThreadIdFromPathname(pathname);
  let referrer = threadId !== 'default' ? threadId : null;

  if (!referrer && currentSearch) {
    referrer = new URLSearchParams(currentSearch).get('from');
  }

  const params = new URLSearchParams();
  if (referrer) params.set('from', referrer);
  const trimmedQuery = query.trim();
  if (trimmedQuery) params.set('q', trimmedQuery);
  const next = params.toString();
  return next ? `/search?${next}` : '/search';
}
