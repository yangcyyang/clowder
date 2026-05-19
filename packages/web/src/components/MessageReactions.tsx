'use client';

import { useEffect, useState } from 'react';
import {
  getMessageReactions,
  MESSAGE_REACTIONS_EVENT,
  toggleMessageReaction,
  type MessageReaction,
} from '@/utils/message-reactions';
import { getUserId } from '@/utils/userId';

interface MessageReactionsProps {
  messageId: string;
}

export function MessageReactions({ messageId }: MessageReactionsProps) {
  const [reactions, setReactions] = useState<MessageReaction[]>(() => getMessageReactions(messageId));

  useEffect(() => {
    const syncReactions = () => setReactions(getMessageReactions(messageId));
    syncReactions();
    window.addEventListener(MESSAGE_REACTIONS_EVENT, syncReactions);
    window.addEventListener('storage', syncReactions);
    return () => {
      window.removeEventListener(MESSAGE_REACTIONS_EVENT, syncReactions);
      window.removeEventListener('storage', syncReactions);
    };
  }, [messageId]);

  if (reactions.length === 0) return null;

  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {reactions.map((reaction) => {
        const active = reaction.users.includes(getUserId());
        return (
          <button
            key={reaction.emoji}
            type="button"
            onClick={() => setReactions(toggleMessageReaction(messageId, reaction.emoji, getUserId()))}
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
