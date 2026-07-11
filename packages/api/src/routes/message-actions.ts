/**
 * Message Actions Routes
 * DELETE /api/messages/:id       — soft/hard delete (ADR-008 D3 / S5+S6)
 * PATCH  /api/messages/:id/restore — restore soft-deleted message
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { type IMessageStore, isDelivered } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { isSystemUserMessage } from '../domains/cats/services/stores/visibility.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { auditDangerousActionBestEffort, readDangerousActionConfirmation } from '../utils/dangerous-action-guard.js';

export interface MessageActionsRoutesOptions {
  messageStore: IMessageStore;
  socketManager: SocketManager;
  threadStore?: IThreadStore;
}

const deleteBodySchema = z.object({
  userId: z.string().min(1).max(100),
  mode: z.enum(['soft', 'hard']).default('soft'),
  /** Required for hard delete — must match thread title as confirmation */
  confirmTitle: z.string().optional(),
});

const restoreBodySchema = z.object({
  userId: z.string().min(1).max(100),
});

const editBodySchema = z.object({
  userId: z.string().min(1).max(100),
  content: z.string().trim().min(1).max(20_000),
});

const reactionBodySchema = z.object({
  userId: z.string().min(1).max(100),
  emoji: z.string().trim().min(1).max(32),
});

const deleteReactionBodySchema = z.object({
  userId: z.string().min(1).max(100),
});

type MessageReaction = {
  emoji: string;
  users: string[];
  updatedAt: number;
};

function normalizeReactions(value: unknown): MessageReaction[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is MessageReaction => {
      if (!item || typeof item !== 'object') return false;
      const candidate = item as Partial<MessageReaction>;
      return (
        typeof candidate.emoji === 'string' &&
        Array.isArray(candidate.users) &&
        candidate.users.every((user) => typeof user === 'string')
      );
    })
    .map((item) => ({
      emoji: item.emoji,
      users: Array.from(new Set(item.users)),
      updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
    }))
    .filter((item) => item.users.length > 0);
}

function addReaction(reactions: MessageReaction[], emoji: string, userId: string): MessageReaction[] {
  const now = Date.now();
  const found = reactions.find((reaction) => reaction.emoji === emoji);
  if (!found) {
    return [...reactions, { emoji, users: [userId], updatedAt: now }];
  }
  return reactions.map((reaction) => {
    if (reaction.emoji !== emoji) return reaction;
    return { ...reaction, users: Array.from(new Set([...reaction.users, userId])), updatedAt: now };
  });
}

function removeReaction(reactions: MessageReaction[], emoji: string, userId: string): MessageReaction[] {
  const now = Date.now();
  return reactions
    .map((reaction) => {
      if (reaction.emoji !== emoji) return reaction;
      return { ...reaction, users: reaction.users.filter((user) => user !== userId), updatedAt: now };
    })
    .filter((reaction) => reaction.users.length > 0);
}

