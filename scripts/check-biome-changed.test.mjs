import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildBiomeArgs, filterBiomeCandidates, resolveDiffBase } from './check-biome-changed.mjs';

describe('CI changed-file Biome gate', () => {
  it('prefers the repository merge base over HEAD parent when the explicit SHA is all-zero', () => {
    const git = (args) => {
      const command = args.join(' ');
      if (command === 'rev-parse --abbrev-ref --symbolic-full-name @{upstream}') {
        return { status: 1, stdout: '' };
      }
      if (command === 'cat-file -e origin/HEAD^{commit}') return { status: 0, stdout: '' };
      if (command === 'merge-base HEAD origin/HEAD') return { status: 0, stdout: `${'a'.repeat(40)}\n` };
      return { status: 1, stdout: '' };
    };

    assert.equal(resolveDiffBase('0000000000000000000000000000000000000000', { git }), 'a'.repeat(40));
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
