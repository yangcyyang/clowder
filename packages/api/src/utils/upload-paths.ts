import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const LEGACY_MODULE_UPLOAD_DIR = resolve(THIS_DIR, '../../uploads');
const SHARED_DEFAULT_UPLOAD_DIR = resolve(homedir(), '.cat-cafe/uploads');

/**
 * Resolve the upload directory.
 * Explicit UPLOAD_DIR keeps caller-controlled behavior.
 * Without configuration, default to ~/.cat-cafe/uploads so avatars and
 * attachments do not disappear when Clowder is started from another worktree.
 */
export function getDefaultUploadDir(configuredUploadDir?: string): string {
  if (!configuredUploadDir) return SHARED_DEFAULT_UPLOAD_DIR;
  if (configuredUploadDir === './uploads') return LEGACY_MODULE_UPLOAD_DIR;
  return resolve(configuredUploadDir.replace(/^~(?=$|\/)/, homedir()));
}

const INTERNAL_ROUTE_PREFIXES = ['/uploads/', '/api/connector-media/', '/api/tts/audio/'];

export function resolveInternalRouteUrl(url: string): string {
  if (url.startsWith('https://') || url.startsWith('http://')) return url;
  if (INTERNAL_ROUTE_PREFIXES.some((p) => url.startsWith(p))) {
    const apiBase = (
      process.env.CAT_CAFE_API_URL ??
      process.env.NEXT_PUBLIC_API_URL ??
      'http://localhost:3004'
    ).replace(/\/$/, '');
    return `${apiBase}${url}`;
  }
  return url;
}
