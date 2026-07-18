#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ZERO_SHA_RE = /^0+$/;
const EXTERNAL_SKILL_PREFIX = 'cat-cafe-skills/external/';

function runGit(args, options = {}) {
  return spawnSync('git', args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: 'utf8',
    ...options,
  });
}

export function resolveDiffBase(candidate, { cwd = process.cwd() } = {}) {
  if (candidate && !ZERO_SHA_RE.test(candidate)) {
    const probe = runGit(['cat-file', '-e', `${candidate}^{commit}`], { cwd });
    if (probe.status === 0) return candidate;
  }

  const parentProbe = runGit(['rev-parse', '--verify', 'HEAD^'], { cwd });
  if (parentProbe.status !== 0) {
    throw new Error('cannot resolve CI diff base; fetch history or provide CI_BASE_SHA');
  }
  return parentProbe.stdout.trim();
}

export function filterBiomeCandidates(paths, { cwd = process.cwd(), lstat = lstatSync } = {}) {
  const selected = [];
  for (const path of paths) {
    if (!path || path.startsWith(EXTERNAL_SKILL_PREFIX)) continue;
    try {
      if (lstat(resolve(cwd, path)).isSymbolicLink()) continue;
      selected.push(`./${path}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return selected;
}

export function listChangedFiles(base, { cwd = process.cwd() } = {}) {
  const diff = runGit(['diff', '--name-only', '--diff-filter=ACMR', '-z', base, 'HEAD'], { cwd });
  if (diff.status !== 0) {
    throw new Error(`git diff failed for ${base}..HEAD: ${diff.stderr.trim()}`);
  }
  return diff.stdout.split('\0').filter(Boolean);
}

export function buildBiomeArgs(candidates) {
  return ['biome', 'check', '--diagnostic-level=error', '--no-errors-on-unmatched', '--', ...candidates];
}

export function runChangedBiome({ cwd = process.cwd(), baseCandidate = process.env.CI_BASE_SHA } = {}) {
  const base = resolveDiffBase(baseCandidate, { cwd });
  const changed = listChangedFiles(base, { cwd });
  const candidates = filterBiomeCandidates(changed, { cwd });

  process.stdout.write(`[ci-biome] base=${base} changed=${changed.length} candidates=${candidates.length}\n`);
  if (candidates.length === 0) {
    process.stdout.write('[ci-biome] no project-owned changed files require Biome\n');
    return 0;
  }

  const result = spawnSync('pnpm', buildBiomeArgs(candidates), {
    cwd,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    process.exitCode = runChangedBiome();
  } catch (error) {
    process.stderr.write(`[ci-biome] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
