// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(testDir, '..', '..', '..');
const appDir = resolve(webRoot, 'src', 'app');

function lineCount(filePath: string): number {
  return readFileSync(filePath, 'utf8').trimEnd().split('\n').length;
}

// Budgets are rounded above the post-F190 split baseline (350/887/1513/164).
// Keep the entrypoint thin while preventing each specialized layer from growing
// unnoticed beyond its current architectural responsibility.
const LINE_BUDGETS = {
  'globals.css': 350,
  'theme-tokens.css': 900,
  'console-shell.css': 1525,
  'console-controls.css': 200,
} as const;

describe('global css architecture', () => {
  it('keeps each global css layer within its architecture budget', () => {
    for (const [file, budget] of Object.entries(LINE_BUDGETS)) {
      expect(lineCount(resolve(appDir, file)), `${file} exceeds its ${budget}-line budget`).toBeLessThanOrEqual(budget);
    }
  });

  it('loads split global css files from the root layout', () => {
    const layoutSource = readFileSync(resolve(appDir, 'layout.tsx'), 'utf8');

    expect(layoutSource).toContain("import './theme-tokens.css';");
    expect(layoutSource).toContain("import './globals.css';");
    expect(layoutSource).toContain("import './console-shell.css';");
    expect(layoutSource).toContain("import './console-controls.css';");
  });
});
