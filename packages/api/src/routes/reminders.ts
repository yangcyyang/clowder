import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AgentReminderStore } from '../domains/cats/services/reminders/AgentReminderStore.js';

export interface RemindersRoutesOptions {
  reminderStore: AgentReminderStore;
}

const scheduleSchema = z.object({
  catId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  threadId: z.string().min(1),
  sourceMessageId: z.string().min(1).optional(),
  message: z.string().trim().min(1).max(4000),
  fireAt: z.number().int().positive(),
});

const listQuerySchema = z.object({
  catId: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .optional(),
  threadId: z.string().min(1).optional(),
  status: z.enum(['scheduled', 'fired', 'canceled']).optional(),
  sourceMessageId: z.string().min(1).optional(),
});

export const remindersRoutes: FastifyPluginAsync<RemindersRoutesOptions> = async (app, opts) => {
  app.get<{
    Querystring: {
      catId?: string;
      threadId?: string;
      status?: 'scheduled' | 'fired' | 'canceled';
      sourceMessageId?: string;
    };
  }>('/api/reminders', async (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) {
      reply.status(400);
      return { error: 'Invalid query', details: query.error.flatten() };
    }
    return { reminders: await opts.reminderStore.list(query.data) };
  });

  app.post<{ Body: { catId: string; threadId: string; sourceMessageId?: string; message: string; fireAt: number } }>(
    '/api/reminders',
    async (request, reply) => {
      const body = scheduleSchema.safeParse(request.body);
      if (!body.success) {
        reply.status(400);
        return { error: 'Invalid body', details: body.error.flatten() };
      }
      reply.status(201);
      return opts.reminderStore.schedule(body.data);
    },
  );

  app.post<{ Params: { id: string } }>('/api/reminders/:id/cancel', async (request, reply) => {
    const reminder = await opts.reminderStore.cancel(request.params.id);
    if (!reminder) {
      reply.status(404);
      return { error: 'Reminder not found' };
    }
    return reminder;
  });
};
