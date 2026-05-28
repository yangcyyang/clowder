'use client';

import type { MessageReaction } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { hasUserReaction, toggleMessageReaction } from '@/utils/message-reactions';
import { getUserId } from '@/utils/userId';

interface MessageReactionsProps {
  messageId: string;
  reactions?: MessageReaction[];
}

export function MessageReactions({ messageId, reactions = [] }: MessageReactionsProps) {
  const patchMessage = useChatStore((s) => s.patchMessage);
  if (reactions.length === 0) return null;

  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {reactions.map((reaction) => {
        const userId = getUserId();
        const active = hasUserReaction(reactions, reaction.emoji, userId);
        return (
          <button
            key={reaction.emoji}
            type="button"
            onClick={async () => {
              try {
                const nextReactions = await toggleMessageReaction({
                  messageId,
                  emoji: reaction.emoji,
                  userId,
                  active,
                });
                patchMessage(messageId, { extra: { reactions: nextReactions } });
              } catch (err) {
                useToastStore.getState().addToast({
                  type: 'error',
                  title: 'Reaction 失败',
                  message: err instanceof Error ? err.message : '请稍后重试',
                  duration: 3000,
                });
              }
            }}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors ${
              active
                ? 'border-[var(--cafe-accent)]/40 bg-[var(--cafe-accent)]/10 text-[var(--cafe-accent)]'
                : 'border-[var(--slock-border-color)] bg-[var(--console-card-soft-bg)] text-[var(--cafe-text-secondary)] hover:bg-[var(--console-hover-bg)] hover:text-[var(--cafe-text)]'
            }`}
            title={`${reaction.users.length} 个反应`}
            aria-pressed={active}
          >
            <span>{reaction.emoji}</span>
            <span className="font-semibold">{reaction.users.length}</span>
          </button>
        );
      })}
    </div>
  );
}
