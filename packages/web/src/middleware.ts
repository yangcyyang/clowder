import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export function buildApiProxyRequestHeaders(input: Headers, token: string | undefined): Headers {
  const headers = new Headers(input);
  const normalized = token?.trim();
  if (normalized) {
    // Always overwrite browser input: the server-side env is the only trust source.
    headers.set('authorization', `Bearer ${normalized}`);
  }
  return headers;
}

export function middleware(request: NextRequest) {
  const requestHeaders = buildApiProxyRequestHeaders(request.headers, process.env.CLOWDER_API_BEARER_TOKEN);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  // Socket.IO upgrades are authenticated by the bearer-derived HttpOnly
  // session cookie in SocketManager. Keeping upgrades out of middleware also
  // preserves Next's native upgrade proxy path.
  matcher: ['/api/:path*'],
};
