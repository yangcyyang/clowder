import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';

import {
  createProductRecoveryHarness,
  createTextDraftDocument,
  emitRecoveryEvidence,
  readHarnessSource,
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
  fixtureState.buildId = 'build-b';
  fixtureState.status = 200;
  fixtureRequests.length = 0;
  const navigations = [];
  const harness = await createProductRecoveryHarness({
    origin,
    fromBuildId: 'build-a',
    onNavigate: (navigation) => navigations.push(navigation),
  });

  await harness.probe();
  const evidence = await harness.probe();

  assert.equal(evidence.source, 'product-recovery');
  assert.equal(evidence.fromBuildId, 'build-a');
  assert.equal(evidence.toBuildId, 'build-b');
  assert.deepEqual(evidence.probeStatuses, [200, 200]);
  assert.equal(evidence.navigationCount, 1);
  assert.equal(evidence.draftProtected, false);
  assert.equal(evidence.loopPrevented, true);
  assert.deepEqual(navigations, [{ source: 'product-recovery', fromBuildId: 'build-a', toBuildId: 'build-b' }]);
  assert.equal(fixtureRequests.length, 2);
  assert.ok(fixtureRequests.every((request) => request.accept === 'application/json'));
  emitRecoveryEvidence(evidence);
});

test('three 503 probes fail closed without navigation', async () => {
  fixtureState.buildId = 'build-b';
  fixtureState.status = 503;
  const harness = await createProductRecoveryHarness({ origin, fromBuildId: 'build-b' });

  await harness.probe();
  await harness.probe();
  const evidence = await harness.probe();

  assert.deepEqual(evidence, {
    source: 'product-recovery',
    fromBuildId: 'build-b',
    toBuildId: null,
    probeStatuses: [503, 503, 503],
    navigationCount: 0,
    draftProtected: false,
    loopPrevented: false,
  });
  emitRecoveryEvidence(evidence);
});

test('B to C preserves a text draft until the product prompt action is clicked', async () => {
  fixtureState.buildId = 'build-c';
  fixtureState.status = 200;
  const navigations = [];
  const harness = await createProductRecoveryHarness({
    origin,
    fromBuildId: 'build-b',
    documentRef: createTextDraftDocument('未发送草稿'),
    onNavigate: (navigation) => navigations.push(navigation),
  });

  const protectedEvidence = await harness.probe();
  assert.equal(protectedEvidence.navigationCount, 0);
  assert.equal(protectedEvidence.draftProtected, true);

  harness.clickPromptAction();
  const evidence = harness.clickPromptAction();
  assert.equal(evidence.navigationCount, 1);
  assert.equal(evidence.loopPrevented, true);
  assert.deepEqual(navigations, [{ source: 'product-recovery', fromBuildId: 'build-b', toBuildId: 'build-c' }]);
  emitRecoveryEvidence(evidence);
});

test('harness contains no automation-side hard-refresh escape hatch', async () => {
  const source = await readHarnessSource();
  const forbidden = ['page' + '.reload', 'Cmd+' + 'Shift+R', 'Meta+' + 'Shift+R', 'location' + '.reload'];
  for (const token of forbidden) assert.equal(source.includes(token), false, token);
});
