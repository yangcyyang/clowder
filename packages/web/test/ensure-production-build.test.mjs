import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  latestBuildInput,
  missingProductionBuildFiles,
  productionBuildMarker,
  requiredProductionBuildFiles,
  resolveProductionDistDir,
  shouldAutobuild,
  staleProductionBuild,
} from '../scripts/ensure-production-build.mjs';

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cat-cafe-web-build-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeBuildArtifacts(root, distDir = '.next') {
  for (const file of requiredProductionBuildFiles(path.join(root, distDir))) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{}');
  }
}

async function touch(file, isoDate) {
  const date = new Date(isoDate);
  await utimes(file, date, date);
}

test('detects missing production build artifacts', async () => {
  await withTempDir(async (root) => {
    const missing = missingProductionBuildFiles(root).map((file) => path.relative(root, file));

    assert.deepEqual(missing, [
      path.join('.next', 'BUILD_ID'),
      path.join('.next', 'required-server-files.json'),
      path.join('.next', 'prerender-manifest.json'),
      path.join('.next', 'server', 'pages-manifest.json'),
    ]);
  });
});

test('passes when all production build artifacts exist', async () => {
  await withTempDir(async (root) => {
    await writeBuildArtifacts(root);

    assert.deepEqual(missingProductionBuildFiles(root), []);
  });
});

test('passes when production build is newer than source inputs', async () => {
  await withTempDir(async (root) => {
    const source = path.join(root, 'src', 'app', 'page.tsx');
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, 'export default function Page() { return null; }');
    await touch(source, '2026-01-01T00:00:00.000Z');

    await writeBuildArtifacts(root);
    for (const file of requiredProductionBuildFiles(path.join(root, '.next'))) {
      await touch(file, '2026-01-02T00:00:00.000Z');
    }

    assert.equal(path.relative(root, latestBuildInput(root).file), path.join('src', 'app', 'page.tsx'));
    assert.equal(path.relative(root, productionBuildMarker(root).file), path.join('.next', 'BUILD_ID'));
    assert.equal(staleProductionBuild(root), null);
  });
});

test('detects stale production build when source inputs are newer', async () => {
  await withTempDir(async (root) => {
    await writeBuildArtifacts(root);
    for (const file of requiredProductionBuildFiles(path.join(root, '.next'))) {
      await touch(file, '2026-01-01T00:00:00.000Z');
    }

    const source = path.join(root, 'src', 'components', 'DirectoryPickerModal.tsx');
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, 'export function DirectoryPickerModal() { return null; }');
    await touch(source, '2026-01-02T00:00:00.000Z');

    const stale = staleProductionBuild(root);
    assert.ok(stale);
    assert.equal(
      path.relative(root, stale.latestInput.file),
      path.join('src', 'components', 'DirectoryPickerModal.tsx'),
    );
    assert.equal(path.relative(root, stale.marker.file), path.join('.next', 'BUILD_ID'));
  });
});

test('uses explicit NEXT_DIST_DIR and defaults autobuild on', async () => {
  assert.equal(resolveProductionDistDir({ NEXT_DIST_DIR: '.next-smoke' }), '.next-smoke');
  assert.equal(resolveProductionDistDir({}), '.next');
  assert.equal(shouldAutobuild({}), true);
  assert.equal(shouldAutobuild({ CAT_CAFE_WEB_AUTOBUILD_ON_START: '0' }), false);
});
