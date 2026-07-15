// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const layoutPath = resolve(testDir, '..', '..', 'app', 'layout.tsx');

describe('chunk-load bootstrap layout ordering', () => {
  it('injects the versioned inline bootstrap before the hydrated guard', () => {
    const source = readFileSync(layoutPath, 'utf8');
    const bootstrapIndex = source.indexOf('id="clowder-chunk-recovery-bootstrap"');
    const guardIndex = source.indexOf('<ChunkLoadRefreshGuard />');

    expect(source).toContain('createChunkLoadBootstrapScript(CLIENT_WEB_BUILD_ID)');
    expect(bootstrapIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeGreaterThan(bootstrapIndex);
  });
});
