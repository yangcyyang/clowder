/**
 * F070: Governance Registry — dispatch audit trail
 *
 * Tracks which external projects have been bootstrapped,
 * their governance pack versions, and sync timestamps.
 * Stored at `.cat-cafe/governance-registry.json` in the Cat Cafe root.
 *
 * A3 (batch 4-A) — query resilience hardening. Real incident: a project
 * ("designe agent") confirmed via POST /api/governance/confirm was later
 * reported `needs_bootstrap` by checkGovernancePreflight() even though
 * `.get()` should have found it. Two independently reproducible root causes
 * fixed here (see test/governance/governance-registry.test.js for red→green
 * evidence):
 *
 * 1. `register()` did an unguarded read-modify-write on the single JSON file.
 *    Two overlapping `register()` calls (governance/confirm is fire-and-forget
 *    per request — registering several projects within the same minute is a
 *    realistic production shape) race: whichever call's write() lands last
 *    wins with whatever `data` IT read at ITS OWN start, silently erasing any
 *    entry a concurrent call had already written. Fixed with an in-process
 *    serial write queue — a single Node process owns this file, so that is
 *    sufficient; cross-process writers are not a concern for this data root.
 * 2. `read()` swallowed EVERY readFile failure (ENOENT — ordinary "no
 *    registry file yet" — indistinguishable from EPERM/EACCES — "the file
 *    exists but I can't read it right now") into the same empty
 *    `{entries: []}`. A transient permission failure on the registry file
 *    itself was therefore indistinguishable from "nothing has ever been
 *    registered", which is exactly the wrong message checkGovernancePreflight()
 *    surfaces ("Governance not bootstrapped ... Use POST /api/governance/confirm
 *    to bootstrap") when actually the project WAS confirmed and the platform
 *    just could not read the proof. Fixed: ENOENT still means "empty registry"
 *    (unchanged), any other read error now propagates so callers can report
 *    "cannot verify" rather than "not registered" — invoke-single-cat.ts's
 *    existing fail-open try/catch around `checkGovernancePreflight` (added for
 *    the 2026-07-25 incident) already treats a thrown filesystem-permission
 *    error correctly with zero changes needed there.
 *
 * Additionally, key comparison is now normalized with a pure string operation
 * (trailing separator + Unicode NFC) — no realtime fs/realpath call — so a
 * project registered via one path spelling (e.g. with a trailing slash) is
 * still found when dispatch queries with a differently-spelled but equal path.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import type { GovernanceHealthSummary, GovernancePackMeta } from '@cat-cafe/shared';
import { pathsEqual } from '../../utils/project-path.js';
import { GOVERNANCE_PACK_VERSION } from './governance-pack.js';

const REGISTRY_DIR = '.cat-cafe';
const REGISTRY_FILENAME = 'governance-registry.json';

interface RegistryEntry extends GovernancePackMeta {
  /** Absolute path to the external project */
  projectPath: string;
}

interface RegistryData {
  entries: RegistryEntry[];
}

function safePath(root: string, ...segments: string[]): string {
  const rootResolved = resolve(root);
  const normalized = resolve(rootResolved, ...segments);
  const rel = relative(rootResolved, normalized);
  if (rel.startsWith(`..${sep}`) || rel === '..') {
    throw new Error(`Path escapes project root: ${normalized}`);
  }
  return normalized;
}

/**
 * A3: pure string normalization for registry key comparison — deliberately no
 * fs/realpath call (a live filesystem read can fail transiently under macOS
 * TCC, which must never be the reason a confirmed project looks unregistered).
 * Strips exactly one trailing path separator so '/a/b' and '/a/b/' compare
 * equal, and applies Unicode NFC so differently-composed (NFC vs NFD) but
 * visually-identical path spellings — a real macOS filesystem quirk for
 * accented/decomposable characters — also compare equal.
 */
function normalizeRegistryKey(projectPath: string): string {
  const trimmed =
    projectPath.length > 1 && (projectPath.endsWith('/') || projectPath.endsWith('\\'))
      ? projectPath.slice(0, -1)
      : projectPath;
  return trimmed.normalize('NFC');
}

function isEnoentError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

export class GovernanceRegistry {
  constructor(private readonly catCafeRoot: string) {}

  /**
   * A3: serializes register() calls in-process. A single Node process owns
   * this data root, so a promise-chain mutex is sufficient to close the
   * read-modify-write race — see module doc. Chained with `.catch(() => {})`
   * so one failed registration never permanently wedges later ones; callers
   * still observe their own call's real outcome via the returned/awaited task.
   */
  private writeQueue: Promise<unknown> = Promise.resolve();

  private get filePath(): string {
    return safePath(this.catCafeRoot, REGISTRY_DIR, REGISTRY_FILENAME);
  }

  /**
   * A3: ENOENT (no registry file yet — first-ever use) still means "empty
   * registry", same as before. Any OTHER read failure (EPERM/EACCES, a
   * transient TCC denial, or any unexpected fs error) now propagates instead
   * of being silently reported as "empty" — callers must not confuse "cannot
   * read the proof" with "never registered". Corrupt JSON content (file
   * readable, parse fails) is a different failure class and still falls back
   * to empty — the file is rewritten wholesale on the next successful
   * register(), and this fix's scope is specifically the EPERM/EACCES
   * ambiguity called out in the batch spec.
   */
  async read(): Promise<RegistryData> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf-8');
    } catch (err) {
      if (isEnoentError(err)) return { entries: [] };
      throw err;
    }
    try {
      const data = JSON.parse(raw) as RegistryData;
      if (!Array.isArray(data.entries)) return { entries: [] };
      return data;
    } catch {
      return { entries: [] };
    }
  }

  private async write(data: RegistryData): Promise<void> {
    const dir = safePath(this.catCafeRoot, REGISTRY_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  }

  async register(projectPath: string, meta: GovernancePackMeta): Promise<void> {
    const normalizedPath = normalizeRegistryKey(projectPath);
    const task = this.writeQueue.then(async () => {
      const data = await this.read();
      const existing = data.entries.findIndex((e) => pathsEqual(normalizeRegistryKey(e.projectPath), normalizedPath));
      const entry: RegistryEntry = { ...meta, projectPath: normalizedPath };
      if (existing >= 0) {
        data.entries[existing] = entry;
      } else {
        data.entries.push(entry);
      }
      await this.write(data);
    });
    // Keep the queue alive even if this registration fails — a bad write must
    // not wedge every future registration behind it.
    this.writeQueue = task.catch(() => {});
    return task;
  }

  async get(projectPath: string): Promise<RegistryEntry | undefined> {
    const normalizedPath = normalizeRegistryKey(projectPath);
    const data = await this.read();
    return data.entries.find((e) => pathsEqual(normalizeRegistryKey(e.projectPath), normalizedPath));
  }

  async listAll(): Promise<readonly RegistryEntry[]> {
    const data = await this.read();
    return data.entries;
  }

  async checkHealth(projectPath: string, currentVersion?: string): Promise<GovernanceHealthSummary> {
    const version = currentVersion ?? GOVERNANCE_PACK_VERSION;
    const entry = await this.get(projectPath);
    if (!entry) {
      return {
        projectPath,
        status: 'never-synced',
        packVersion: null,
        lastSyncedAt: null,
        findings: [],
      };
    }
    const status = entry.packVersion === version ? 'healthy' : 'stale';
    return {
      projectPath,
      status,
      packVersion: entry.packVersion,
      lastSyncedAt: entry.syncedAt,
      findings: [],
    };
  }
}
