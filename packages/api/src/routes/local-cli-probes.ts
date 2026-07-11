import type { FastifyPluginAsync } from 'fastify';
import { updateLocalCliModelsSnapshot } from '../utils/local-cli-model-cache.js';
import { type LocalCliProbeResult, probeLocalAgentClis } from '../utils/local-cli-probe.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

interface LocalCliProbesRoutesOptions {
  readonly probe?: () => Promise<readonly LocalCliProbeResult[]>;
  readonly now?: () => Date;
}

export const localCliProbesRoutes: FastifyPluginAsync<LocalCliProbesRoutesOptions> = async (app, options) => {
  app.get('/api/local-cli-probes', async (request, reply) => {
    const operator = resolveHeaderUserId(request);
    if (!operator) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const clis = await (options.probe ?? probeLocalAgentClis)();
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