export const messageActionsRoutes: FastifyPluginAsync<MessageActionsRoutesOptions> = async (app, opts) => {
  // GET /api/messages/:id — fetch one message for CLI/task workflows.
  app.get<{ Params: { id: string } }>('/api/messages/:id', async (request, reply) => {
    const { id } = request.params;
    const msg = await opts.messageStore.getById(id);
    if (!msg || !isDelivered(msg)) {
      reply.status(404);
      return { error: '消息不存在', code: 'MESSAGE_NOT_FOUND' };
    }

    return {
      id: msg.id,
      threadId: msg.threadId,
      userId: msg.userId,
      catId: msg.catId,
      content: msg.content,
      mentions: msg.mentions,
      timestamp: msg.timestamp,
      ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
      ...(msg.origin ? { origin: msg.origin } : {}),
      ...(msg.editedAt ? { editedAt: msg.editedAt } : {}),
      ...(msg.deletedAt ? { deletedAt: msg.deletedAt } : {}),
    };
  });

  // POST /api/messages/:id/reactions — add an emoji reaction for the current user.
  app.post<{ Params: { id: string } }>('/api/messages/:id/reactions', async (request, reply) => {
    const parseResult = reactionBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parseResult.error.issues };
    }

    const { id } = request.params;
    const { userId, emoji } = parseResult.data;
    const targetMsg = await opts.messageStore.getById(id);
    if (!targetMsg || targetMsg.deletedAt || targetMsg._tombstone) {
      reply.status(404);
      return { error: '消息不存在', code: 'MESSAGE_NOT_FOUND' };
    }

    const reactions = addReaction(normalizeReactions(targetMsg.extra?.reactions), emoji, userId);
    const extra = { ...(targetMsg.extra ?? {}), reactions };
    const updated = await opts.messageStore.updateExtra(id, extra);
    if (!updated) {
      reply.status(500);
      return { error: 'Reaction update failed', code: 'REACTION_UPDATE_FAILED' };
    }

    opts.socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'message_reactions_updated', {
      messageId: id,
      threadId: updated.threadId,
      reactions,
    });

    return { messageId: id, threadId: updated.threadId, reactions };
  });

  // DELETE /api/messages/:id/reactions/:emoji — remove current user's reaction.
  app.delete<{ Params: { id: string; emoji: string } }>(
    '/api/messages/:id/reactions/:emoji',
    async (request, reply) => {
      const parseResult = deleteReactionBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        reply.status(400);
        return { error: 'Invalid request body', details: parseResult.error.issues };
      }

      const { id } = request.params;
      const emoji = decodeURIComponent(request.params.emoji);
      const { userId } = parseResult.data;
      const targetMsg = await opts.messageStore.getById(id);
      if (!targetMsg || targetMsg.deletedAt || targetMsg._tombstone) {
        reply.status(404);
        return { error: '消息不存在', code: 'MESSAGE_NOT_FOUND' };
      }

      const reactions = removeReaction(normalizeReactions(targetMsg.extra?.reactions), emoji, userId);
      const extra = { ...(targetMsg.extra ?? {}), reactions };
      const updated = await opts.messageStore.updateExtra(id, extra);
      if (!updated) {
        reply.status(500);
        return { error: 'Reaction update failed', code: 'REACTION_UPDATE_FAILED' };
      }

      opts.socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'message_reactions_updated', {
        messageId: id,
        threadId: updated.threadId,
        reactions,
      });

      return { messageId: id, threadId: updated.threadId, reactions };
    },
  );

  // DELETE /api/messages/:id — soft or hard delete a single message
  app.delete<{ Params: { id: string } }>('/api/messages/:id', async (request, reply) => {
    const parseResult = deleteBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parseResult.error.issues };
    }

    const { id } = request.params;
    const { userId, mode, confirmTitle } = parseResult.data;

    // Authorization: verify message exists and caller owns it or is thread creator
    const targetMsg = await opts.messageStore.getById(id);
    if (!targetMsg) {
      reply.status(404);
      return { error: '消息不存在', code: 'MESSAGE_NOT_FOUND' };
    }
    if (targetMsg.userId !== userId) {
      // Not the message author — check if thread creator
      if (opts.threadStore) {
        const thread = await opts.threadStore.get(targetMsg.threadId);
        if (!thread || thread.createdBy !== userId) {
          reply.status(403);
          return { error: '无权删除此消息', code: 'UNAUTHORIZED' };
        }
      } else {
        reply.status(403);
        return { error: '无权删除此消息', code: 'UNAUTHORIZED' };
      }
    }

    if (mode === 'hard') {
      // Hard delete requires confirmTitle matching the thread title
      if (!confirmTitle) {
        reply.status(400);
        return { error: '硬删除需要输入对话标题确认', code: 'CONFIRM_TITLE_REQUIRED' };
      }

      if (opts.threadStore) {
        const thread = await opts.threadStore.get(targetMsg.threadId);
        // Untitled threads require fixed confirmation phrase
        const expectedTitle = thread?.title ?? '确认删除';
        if (confirmTitle !== expectedTitle) {
          reply.status(400);
          return { error: '对话标题不匹配', code: 'CONFIRM_TITLE_MISMATCH' };
        }
      }

      const deleted = await opts.messageStore.hardDelete(id, userId);
      if (!deleted) {
        reply.status(500);
        return { error: '删除失败', code: 'DELETE_FAILED' };
      }

      opts.socketManager.broadcastToRoom(`thread:${deleted.threadId}`, 'message_hard_deleted', {
        messageId: id,
        threadId: deleted.threadId,
        deletedBy: userId,
      });

      void auditDangerousActionBestEffort({
        request,
        actorId: userId,
        action: 'message.hard_delete',
        targetType: 'message',
        targetId: id,
        threadId: deleted.threadId,
        severity: 'high',
        result: 'succeeded',
        confirmation: 'existing_confirm_field',
        metadata: {
          confirmTitleProvided: Boolean(confirmTitle),
        },
      });

      return {
        id: deleted.id,
        threadId: deleted.threadId,
        deletedAt: deleted.deletedAt,
        deletedBy: deleted.deletedBy,
        _tombstone: true,
      };
    }

    // Soft delete (default)
    const deleted = await opts.messageStore.softDelete(id, userId);
    if (!deleted) {
      reply.status(404);
      return { error: '消息不存在', code: 'MESSAGE_NOT_FOUND' };
    }

    opts.socketManager.broadcastToRoom(`thread:${deleted.threadId}`, 'message_deleted', {
      messageId: id,
      threadId: deleted.threadId,
      deletedBy: userId,
    });

    void auditDangerousActionBestEffort({
      request,
      actorId: userId,
      action: 'message.soft_delete',
      targetType: 'message',
      targetId: id,
      threadId: deleted.threadId,
      severity: 'medium',
      result: 'succeeded',
      confirmation: readDangerousActionConfirmation(request, 'message.soft_delete') ?? 'not_required',
    });

    return {
      id: deleted.id,
      threadId: deleted.threadId,
      deletedAt: deleted.deletedAt,
      deletedBy: deleted.deletedBy,
    };
  });

  // PATCH /api/messages/:id — edit a user's own plain-text message in place.
  app.patch<{ Params: { id: string } }>('/api/messages/:id', async (request, reply) => {
    const parseResult = editBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parseResult.error.issues };
    }

    const { id } = request.params;
    const { userId, content } = parseResult.data;
    const targetMsg = await opts.messageStore.getById(id);

    if (!targetMsg || targetMsg.deletedAt || targetMsg._tombstone) {
      reply.status(404);
      return { error: '消息不存在', code: 'MESSAGE_NOT_FOUND' };
    }

    if (targetMsg.userId !== userId || targetMsg.catId || isSystemUserMessage(targetMsg) || targetMsg.source) {
      reply.status(403);
      return { error: '只能编辑自己发送的普通消息', code: 'UNAUTHORIZED' };
    }

    if (targetMsg.contentBlocks?.length) {
      reply.status(400);
      return { error: '暂不支持编辑带图片或富内容的消息', code: 'UNSUPPORTED_CONTENT_BLOCK_EDIT' };
    }

    const editedAt = Date.now();
    const updated = await opts.messageStore.updateContent(id, content, editedAt);
    if (!updated) {
      reply.status(500);
      return { error: '编辑失败', code: 'EDIT_FAILED' };
    }

    opts.socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'message_edited', {
      messageId: id,
      threadId: updated.threadId,
      content: updated.content,
      editedAt,
      editedBy: userId,
    });

    return {
      id: updated.id,
      threadId: updated.threadId,
      content: updated.content,
      timestamp: updated.timestamp,
      editedAt,
    };
  });

  // PATCH /api/messages/:id/restore — restore a soft-deleted message (rejects tombstones)
  app.patch<{ Params: { id: string } }>('/api/messages/:id/restore', async (request, reply) => {
    const parseResult = restoreBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parseResult.error.issues };
    }

    const { id } = request.params;
    const { userId } = parseResult.data;

    // Pre-fetch message to check authorization
    const targetMsg = await opts.messageStore.getById(id);
    if (!targetMsg) {
      reply.status(404);
      return { error: '消息不存在', code: 'MESSAGE_NOT_FOUND' };
    }
    if (!targetMsg.deletedAt || targetMsg._tombstone) {
      reply.status(404);
      return { error: '消息不存在、未被删除、或已硬删除', code: 'MESSAGE_NOT_RESTORABLE' };
    }

    // Authorization: only the person who deleted can restore, or thread creator
    if (targetMsg.deletedBy !== userId) {
      if (opts.threadStore) {
        const thread = await opts.threadStore.get(targetMsg.threadId);
        if (!thread || thread.createdBy !== userId) {
          reply.status(403);
          return { error: '无权恢复此消息', code: 'UNAUTHORIZED' };
        }
      } else {
        reply.status(403);
        return { error: '无权恢复此消息', code: 'UNAUTHORIZED' };
      }
    }

    const restored = await opts.messageStore.restore(id);
    if (!restored) {
      reply.status(500);
      return { error: '恢复失败', code: 'RESTORE_FAILED' };
    }

    opts.socketManager.broadcastToRoom(`thread:${restored.threadId}`, 'message_restored', {
      messageId: id,
      threadId: restored.threadId,
    });

    return {
      id: restored.id,
      threadId: restored.threadId,
      content: restored.content,
      timestamp: restored.timestamp,
    };
  });

  // F096: PATCH /api/messages/:id/block-state — persist interactive block state
  const patchBlockStateSchema = z.object({
    userId: z.string().min(1).max(100),
    blockId: z.string().min(1),
    disabled: z.boolean().optional(),
    selectedIds: z.array(z.string()).optional(),
  });

  app.patch<{ Params: { id: string } }>('/api/messages/:id/block-state', async (request, reply) => {
    const parsed = patchBlockStateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }

    const { id } = request.params;
    const { userId, blockId, disabled, selectedIds } = parsed.data;
    const msg = await opts.messageStore.getById(id);
    if (!msg) {
      reply.status(404);
      return { error: 'Message not found' };
    }

    // P1-1 fix: Authorization — caller must own message or be thread creator
    if (msg.userId !== userId) {
      if (opts.threadStore) {
        const thread = await opts.threadStore.get(msg.threadId);
        if (!thread || thread.createdBy !== userId) {
          reply.status(403);
          return { error: 'Unauthorized', code: 'UNAUTHORIZED' };
        }
      } else {
        reply.status(403);
        return { error: 'Unauthorized', code: 'UNAUTHORIZED' };
      }
    }

    if (!msg.extra?.rich?.blocks) {
      reply.status(404);
      return { error: 'Message has no rich blocks' };
    }

    const block = msg.extra.rich.blocks.find((b) => b.id === blockId);
    if (!block) {
      reply.status(404);
      return { error: `Block ${blockId} not found` };
    }

    // P2-2 fix: only allow patching interactive blocks
    if (block.kind !== 'interactive') {
      reply.status(400);
      return { error: `Block ${blockId} is not interactive (kind: ${block.kind})` };
    }

    // Merge patch into block
    const mutable = block as unknown as Record<string, unknown>;
    if (disabled !== undefined) mutable.disabled = disabled;
    if (selectedIds !== undefined) mutable.selectedIds = selectedIds;

    await opts.messageStore.updateExtra(id, msg.extra);
    return { status: 'ok' };
  });
};
