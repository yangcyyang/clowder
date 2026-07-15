import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild-wasm';
import ts from 'typescript';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const automationFiles = ['scripts/verify-stale-build-recovery.mjs', 'test/stale-build-recovery-harness.test.mjs'];
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

function createFakeReloadWindow(effectOrder) {
  return {
    navigator: {
      serviceWorker: {
        getRegistrations: async () => [
          {
            update: async () => {
              effectOrder.push('service-worker-update');
            },
          },
        ],
      },
    },
    caches: {
      keys: async () => ['old-shell'],
      delete: async (key) => {
        effectOrder.push(`cache-delete:${key}`);
        return true;
      },
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
  const [{ createBuildRecoveryController }, { fetchServerBuildId }, recoveryModule] = await Promise.all([
    importFreshProductionModule('src/utils/build-recovery-controller.ts'),
    importFreshProductionModule('src/utils/web-build-version.ts'),
    importFreshProductionModule('src/utils/chunk-load-recovery.ts'),
  ]);

  const probeStatuses = [];
  const navigations = [];
  const announcements = [];
  const browserEffects = [];
  const fakeWindow = createFakeReloadWindow(browserEffects);
  const controller = createBuildRecoveryController({
    currentBuildId: fromBuildId,
    storage,
    hasUnsavedWork: () => recoveryModule.hasUnsavedUserWork(documentRef),
  });

  const fetchSameOrigin = async (input, init) => {
    const response = await fetch(new URL(String(input), origin), init);
    probeStatuses.push(response.status);
    return response;
  };

  const applyActions = async (actions) => {
    for (const action of actions) {
      if (action.type === 'announce') {
        announcements.push(action.buildId);
      } else if (action.type === 'reload') {
        await recoveryModule.prepareBrowserForReload(fakeWindow);
        browserEffects.push('navigation');
        navigations.push(action);
        onNavigate(action);
      }
    }
  };

  const evidence = () => {
    const snapshot = controller.snapshot();
    return {
      source: snapshot.source,
      fromBuildId: snapshot.currentBuildId,
      toBuildId: snapshot.targetBuildId,
      probeStatuses: [...probeStatuses],
      navigationCount: navigations.length,
      draftProtected: snapshot.pendingRequest !== null,
      loopPrevented: snapshot.loopPrevented,
    };
  };

  return {
    async probe() {
      if (!controller.canProbe()) return evidence();
      const serverBuildId = await fetchServerBuildId(fetchSameOrigin);
      await applyActions(controller.handleProbeResult(serverBuildId));
      return evidence();
    },
    async clickPromptAction() {
      await applyActions(controller.manualPromptAction());
      return evidence();
    },
    attention() {
      controller.resetProbeFailures();
    },
    evidence,
    announcements,
    browserEffects,
    navigations,
  };
}

export function emitRecoveryEvidence(value, stream = process.stdout) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function staticString(node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(node.left);
    const right = staticString(node.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

function reloadOwner(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return null;
}

function reloadCallFinding(node, sourceFile, fileName) {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  let owner = null;
  let property = null;
  if (ts.isPropertyAccessExpression(callee)) {
    owner = reloadOwner(callee.expression);
    property = callee.name.text;
  } else if (ts.isElementAccessExpression(callee)) {
    owner = reloadOwner(callee.expression);
    property = callee.argumentExpression ? staticString(callee.argumentExpression) : null;
  }
  if ((owner !== 'page' && owner !== 'location') || property !== 'reload') return null;
  return `${fileName}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}:reload-call`;
}

function shortcutFinding(node, sourceFile, fileName) {
  const value = staticString(node);
  if (!value || !/^(?:cmd|meta)\s*\+\s*shift\s*\+\s*r$/i.test(value)) return null;
  return `${fileName}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}:hard-refresh-shortcut`;
}

export function scanAutomationSource(source, fileName) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const findings = [];

  const visit = (node) => {
    const reloadFinding = reloadCallFinding(node, sourceFile, fileName);
    if (reloadFinding) findings.push(reloadFinding);
    const hardRefreshFinding = shortcutFinding(node, sourceFile, fileName);
    if (hardRefreshFinding) findings.push(hardRefreshFinding);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...new Set(findings)];
}

export async function scanAutomationEscapeHatches() {
  const findings = [];
  for (const relativePath of automationFiles) {
    const source = await readFile(path.join(webRoot, relativePath), 'utf8');
    findings.push(...scanAutomationSource(source, relativePath));
  }
  return findings;
}

export async function readHarnessSource(options = {}) {
  if (!options.includeContents) return [...automationFiles];
  return Promise.all(automationFiles.map((relativePath) => readFile(path.join(webRoot, relativePath), 'utf8')));
}
