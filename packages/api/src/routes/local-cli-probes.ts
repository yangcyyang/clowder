import type { FastifyPluginAsync } from 'fastify';
import { updateLocalCliModelsSnapshot } from '../utils/local-cli-model-cache.js';
import { type LocalCliProbeResult, probeLocalAgentClis } from '../utils/local-cli-probe.js';
import { getModelCatalog } from '../utils/model-catalog.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

interface LocalCliProbesRoutesOptions {
  readonly probe?: () => Promise<readonly LocalCliProbeResult[]>;
  readonly now?: () => Date;
}

/**
 * Real (non-test-overridden) scan path: fetch the shared cloud model catalog (5th source, best
 * effort, silently empty on failure/disabled/timeout — see model-catalog.ts) once per scan, then
 * merge it into the CLI probe chain via `modelCatalog`.
 */
async function runRealProbe(): Promise<readonly LocalCliProbeResult[]> {
  const modelCatalog = await getModelCatalog();
  return probeLocalAgentClis({ modelCatalog });
}

export const localCliProbesRoutes: FastifyPluginAsync<LocalCliProbesRoutesOptions> = async (app, options) => {
  app.get('/api/local-cli-probes', async (request, reply) => {
    const operator = resolveHeaderUserId(request);
    if (!operator) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const clis = await (options.probe ?? runRealProbe)();
    const scannedAt = (options.now ?? (() => new Date()))().toISOString();
    updateLocalCliModelsSnapshot(operator, { scannedAt, clis });

    return {
      source: 'local-cli-radar-v2',
      scannedAt,
      safeMode: {
        allowlistOnly: true,
        credentialFilesRead: false,
        modelConfigFilesRead: true,
        optIn: true,
      },
      clis,
    };
  });
};
