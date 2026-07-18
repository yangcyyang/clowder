import type { ThreadAddressParseResult } from '@cat-cafe/shared';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';

export interface ResolvedThreadAddress {
  ok: true;
  sourceThreadId: string;
  rootMessageId: string;
  replyTargetThreadId: string;
}

export type ThreadAddressResolution = ResolvedThreadAddress | { ok: false; code: 'THREAD_ADDRESS_INVALID' };

export function isThreadAddressRoutingEnabled(threadId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CLOWDER_THREAD_ADDRESS_ROUTING === 'true') return true;
  return (env.CLOWDER_THREAD_ADDRESS_THREADS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(threadId);
}

export async function resolveThreadAddress(
  parsed: Extract<ThreadAddressParseResult, { kind: 'valid' }>,
  input: {
    sourceThreadId: string;
    userId: string;
    messageStore: IMessageStore;
    threadStore: Pick<IThreadStore, 'get'>;
  },
): Promise<ThreadAddressResolution> {
  const deny = (): ThreadAddressResolution => ({ ok: false, code: 'THREAD_ADDRESS_INVALID' });
  const [requestThread, root] = await Promise.all([
    input.threadStore.get(input.sourceThreadId),
    input.messageStore.getById(parsed.rootMessageId),
  ]);
  if (
    input.sourceThreadId !== 'default' &&
    (!requestThread || requestThread.deletedAt || requestThread.createdBy !== input.userId)
  ) {
    return deny();
  }
  if (
    !root ||
    root.deletedAt ||
    root._tombstone ||
    root.catId !== null ||
    root.userId !== input.userId ||
    (root.visibility === 'whisper' && !root.revealedAt)
  ) {
    return deny();
  }

  const branchThreadId = root.extra?.slockThread?.branchThreadId;
  if (!branchThreadId) return deny();
  const [rootThread, branchThread] = await Promise.all([
    input.threadStore.get(root.threadId),
    input.threadStore.get(branchThreadId),
  ]);
  if (
    !rootThread ||
    rootThread.deletedAt ||
    rootThread.createdBy !== input.userId ||
    !branchThread ||
    branchThread.deletedAt ||
    branchThread.createdBy !== input.userId
  ) {
    return deny();
  }

  return {
    ok: true,
    sourceThreadId: input.sourceThreadId,
    rootMessageId: root.id,
    replyTargetThreadId: branchThreadId,
  };
}
