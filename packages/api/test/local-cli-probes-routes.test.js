import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

const makeProbe = (modelId) => ({
  id: 'codex',
  label: 'Codex',
  command: 'codex',
  clientId: 'openai',
  defaultModel: modelId,
  models: [{ id: modelId, source: 'config', isDefault: true }],
  modelsStatus: 'config_only',
  installed: true,
  resolvedPath: '/test/bin/codex',
  version: 'codex test',
  versionStatus: 'ok',
  authStatus: 'unknown',
  authStatusReason: 'safe test fixture',
  installHint: 'install codex',
});

describe('local CLI probe routes', { concurrency: false }, () => {
  afterEach(async () => {
    const { resetLocalCliModelsSnapshot } = await import('../dist/utils/local-cli-model-cache.js');
    resetLocalCliModelsSnapshot();
  });

  it('rejects unauthenticated scans without probing or writing a snapshot', async () => {
    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');
    const { localCliProbesRoutes } = await import('../dist/routes/local-cli-probes.js');
    let probeCalls = 0;

    const app = Fastify();
    await app.register(localCliProbesRoutes, {
      probe: async () => {
        probeCalls += 1;
        return [makeProbe('gpt-private')];
      },
    });
    await app.register(catsRoutes);

    const scanResponse = await app.inject({ method: 'GET', url: '/api/local-cli-probes' });
    assert.equal(scanResponse.statusCode, 401);
    assert.equal(probeCalls, 0);

    const optionsResponse = await app.inject({
      method: 'GET',
      url: '/api/cat-model-options',
      headers: { 'x-cat-cafe-user': 'anonymous-check' },
    });
    assert.equal(optionsResponse.statusCode, 200);
    const optionsBody = JSON.parse(optionsResponse.body);
    assert.equal(optionsBody.source, 'static-presets-v1');
    assert.equal(optionsBody.clients.openai.models.includes('gpt-private'), false);

    await app.close();
  });

  it('writes the scan only to the authenticated user and preserves another user snapshot', async () => {
    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');
    const { localCliProbesRoutes } = await import('../dist/routes/local-cli-probes.js');
    const { updateLocalCliModelsSnapshot } = await import('../dist/utils/local-cli-model-cache.js');
    updateLocalCliModelsSnapshot('user-b', {
      scannedAt: '2026-07-10T00:00:00.000Z',
      clis: [makeProbe('gpt-user-b')],
    });

    const app = Fastify();
    await app.register(localCliProbesRoutes, {
      probe: async () => [makeProbe('gpt-user-a')],
      now: () => new Date('2026-07-11T00:00:00.000Z'),
    });
    await app.register(catsRoutes);

    const scanResponse = await app.inject({
      method: 'GET',
      url: '/api/local-cli-probes',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    assert.equal(scanResponse.statusCode, 200);
    assert.equal(JSON.parse(scanResponse.body).scannedAt, '2026-07-11T00:00:00.000Z');

    const [userAResponse, userBResponse] = await Promise.all([
      app.inject({
        method: 'GET',
        url: '/api/cat-model-options',
        headers: { 'x-cat-cafe-user': 'user-a' },
      }),
      app.inject({
        method: 'GET',
        url: '/api/cat-model-options',
        headers: { 'x-cat-cafe-user': 'user-b' },
      }),
    ]);
    const userABody = JSON.parse(userAResponse.body);
    const userBBody = JSON.parse(userBResponse.body);
    assert.deepEqual(userABody.clients.openai.models, ['gpt-user-a']);
    assert.equal(userABody.scannedAt, '2026-07-11T00:00:00.000Z');
    assert.deepEqual(userBBody.clients.openai.models, ['gpt-user-b']);
    assert.equal(userBBody.scannedAt, '2026-07-10T00:00:00.000Z');

    await app.close();
  });
});
