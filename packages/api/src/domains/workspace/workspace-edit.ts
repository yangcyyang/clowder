/**
 * Workspace Edit — F063 AC-9
 *
 * Edit session token management (HMAC-signed, 30min TTL) and
 * atomic file write with sha256 conflict detection.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

// Token secret — generated once per process lifetime
const TOKEN_SECRET = randomBytes(32);
const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface TokenPayload {
  worktreeId: string;
  exp: number; // Unix ms
  actorId?: string;
}

/**
 * Sign an edit session token.
 * Format: base64url(JSON payload).signature
 */
export function signEditToken(worktreeId: string, actorId?: string): string {
  const payload: TokenPayload = {
    worktreeId,
    exp: Date.now() + TOKEN_TTL_MS,
    ...(actorId ? { actorId } : {}),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', TOKEN_SECRET).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

/**
 * Verify an edit session token. Returns payload if valid, null otherwise.
 */
export function verifyEditToken(token: string, worktreeId: string): TokenPayload | null {
  const dot = token.indexOf('.');
  if (dot === -1) return null;

  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = createHmac('sha256', TOKEN_SECRET).update(payloadB64).digest('base64url');
  if (sig !== expected) return null;

  try {
    const payload: TokenPayload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    if (payload.worktreeId !== worktreeId) return null;
    return payload;
  } catch {
    return null;
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// Per-file mutex to serialize read-compare-write (single-process app)
const fileLocks = new Map<string, Promise<unknown>>();

function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(path) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run fn after previous settles (success or failure)
  fileLocks.set(path, next);
  // Clean up when chain settles (success or failure) to avoid unbounded growth
  const cleanup = () => {
    if (fileLocks.get(path) === next) fileLocks.delete(path);
  };
  next.then(cleanup, cleanup);
  return next;
}

export interface WriteResult {
  ok: true;
  newSha256: string;
  size: number;
}

export interface WriteConflict {
  ok: false;
  code: 'CONFLICT';
  currentSha256: string;
}

/**
 * Write file content with optimistic concurrency via sha256.
 * Uses per-file mutex to serialize read-compare-write.
 * Caller must resolve path and check security before calling this.
 */
export async function writeWorkspaceFile(
  resolvedPath: string,
  content: string,
  baseSha256: string,
): Promise<WriteResult | WriteConflict> {
  return withFileLock(resolvedPath, async () => {
    const current = await readFile(resolvedPath, 'utf-8');
    const currentHash = sha256(current);

    if (currentHash !== baseSha256) {
      return { ok: false, code: 'CONFLICT', currentSha256: currentHash };
    }

    await writeFile(resolvedPath, content, 'utf-8');
    const newHash = sha256(content);

    return { ok: true, newSha256: newHash, size: Buffer.byteLength(content) };
  });
}
