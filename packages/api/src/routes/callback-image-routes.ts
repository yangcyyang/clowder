/**
 * Image generation callback routes.
 *
 * Endpoint: POST /api/callbacks/generate-image
 * Cat calls this to generate images via the configured OpenAI image model.
 * The generated files are saved to /uploads/ and attached as media_gallery.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import { getRichBlockBuffer } from '../domains/cats/services/agents/invocation/RichBlockBuffer.js';
import {
  IMAGE_OUTPUT_FORMAT_VALUES,
  IMAGE_QUALITY_VALUES,
  IMAGE_SIZE_VALUES,
  imagePublicationKey,
  OpenAIImageGenerationService,
} from '../infrastructure/image/OpenAIImageGenerationService.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { deriveCallbackActor, effectiveInvocationId } from './callback-scope-helpers.js';

const generateImageSchema = z.object({
  prompt: z.string().trim().min(1).max(8000),
  n: z.number().int().min(1).max(4).optional(),
  size: z.enum(IMAGE_SIZE_VALUES).optional(),
  quality: z.enum(IMAGE_QUALITY_VALUES).optional(),
  outputFormat: z.enum(IMAGE_OUTPUT_FORMAT_VALUES).optional(),
  title: z.string().trim().min(1).max(120).optional(),
});

export function registerCallbackImageRoutes(
  app: FastifyInstance,
  deps: {
    registry: InvocationRegistry;
    socketManager: SocketManager;
    imageService?: OpenAIImageGenerationService;
  },
): void {
  const imageService =
    deps.imageService ??
    new OpenAIImageGenerationService({
      projectRoot: resolveActiveProjectRoot(),
      logger: app.log,
    });

  app.post('/api/callbacks/generate-image', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = generateImageSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const actor = deriveCallbackActor(record);
    const invocationId = actor.invocationId;
    const effectiveInvId = effectiveInvocationId(actor);
    if (!(await deps.registry.isLatest(invocationId))) {
      return { status: 'stale_ignored' };
    }

    const result = await imageService.generateAndPublish({
      ...parsed.data,
      title: parsed.data.title ?? '生成图片',
      toolName: 'cat_cafe_generate_image',
      publicationKey: imagePublicationKey([invocationId, record.threadId, record.catId, parsed.data.prompt]),
    });

    const isNew = getRichBlockBuffer().add(record.threadId, record.catId as string, result.richBlock, invocationId);
    if (isNew) {
      deps.socketManager.broadcastAgentMessage(
        {
          type: 'system_info' as const,
          catId: record.catId,
          content: JSON.stringify({ type: 'rich_block', block: result.richBlock }),
          invocationId: effectiveInvId,
          timestamp: Date.now(),
        },
        record.threadId,
      );
    }

    return {
      status: 'ok',
      provider: result.provider,
      model: result.model,
      durationMs: result.durationMs,
      images: result.images.map((image) => ({
        url: image.url,
        mimeType: image.mimeType,
        fileSize: image.fileSize,
        ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}),
      })),
      block: result.richBlock,
    };
  });
}
