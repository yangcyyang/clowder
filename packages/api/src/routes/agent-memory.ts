import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { readAgentMemory, writeAgentMemory } from '../domains/cats/services/agents/memory/AgentMemoryStore.js';

const catIdParamSchema = z.object({
  catId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
});

const patchMemorySchema = z.object({
  content: z.string().max(120_000),
});

export const agentMemoryRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { catId: string } }>('/api/cats/:catId/memory', async (request, reply) => {
    const params = catIdParamSchema.safeParse(request.params);
    if (!params.success) {
      reply.status(400);
      return { error: 'Invalid catId' };
    }
    return readAgentMemory(params.data.catId);
  });

  app.patch<{ Params: { catId: string }; Body: { content: string } }>(
    '/api/cats/:catId/memory',
    async (request, reply) => {
      const params = catIdParamSchema.safeParse(request.params);
      if (!params.success) {
        reply.status(400);
        return { error: 'Invalid catId' };
      }
      const body = patchMemorySchema.safeParse(request.body);
      if (!body.success) {
        reply.status(400);
        return { error: 'Invalid body', details: body.error.flatten() };
      }
      return writeAgentMemory(params.data.catId, body.data.content);
    },
  );
};
