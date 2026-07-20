import type { ChatMessage, Thread, ThreadState } from '@/stores/chatStore';

export type ThreadViewer = { readonly type: 'user' } | { readonly type: 'cat'; readonly catId: string };

export interface ActualThreadParticipant {
  readonly catId: string;
  readonly active: boolean;
}

export interface RelationOrderedThreadRow {
  readonly thread: Thread;
  readonly depth: number;
  readonly orphaned: boolean;
}

/** Mirrors the API visibility contract before any participant or status derivation. */
export function canViewerSeeThreadMessage(message: ChatMessage, viewer: ThreadViewer): boolean {
  if (viewer.type === 'user') return true;
  if (!message.visibility || message.visibility === 'public' || message.revealedAt) return true;
  if (message.visibility === 'whisper') return message.whisperTo?.includes(viewer.catId) ?? false;
  return false;
}

export function deriveActualThreadParticipants(
  messages: readonly ChatMessage[],
  options: {
    readonly viewer: ThreadViewer;
    readonly activeInvocations?: ThreadState['activeInvocations'];
  },
): ActualThreadParticipant[] {
  const participantIds: string[] = [];
  const seen = new Set<string>();
  const add = (catId: string | undefined): void => {
    if (!catId || catId === '__co-creator__' || seen.has(catId)) return;
    seen.add(catId);
    participantIds.push(catId);
  };

  for (const message of messages) {
    if (!canViewerSeeThreadMessage(message, options.viewer)) continue;
    add(message.catId);
    for (const catId of message.mentions ?? []) add(catId);
    for (const catId of message.extra?.targetCats ?? []) add(catId);
  }

  const activeCatIds = new Set(Object.values(options.activeInvocations ?? {}).map((slot) => slot.catId));
  return participantIds.map((catId) => ({ catId, active: activeCatIds.has(catId) }));
}

const RELATION_KINDS: ReadonlySet<string> = new Set(['inline_reply', 'edit_branch']);

export type ResolvedThreadBranch =
  | { readonly kind: 'root' }
  | { readonly kind: 'branch'; readonly parent: Thread }
  | { readonly kind: 'orphan' };

/**
 * Resolve a thread's durable branch identity for display.
 * - No relation → root.
 * - Malformed/legacy relation (bad version, unknown kind, empty/self parent)
 *   degrades to ROOT display — never trusted, never widens any association.
 * - Well-formed relation with a missing parent → orphan (render as a standalone
 *   root-level thread with an orphan marker; the raw parentThreadId is never shown).
 */
export function resolveThreadBranch(
  thread: Pick<Thread, 'id' | 'relation'> | undefined,
  allThreads: readonly Thread[],
): ResolvedThreadBranch {
  if (!thread) return { kind: 'root' };
  const relation = thread.relation;
  if (!relation) return { kind: 'root' };
  if (
    relation.v !== 1 ||
    !RELATION_KINDS.has(relation.kind) ||
    typeof relation.parentThreadId !== 'string' ||
    relation.parentThreadId.length === 0 ||
    relation.parentThreadId === thread.id
  ) {
    return { kind: 'root' };
  }
  const parent = allThreads.find((candidate) => candidate.id === relation.parentThreadId);
  if (!parent) return { kind: 'orphan' };
  return { kind: 'branch', parent };
}

export interface ChannelRowModel {
  readonly thread: Thread;
  /** Display depth. Orphans and malformed relations flatten to 0 (root display). */
  readonly depth: number;
  /** True only for well-formed branch relations with a known parent. */
  readonly branch: boolean;
  readonly orphaned: boolean;
}

/** Sidebar row models: relation ordering + validated branch/orphan display flags. */
export function buildChannelRowModels(threads: readonly Thread[]): ChannelRowModel[] {
  return buildRelationOrderedThreadRows(threads).map((row) => {
    const resolved = resolveThreadBranch(row.thread, threads);
    if (resolved.kind === 'branch') {
      return { thread: row.thread, depth: row.depth, branch: true, orphaned: false };
    }
    if (resolved.kind === 'orphan') {
      return { thread: row.thread, depth: 0, branch: false, orphaned: true };
    }
    return { thread: row.thread, depth: 0, branch: false, orphaned: false };
  });
}

/**
 * D3: Agents actually present in a thread — derived ONLY from the viewer-visible
 * message set of THIS thread (posted or @-mentioned), plus active-invocation
 * decoration. The config roster (participatingCats/preferredCats) is never used;
 * whisper participants stay invisible to non-recipients because the visibility
 * filter runs before any derivation.
 */
export function derivePresentThreadAgents(
  threadState: Pick<ThreadState, 'messages' | 'activeInvocations'> | undefined,
  viewer: ThreadViewer,
): ActualThreadParticipant[] {
  if (!threadState) return [];
  return deriveActualThreadParticipants(threadState.messages, {
    viewer,
    activeInvocations: threadState.activeInvocations,
  });
}

/** Preserve root ordering while placing durable relation children directly after their parent. */
export function buildRelationOrderedThreadRows(threads: readonly Thread[]): RelationOrderedThreadRow[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const childrenByParent = new Map<string, Thread[]>();
  const roots: Thread[] = [];
  const orphans: Thread[] = [];

  for (const thread of threads) {
    const parentId = thread.relation?.parentThreadId;
    if (!parentId) {
      roots.push(thread);
      continue;
    }
    if (!byId.has(parentId)) {
      orphans.push(thread);
      continue;
    }
    const children = childrenByParent.get(parentId) ?? [];
    children.push(thread);
    childrenByParent.set(parentId, children);
  }

  const rows: RelationOrderedThreadRow[] = [];
  const seen = new Set<string>();
  const appendTree = (thread: Thread, depth: number, orphaned: boolean): void => {
    if (seen.has(thread.id)) return;
    seen.add(thread.id);
    rows.push({ thread, depth, orphaned });
    for (const child of childrenByParent.get(thread.id) ?? []) appendTree(child, depth + 1, orphaned);
  };

  for (const root of roots) appendTree(root, 0, false);
  for (const orphan of orphans) appendTree(orphan, 1, true);
  // Self-parent and relation cycles have no valid root. Keep every node visible
  // as an orphan rather than silently dropping it from navigation.
  for (const thread of threads) {
    if (!seen.has(thread.id)) appendTree(thread, 1, true);
  }
  return rows;
}
