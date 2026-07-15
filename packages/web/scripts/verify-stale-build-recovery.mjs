import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild-wasm';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compiledModules = new Map();
let moduleSequence = 0;

async function compileProductionModule(relativePath) {
  let compiled = compiledModules.get(relativePath);
  if (!compiled) {
    const result = await esbuild.build({
      absWorkingDir: webRoot,
      bundle: true,
      entryPoints: [relativePath],
      format: 'esm',
      platform: 'node',
      target: 'node20',
      tsconfig: 'tsconfig.json',
      write: false,
    });
    compiled = result.outputFiles[0].text;
    compiledModules.set(relativePath, compiled);
  }
  return compiled;
}

async function importFreshProductionModule(relativePath) {
  const source = await compileProductionModule(relativePath);
  const encoded = Buffer.from(source).toString('base64');
  moduleSequence += 1;
  return import(`data:text/javascript;base64,${encoded}#product-${moduleSequence}`);
}

export function createMemorySessionStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

export function createTextDraftDocument(value = '') {
  return {
    querySelectorAll(selector) {
      if (selector !== 'textarea:not(:disabled)' || value.length === 0) return [];
      return [{ value }];
    },
  };
}

export async function createProductRecoveryHarness({
  origin,
  fromBuildId,
  documentRef = createTextDraftDocument(),
  storage = createMemorySessionStorage(),
  onNavigate = () => {},
}) {
  const [{ fetchServerBuildId }, { hasUnsavedUserWork, reserveAutomaticRecovery }] = await Promise.all([
    importFreshProductionModule('src/utils/web-build-version.ts'),
    importFreshProductionModule('src/utils/chunk-load-recovery.ts'),
  ]);

  const probeStatuses = [];
  let navigationCount = 0;
  let draftProtected = false;
  let loopPrevented = false;
  let pendingTarget = null;
  let toBuildId = null;

  const fetchSameOrigin = async (input, init) => {
    const response = await fetch(new URL(String(input), origin), init);
    probeStatuses.push(response.status);
    return response;
  };

  const navigateTo = (targetBuildId) => {
    if (!reserveAutomaticRecovery(storage, targetBuildId)) {
      loopPrevented = true;
      return false;
    }
    navigationCount += 1;
    onNavigate({ source: 'product-recovery', fromBuildId, toBuildId: targetBuildId });
    return true;
  };

  const evidence = () => ({
    source: 'product-recovery',
    fromBuildId,
    toBuildId,
    probeStatuses: [...probeStatuses],
    navigationCount,
    draftProtected,
    loopPrevented,
  });

  return {
    async probe() {
      const serverBuildId = await fetchServerBuildId(fetchSameOrigin);
      if (!serverBuildId) return evidence();
      toBuildId = serverBuildId;
      if (serverBuildId === fromBuildId) return evidence();
      if (hasUnsavedUserWork(documentRef)) {
        draftProtected = true;
        pendingTarget = serverBuildId;
        return evidence();
      }
      navigateTo(serverBuildId);
      return evidence();
    },
    clickPromptAction() {
      if (!pendingTarget) return evidence();
      navigateTo(pendingTarget);
      return evidence();
    },
    evidence,
  };
}

export function emitRecoveryEvidence(value, stream = process.stdout) {
  stream.write(`${JSON.stringify(value)}\n`);
}

export async function readHarnessSource() {
  return readFile(fileURLToPath(import.meta.url), 'utf8');
}
