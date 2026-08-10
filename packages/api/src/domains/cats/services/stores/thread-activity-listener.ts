import type { IThreadStore } from './ports/ThreadStore.js';

export interface ThreadActivityMessage {
  id: string;
  threadId: string;
  timestamp: number;
  content: string;
}

export type ThreadActivityListener = (msg: ThreadActivityMessage) => void;

export function createThreadActivityAppendListener(options: {
  threadStore: Pick<IThreadStore, 'updateLastActive'>;
  onAfterUpdate?: ThreadActivityListener;
}): ThreadActivityListener {
  return (msg) => {
    if (msg.threadId) {
      try {
        void Promise.resolve(options.threadStore.updateLastActive(msg.threadId, msg.timestamp)).catch(() => {});
      } catch {
        // best-effort: message persistence must not fail because activity indexing failed
      }
    }

    options.onAfterUpdate?.(msg);
  };
}
