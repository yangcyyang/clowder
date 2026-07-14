import { API_URL, ensureSession } from './api-client';

type BrowserLocation = Pick<Location, 'protocol' | 'hostname' | 'port'>;

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

function resolveConfiguredSocketUrl(configured: string | undefined, location: BrowserLocation): string | null {
  if (!configured) return null;
  try {
    const parsed = new URL(configured);
    if (isLoopback(parsed.hostname) !== isLoopback(location.hostname)) return null;
    if (isLoopback(parsed.hostname) && isLoopback(location.hostname)) {
      // Host-only cookies do not cross localhost/127.0.0.1. Keep the socket
      // on the exact browser hostname while preserving the configured port.
      parsed.hostname = location.hostname;
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

/**
 * Socket upgrades cannot rely on Next middleware header injection. In bearer
 * mode they connect to the API origin with the bearer-derived HttpOnly session
 * cookie; ordinary HTTP remains on the same-origin Web proxy.
 */
export function resolveSocketUrl(
  location: BrowserLocation | null = typeof window === 'undefined' ? null : window.location,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (!location || env.NEXT_PUBLIC_API_AUTH_PROXY_ENABLED !== '1') return API_URL;

  if (location.hostname === 'cafe.clowder-ai.com') return 'https://api.clowder-ai.com';

  const configured = resolveConfiguredSocketUrl(env.NEXT_PUBLIC_API_URL, location);
  if (configured) return configured;

  const port = Number(location.port || '') || 0;
  if (!port) return `${location.protocol}//${location.hostname}`;
  return `${location.protocol}//${location.hostname}:${port + 1}`;
}

/** Ensure the bearer-derived browser session exists before opening a socket. */
export function ensureSocketSession(): Promise<void> {
  if (process.env.NEXT_PUBLIC_API_AUTH_PROXY_ENABLED !== '1') return Promise.resolve();
  return ensureSession();
}

export const SOCKET_URL = resolveSocketUrl();
