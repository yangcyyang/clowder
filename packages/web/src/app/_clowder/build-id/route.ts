import { CLIENT_WEB_BUILD_ID } from '@/utils/web-build-version';

export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json(
    { buildId: CLIENT_WEB_BUILD_ID },
    { headers: { 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache' } },
  );
}
