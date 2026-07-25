'use client';

import { create } from 'zustand';

/**
 * "Select Message" (Raft-parity context menu item) — a lightweight multi-select mode scoped to
 * a single thread at a time. Deliberately NOT a per-message checkbox array baked into
 * chatStore: this is transient UI state (never persisted, cleared on thread switch), so it gets
 * its own tiny store instead of growing ChatMessage/chatStore's surface. MessageActions reads
 * `threadId` to decide whether ITS row is in selection mode (only one thread can be "selecting"
 * at a time — matches there only ever being one visible message list focused by the user,
 * whether that's the main channel or an open InlineThreadPanel).
 */
interface MessageSelectionState {
  threadId: string | null;
  selectedIds: string[];
  /** Enter selection mode for a thread, pre-selecting one message. */
  start: (threadId: string, messageId: string) => void;
  /** Toggle a message in/out of the current selection. Starts a fresh selection if the target
   * thread differs from whichever thread was being selected (or none was). */
  toggle: (threadId: string, messageId: string) => void;
  clear: () => void;
}

export const useMessageSelectionStore = create<MessageSelectionState>((set, get) => ({
  threadId: null,
  selectedIds: [],

  start: (threadId, messageId) => set({ threadId, selectedIds: [messageId] }),

  toggle: (threadId, messageId) => {
    const state = get();
    if (state.threadId !== threadId) {
      set({ threadId, selectedIds: [messageId] });
      return;
    }
    const exists = state.selectedIds.includes(messageId);
    const nextIds = exists ? state.selectedIds.filter((id) => id !== messageId) : [...state.selectedIds, messageId];
    set(nextIds.length === 0 ? { threadId: null, selectedIds: [] } : { threadId, selectedIds: nextIds });
  },

  clear: () => set({ threadId: null, selectedIds: [] }),
}));

export function isMessageSelected(threadId: string | null, selectedIds: string[], messageId: string): boolean {
  return threadId !== null && selectedIds.includes(messageId);
}
