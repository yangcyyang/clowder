import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type {
  FreshnessHoldRecord,
  IFreshnessHoldStore,
} from '../domains/cats/services/stores/ports/FreshnessHoldStore.js';
import { resolveUserId } from '../utils/request-identity.js';

export interface FreshnessHoldsRoutesOptions {
  holdStore: IFreshnessHoldStore;
}

const listQuerySchema = z.object({
  threadId: z.string().trim().min(1).max(200),
});

function toPublicMetadata(hold: FreshnessHoldRecord) {
  return {
    id: hold.id,
    catId: hold.catId,
    threadId: hold.threadId,
    status: hold.status,
    version: hold.version,
    reviewCount: hold.reviewCount,
    createdAt: hold.createdAt,
    updatedAt: hold.updatedAt,
    reviewDeadlineAt: hold.reviewDeadlineAt,
    ...(hold.attentionReason ? { attentionReason: hold.attentionReason } : {}),
  };
}

/** Browser recovery endpoint. It deliberately returns metadata only, never the held envelope. */
export const freshnessHoldsRoutes: FastifyPluginAsync<FreshnessHoldsRoutesOptions> = async (app, opts) => {
  app.get<{ Querystring: { threadId?: string } }>('/api/freshness-holds', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }

    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) {
      reply.status(400);
      return { error: 'Invalid query', details: query.error.flatten() };
    }

    const holds = await opts.holdStore.listActive(userId, query.data.threadId);
    return { holds: holds.map(toPublicMetadata) };
  });
};
