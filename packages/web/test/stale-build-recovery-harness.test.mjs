import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';

import {
  createProductRecoveryHarness,
  createTextDraftDocument,
  emitRecoveryEvidence,
  readHarnessSource,
  scanAutomationEscapeHatches,
  scanAutomationSource,
} from '../scripts/verify-stale-build-recovery.mjs';

let fixture;
let origin;
const fixtureRequests = [];
const fixtureState = { buildId: 'build-a', status: 200 };

before(async () => {
  fixture = createServer((request, response) => {
    fixtureRequests.push({ url: request.url, accept: request.headers.accept });
    if (request.url !== '/_clowder/build-id') {
      response.writeHead(404).end();
      return;
    }
    response.setHeader('cache-control', 'no-store, max-age=0');
    response.setHeader('content-type', 'application/json');
    response.writeHead(fixtureState.status);
    response.end(JSON.stringify({ buildId: fixtureState.buildId }));
  });
  await new Promise((resolve, reject) => {
    fixture.once('error', reject);
    fixture.listen(0, '127.0.0.1', resolve);
  });
  const address = fixture.address();
  assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) => fixture.close((error) => (error ? reject(error) : resolve())));
});

test('A to B performs one product-originated navigation and prevents a same-target loop', async () => {
  fixtureState.buildId = 'build-a';
  fixtureState.status = 200;
  fixtureRequests.length = 0;
  const navigations = [];
  const harness = await createProductRecoveryHarness({
    origin,
    fromBuildId: 'build-a',
    onNavigate: (navigation) => navigations.push(navigation),
  });

  const matchingEvidence = await harness.probe();
  assert.equal(matchingEvidence.navigationCount, 0);
  fixtureState.buildId = 'build-b';
  await harness.probe();
  const evidence = await harness.probe();

  assert.equal(evidence.source, 'product-recovery');
  assert.equal(evidence.fromBuildId, 'build-a');
  assert.equal(evidence.toBuildId, 'build-b');
  assert.deepEqual(evidence.probeStatuses, [200, 200]);
  assert.equal(evidence.navigationCount, 1);
  assert.equal(evidence.draftProtected, false);
  assert.equal(evidence.loopPrevented, true);
  assert.deepEqual(navigations, [
    {
      type: 'reload',
      source: 'product-recovery',
      fromBuildId: 'build-a',
      toBuildId: 'build-b',
      trigger: 'automatic',
    },
  ]);
  assert.deepEqual(harness.announcements, ['build-b']);
  assert.deepEqual(harness.browserEffects, ['service-worker-update', 'cache-delete:old-shell', 'navigation']);
  assert.equal(fixtureRequests.length, 2);
  assert.ok(fixtureRequests.every((request) => request.accept === 'application/json'));
  emitRecoveryEvidence(evidence);
});

test('three 503 probes fail closed without navigation', async () => {
  fixtureState.buildId = 'build-b';
  fixtureState.status = 200;
  fixtureRequests.length = 0;
  const harness = await createProductRecoveryHarness({ origin, fromBuildId: 'build-b' });

  await harness.probe();
  fixtureState.status = 503;
  await harness.probe();
  await harness.probe();
  await harness.probe();
  const evidence = await harness.probe();

  assert.deepEqual(evidence, {
    source: 'product-recovery',
    fromBuildId: 'build-b',
    toBuildId: null,
    probeStatuses: [200, 503, 503, 503],
    navigationCount: 0,
    draftProtected: false,
    loopPrevented: false,
  });
  assert.equal(fixtureRequests.length, 4, 'the capped fourth failure must not issue HTTP');

  harness.attention();
  const retriedEvidence = await harness.probe();
  assert.deepEqual(retriedEvidence.probeStatuses, [200, 503, 503, 503, 503]);
  assert.equal(fixtureRequests.length, 5, 'attention resets the cap and permits one new probe');
  emitRecoveryEvidence(evidence);
});

test('B to C preserves a text draft until the product prompt action is clicked', async () => {
  fixtureState.buildId = 'build-b';
  fixtureState.status = 200;
  const navigations = [];
  const harness = await createProductRecoveryHarness({
    origin,
    fromBuildId: 'build-b',
    documentRef: createTextDraftDocument('未发送草稿'),
    onNavigate: (navigation) => navigations.push(navigation),
  });

  await harness.probe();
  fixtureState.buildId = 'build-c';
  const protectedEvidence = await harness.probe();
  assert.equal(protectedEvidence.navigationCount, 0);
  assert.equal(protectedEvidence.draftProtected, true);

  await harness.clickPromptAction();
  const evidence = await harness.clickPromptAction();
  assert.equal(evidence.navigationCount, 1);
  assert.equal(evidence.loopPrevented, true);
  assert.deepEqual(navigations, [
    {
      type: 'reload',
      source: 'product-recovery',
      fromBuildId: 'build-b',
      toBuildId: 'build-c',
      trigger: 'manual',
    },
  ]);
  assert.deepEqual(harness.announcements, ['build-c']);
  assert.deepEqual(harness.browserEffects, ['service-worker-update', 'cache-delete:old-shell', 'navigation']);
  emitRecoveryEvidence(evidence);
});

test('harness contains no automation-side hard-refresh escape hatch', async () => {
  const scannedFiles = await readHarnessSource();
  assert.deepEqual(scannedFiles.sort(), [
    'scripts/verify-stale-build-recovery.mjs',
    'test/stale-build-recovery-harness.test.mjs',
  ]);
  assert.deepEqual(await scanAutomationEscapeHatches(), []);
});

test('escape scanner rejects direct, optional, computed reloads and hard-refresh shortcuts', () => {
  const member = (owner, operator, property) => `${owner}${operator}${property}()`;
  const computed = (owner, property) => `${owner}[${JSON.stringify(property)}]()`;
  const optionalComputed = (owner, property) => `${owner}?.[${JSON.stringify(property)}]()`;
  const shortcut = (...parts) => JSON.stringify(parts.join('+'));
  const forbiddenSources = [
    member('page', '.', 'reload'),
    member('page', '?.', 'reload'),
    computed('page', 'reload'),
    optionalComputed('page', 'reload'),
    member('location', '.', 'reload'),
    member('location', '?.', 'reload'),
    computed('location', 'reload'),
    optionalComputed('location', 'reload'),
    shortcut('Cmd', 'Shift', 'R'),
    shortcut('Meta', 'Shift', 'R'),
  ];

  for (const source of forbiddenSources) {
    assert.notDeepEqual(scanAutomationSource(source, 'negative-fixture.mjs'), [], source);
  }
});

test('harness delegates recovery decisions to the production controller', async () => {
  const [automationSource] = await readHarnessSource({ includeContents: true });
  assert.match(automationSource, /createBuildRecoveryController/);
  assert.match(automationSource, /controller\.handleProbeResult/);
  assert.match(automationSource, /controller\.manualPromptAction/);
  assert.doesNotMatch(automationSource, /reserveAutomaticRecovery/);
});

test('deterministic recovery harness is wired into standard package and GitHub CI gates', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const workflow = await readFile(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');

  assert.match(packageJson.scripts['test:ci'], /test:ci:recovery/);
  assert.equal(packageJson.scripts['test:ci:recovery'], 'pnpm run test:stale-build-recovery');
  assert.match(workflow, /@cat-cafe\/web run test:ci:recovery/);
});
