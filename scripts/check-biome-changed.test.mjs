import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildBiomeArgs, filterBiomeCandidates, resolveDiffBase } from './check-biome-changed.mjs';

describe('CI changed-file Biome gate', () => {
  it('falls back from an all-zero GitHub before SHA to HEAD parent', () => {
    const base = resolveDiffBase('0000000000000000000000000000000000000000');
    assert.match(base, /^[0-9a-f]{40}$/);
  });

  it('keeps project files while excluding external skill links and other symlinks', () => {
    const paths = [
      'packages/api/src/index.ts',
      'cat-cafe-skills/external/gstack',
      'packages/web/src/components/ChatInput.tsx',
      'linked-file.ts',
      'deleted-file.ts',
    ];
    const lstat = (absolutePath) => {
      if (absolutePath.endsWith('deleted-file.ts')) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      return { isSymbolicLink: () => absolutePath.endsWith('linked-file.ts') };
    };

    assert.deepEqual(filterBiomeCandidates(paths, { lstat }), [
      './packages/api/src/index.ts',
      './packages/web/src/components/ChatInput.tsx',
    ]);
  });

  it('lets a docs-only diff pass when every existing candidate is ignored by Biome', () => {
    assert.deepEqual(buildBiomeArgs(['./docs/features/F194-channel-task-thread-routing.md']), [
      'biome',
      'check',
      '--diagnostic-level=error',
      '--no-errors-on-unmatched',
      '--',
      './docs/features/F194-channel-task-thread-routing.md',
    ]);
  });
});
