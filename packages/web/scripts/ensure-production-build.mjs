#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BUILD_INPUTS = [
  'src',
  'worker',
  'next.config.js',
  'package.json',
  'postcss.config.js',
  'tailwind.config.js',
  'tsconfig.json',
];

const REQUIRED_FILES = [
  'BUILD_ID',
  'required-server-files.json',
  'prerender-manifest.json',
  path.join('server', 'pages-manifest.json'),
];

export function resolveProductionDistDir(env = process.env) {
  return env.NEXT_DIST_DIR?.trim() || '.next';
}

export function requiredProductionBuildFiles(distDir) {
  return REQUIRED_FILES.map((file) => path.join(distDir, file));
}

export function missingProductionBuildFiles(cwd = process.cwd(), env = process.env) {
  const distDir = path.resolve(cwd, resolveProductionDistDir(env));
  return requiredProductionBuildFiles(distDir).filter((file) => !existsSync(file));
}

function latestMtimeInPath(targetPath) {
  if (!existsSync(targetPath)) return null;

  const stat = statSync(targetPath);
  if (!stat.isDirectory()) {
    return { file: targetPath, mtimeMs: stat.mtimeMs };
  }

  let latest = null;
  for (const entry of readdirSync(targetPath)) {
    const child = latestMtimeInPath(path.join(targetPath, entry));
    if (child && (!latest || child.mtimeMs > latest.mtimeMs)) {
      latest = child;
    }
  }
  return latest;
}

export function latestBuildInput(cwd = process.cwd(), inputPaths = BUILD_INPUTS) {
  let latest = null;
  for (const inputPath of inputPaths) {
    const input = latestMtimeInPath(path.resolve(cwd, inputPath));
    if (input && (!latest || input.mtimeMs > latest.mtimeMs)) {
      latest = input;
    }
  }
  return latest;
}

export function productionBuildMarker(cwd = process.cwd(), env = process.env) {
  const marker = path.resolve(cwd, resolveProductionDistDir(env), 'BUILD_ID');
  if (!existsSync(marker)) return null;
  const stat = statSync(marker);
  return { file: marker, mtimeMs: stat.mtimeMs };
}

export function staleProductionBuild(cwd = process.cwd(), env = process.env) {
  const marker = productionBuildMarker(cwd, env);
  if (!marker) return null;

  const latestInput = latestBuildInput(cwd);
  if (!latestInput || latestInput.mtimeMs <= marker.mtimeMs) return null;

  return {
    marker,
    latestInput,
  };
}

function runBuild(cwd, env) {
  const pnpm = env.PNPM || 'pnpm';
  const result = spawnSync(pnpm, ['run', 'build'], {
    cwd,
    env,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`pnpm run build failed with exit code ${result.status}`);
  }
}

export function shouldAutobuild(env = process.env) {
  return env.CAT_CAFE_WEB_AUTOBUILD_ON_START !== '0';
}

async function main() {
  const cwd = process.cwd();
  const firstMissing = missingProductionBuildFiles(cwd);
  const firstStale = firstMissing.length === 0 ? staleProductionBuild(cwd) : null;
  if (firstMissing.length === 0 && !firstStale) {
    console.log('[web-prestart] production build artifacts are present and fresh');
    return;
  }

  if (firstMissing.length > 0) {
    console.warn(
      [
        '[web-prestart] production build artifacts are incomplete:',
        ...firstMissing.map((file) => `  - ${path.relative(cwd, file)}`),
      ].join('\n'),
    );
  }

  if (firstStale) {
    console.warn(
      [
        '[web-prestart] production build artifacts are stale:',
        `  - ${path.relative(cwd, firstStale.latestInput.file)} is newer than ${path.relative(cwd, firstStale.marker.file)}`,
      ].join('\n'),
    );
  }

  if (!shouldAutobuild()) {
    throw new Error('Production build is missing or stale. Run `pnpm --dir packages/web run build` before start.');
  }

  console.warn('[web-prestart] running `pnpm run build` before next start');
  runBuild(cwd, process.env);

  const secondMissing = missingProductionBuildFiles(cwd);
  if (secondMissing.length > 0) {
    throw new Error(
      [
        'Production build is still incomplete after `pnpm run build`:',
        ...secondMissing.map((file) => `  - ${path.relative(cwd, file)}`),
      ].join('\n'),
    );
  }

  const secondStale = staleProductionBuild(cwd);
  if (secondStale) {
    throw new Error(
      [
        'Production build is still stale after `pnpm run build`:',
        `  - ${path.relative(cwd, secondStale.latestInput.file)} is newer than ${path.relative(cwd, secondStale.marker.file)}`,
      ].join('\n'),
    );
  }

  console.log('[web-prestart] production build repaired');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[web-prestart] ${error.message}`);
    process.exit(1);
  });
}
