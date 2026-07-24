/**
 * 批次 2-D: single-writer FIFO queue for all `.cat-cafe/memory/USER.md` mutations
 * (candidate-queue append + promote-write). Same pattern as F163's
 * `packages/api/src/domains/memory/evidence-write-queue.ts` (EvidenceWriteQueue) —
 * USER.md is shared across every cat, so proposals from concurrent invocations
 * (different cats, different threads) must serialize instead of interleaving.
 */
export class UserProfileWriteQueue {
  private tail: Promise<void> = Promise.resolve();

  /** Enqueue an operation. Returns its result when executed. FIFO, no interleaving. */
  enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.tail = this.tail.then(async () => {
        try {
          resolve(await fn());
        } catch (e) {
          reject(e);
        }
      });
    });
  }
}

/** Process-wide singleton — all USER.md writers must share this instance. */
export const userProfileWriteQueue = new UserProfileWriteQueue();
