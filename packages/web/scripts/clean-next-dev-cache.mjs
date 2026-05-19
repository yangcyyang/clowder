import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const paths = ['.next-dev', 'tsconfig.tsbuildinfo'];

for (const relativePath of paths) {
  const target = resolve(process.cwd(), relativePath);
  rmSync(target, { force: true, recursive: true });
}

console.log('[clean-next-dev-cache] removed .next-dev and tsconfig.tsbuildinfo');
