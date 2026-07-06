#!/usr/bin/env node
// Sync external skill directories into cat-cafe-skills/external/ via symlinks.
// This lets Clowder's SkillRouter discover skills from ~/.agents, ~/.claude,
// ~/.skillstar, ~/.pi, and OrbitOS without copying files.
// Native cat-cafe-skills are never mirrored: if an external source only holds a
// symlink back into the repo, it is skipped.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REPO_ROOT = resolve(__dirname, '..');
const EXTERNAL_DIR = resolve(REPO_ROOT, 'cat-cafe-skills', 'external');
const CAT_CAFE_SKILLS_DIR = resolve(REPO_ROOT, 'cat-cafe-skills');

function expandTilde(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return resolve(homedir(), value.slice(2));
  return value;
}

// Priority order: earlier sources win on name collisions.
// catcafe is listed first so native repo skills are never shadowed by external mirrors.
const SOURCES = [
  { name: 'catcafe', path: CAT_CAFE_SKILLS_DIR },
  { name: 'agents', path: expandTilde('~/.agents/skills') },
  { name: 'claude', path: expandTilde('~/.claude/skills') },
  { name: 'claude_gstack', path: expandTilde('~/.claude/skills/gstack') },
  { name: 'skillstar', path: expandTilde('~/.skillstar/hub/skills') },
  { name: 'pi', path: expandTilde('~/.pi/agent/skills') },
  { name: 'orbitos', path: expandTilde('~/Documents/03 life/AI design/OrbitOS-CN/04skill') },
];

function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function hasSkillMd(dirPath) {
  try {
    return statSync(resolve(dirPath, 'SKILL.md')).isFile();
  } catch {
    return false;
  }
}

function isInsideCatCafeSkills(dirPath) {
  const real = safeRealpath(dirPath);
  if (!real) return false;
  return real === CAT_CAFE_SKILLS_DIR || real.startsWith(`${CAT_CAFE_SKILLS_DIR}/`);
}

function* walkSkills(basePath, maxDepth = 2) {
  if (!existsSync(basePath)) return;
  const base = resolve(basePath);

  function* walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        if (hasSkillMd(fullPath)) {
          yield fullPath;
        } else if (entry.isDirectory()) {
          yield* walk(fullPath, depth + 1);
        }
      }
    }
  }

  yield* walk(base, 1);
}

function collectSkills() {
  const byName = new Map();

  for (const source of SOURCES) {
    const basePath = resolve(source.path);
    if (!existsSync(basePath)) {
      console.log(`skip missing source: ${source.name} -> ${basePath}`);
      continue;
    }

    let dirs;
    if (source.name === 'catcafe') {
      // cat-cafe-skills native entries are scanned only for collision exclusion.
      dirs = readdirSync(basePath, { withFileTypes: true })
        .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.'))
        .map((e) => resolve(basePath, e.name))
        .filter(hasSkillMd);
    } else {
      dirs = Array.from(walkSkills(basePath));
    }

    for (const dirPath of dirs) {
      const name = dirPath.split('/').pop();
      if (!name || byName.has(name)) continue;
      // Skip external entries that are just mirrors back into cat-cafe-skills.
      if (source.name !== 'catcafe' && isInsideCatCafeSkills(dirPath)) {
        continue;
      }
      byName.set(name, { source: source.name, path: resolve(dirPath) });
    }
  }

  return byName;
}

function syncExternalLinks(skillsByName) {
  if (!existsSync(EXTERNAL_DIR)) {
    mkdirSync(EXTERNAL_DIR, { recursive: true });
  }

  const existing = new Set(
    readdirSync(EXTERNAL_DIR, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.'))
      .map((e) => e.name),
  );

  let created = 0;
  let kept = 0;
  let removed = 0;

  for (const [name, info] of skillsByName) {
    if (info.source === 'catcafe') continue;
    const linkPath = resolve(EXTERNAL_DIR, name);
    if (existing.has(name)) {
      try {
        const currentTarget = resolve(readlinkSync(linkPath));
        if (currentTarget === info.path) {
          kept++;
          continue;
        }
        unlinkSync(linkPath);
      } catch {
        try {
          unlinkSync(linkPath);
        } catch {
          // ignore
        }
      }
    }
    symlinkSync(info.path, linkPath);
    created++;
  }

  for (const name of existing) {
    if (!skillsByName.has(name) || skillsByName.get(name).source === 'catcafe') {
      try {
        unlinkSync(resolve(EXTERNAL_DIR, name));
        removed++;
      } catch {
        // ignore
      }
    }
  }

  return { created, kept, removed, total: skillsByName.size };
}

const skillsByName = collectSkills();
const externalCount = Array.from(skillsByName.values()).filter((s) => s.source !== 'catcafe').length;
console.log(`Found ${skillsByName.size} unique skills (${externalCount} external).`);

const result = syncExternalLinks(skillsByName);
console.log(
  `external/ synced: ${result.created} created, ${result.kept} kept, ${result.removed} removed, ${result.total} total unique.`,
);
