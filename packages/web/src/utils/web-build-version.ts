export const CLIENT_WEB_BUILD_ID = process.env.NEXT_PUBLIC_CLOWDER_WEB_BUILD_ID?.trim() || 'development';

export async function fetchServerBuildId(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const response = await fetchImpl('/_clowder/build-id', {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { buildId?: unknown };
    const buildId = typeof payload.buildId === 'string' ? payload.buildId.trim() : '';
    return buildId || null;
  } catch {
    return null;
  }
}
