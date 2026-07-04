import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { resolveCollectionAutoRebuildIntervalMs } from './CollectionAutoRebuildScheduler.js';
import type { CollectionManifest } from './collection-types.js';
import { validateCollectionId, validateManifestInput } from './collection-types.js';

const DEFAULT_KIND = 'domain';
const DEFAULT_SENSITIVITY = 'internal';
const DEFAULT_EXCLUDE = ['.obsidian/**'];

export function loadObsidianReadonlyCollections(raw: string | undefined, now = new Date().toISOString()) {
  if (!raw?.trim()) return [];

  const manifests: CollectionManifest[] = [];
  const usedIds = new Set<string>();

  for (const entry of raw
    .split(/[,\n]+/)
    .map((value) => value.trim())
    .filter(Boolean)) {
    const parsed = parseRootEntry(entry);
    const root = normalizeRoot(parsed.root);
    if (!isExistingDirectory(root)) continue;

    const id = parsed.id ?? allocateId(root, usedIds);
    try {
      validateCollectionId(id);
      validateManifestInput({
        id,
        kind: DEFAULT_KIND,
        sensitivity: DEFAULT_SENSITIVITY,
        scannerLevel: 'auto',
        root,
      });
    } catch {
      continue;
    }

    usedIds.add(id);
    const name = id.split(':')[1] ?? 'obsidian-knowledge';
    manifests.push({
      id,
      kind: DEFAULT_KIND,
      name,
      displayName: `${basename(root) || name} (Obsidian Read-only)`,
      root,
      sensitivity: DEFAULT_SENSITIVITY,
      scannerLevel: 'auto',
      indexPolicy: {
        autoRebuild: true,
        rebuildIntervalMs: resolveCollectionAutoRebuildIntervalMs(
          process.env.CAT_CAFE_COLLECTION_AUTO_REBUILD_INTERVAL_MS,
        ),
      },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: true },
      readOnly: true,
      exclude: DEFAULT_EXCLUDE,
      createdAt: now,
      updatedAt: now,
    });
  }

  return manifests;
}

function parseRootEntry(entry: string): { id?: string; root: string } {
  const eq = entry.indexOf('=');
  if (eq <= 0) return { root: stripQuotes(entry) };

  const maybeId = entry.slice(0, eq).trim();
  const root = stripQuotes(entry.slice(eq + 1).trim());
  try {
    validateCollectionId(maybeId);
    return { id: maybeId, root };
  } catch {
    return { root: stripQuotes(entry) };
  }
}

function normalizeRoot(root: string): string {
  const expanded = root === '~' ? homedir() : root.startsWith('~/') ? `${homedir()}${root.slice(1)}` : root;
  return resolve(expanded);
}

function isExistingDirectory(root: string): boolean {
  try {
    return statSync(root, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return false;
  }
}

function allocateId(root: string, usedIds: Set<string>): string {
  const base = toAsciiSlug(basename(root));
  const name = /^[a-z]/.test(base) ? base : `obsidian-${base || 'knowledge'}`;
  let id = `${DEFAULT_KIND}:${name}`;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${DEFAULT_KIND}:${name}-${suffix}`;
    suffix++;
  }
  return id;
}

function toAsciiSlug(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
