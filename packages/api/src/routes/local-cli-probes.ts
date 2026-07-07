import type { FastifyPluginAsync } from 'fastify';
import { probeLocalAgentClis } from '../utils/local-cli-probe.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

export const localCliProbesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/local-cli-probes', async (request, reply) => {
    const operator = resolveHeaderUserId(request);
    if (!operator) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    return {
      source: 'local-cli-allowlist-v1',
      scannedAt: new Date().toISOString(),
      safeMode: {
        allowlistOnly: true,
        credentialFilesRead: false,
        optIn: true,
      },
      clis: await probeLocalAgentClis(),
    };
  });
};
