#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const stableNodeBin = '/Users/cy/.uclaw/node/bin';
const stableNode = `${stableNodeBin}/node`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      PATH: `${stableNodeBin}:${process.env.PATH ?? ''}`,
      NODE: stableNode,
    },
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!existsSync(stableNode)) {
  console.error(`[native-rebuild] Stable Node not found: ${stableNode}`);
  process.exit(1);
}

console.log(`[native-rebuild] Using stable Node: ${stableNode}`);
run(stableNode, ['-e', 'console.log(`[native-rebuild] node ${process.version} modules=${process.versions.modules}`)']);
run('pnpm', ['rebuild', 'better-sqlite3']);
run(stableNode, ['packages/api/scripts/runtime-preflight.mjs']);
