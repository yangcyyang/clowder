export interface RecentArtifact {
  type: 'pr' | 'file' | 'plan' | 'feature-doc';
  ref: string;
  label: string;
  updatedAt: number;
  updatedBy: string;
  ops?: string[];
}

const MAX_ARTIFACTS = 5;
const WRITE_OPS = new Set(['edit', 'create', 'delete']);

function classifyPath(path: string): RecentArtifact['type'] {
  if (path.startsWith('docs/features/')) return 'feature-doc';
  if (path.startsWith('docs/plans/')) return 'plan';
  return 'file';
}

function labelFromPath(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1];
}

export interface ArtifactExtractionInput {
  filesTouched: Array<{ path: string; ops: string[] }>;
  prTasks: Array<{
    id: string;
    kind: string;
    subjectKey: string | null;
    title: string;
    ownerCatId: string | null;
    status: string;
    updatedAt: number;
  }>;
  catId: string;
}

export function extractRecentArtifacts(input: ArtifactExtractionInput): RecentArtifact[] {
  const artifacts: RecentArtifact[] = [];

  // W5: pr_tracking retired (kind is now always 'work') — input.prTasks can never contribute
  // a 'pr' artifact anymore. Kept as an accepted-but-unused input rather than a signature
  // change: source-ranking.ts's tier2 boost and historical ledger entries with type:'pr'
  // (persisted before this change) still need the 'pr' RecentArtifact variant to exist.

  for (const file of input.filesTouched) {
    if (!file.ops.some((op) => WRITE_OPS.has(op))) continue;
    artifacts.push({
      type: classifyPath(file.path),
      ref: file.path,
      label: labelFromPath(file.path),
      updatedAt: Date.now(),
      updatedBy: input.catId,
      ops: file.ops.filter((op) => WRITE_OPS.has(op)),
    });
  }

  return sortAndCapArtifacts(artifacts);
}

export function sortAndCapArtifacts(artifacts: RecentArtifact[], max = MAX_ARTIFACTS): RecentArtifact[] {
  return [...artifacts].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, max);
}

const MAX_LEDGER_ENTRIES = 20;

export function mergeLedger(
  existing: readonly RecentArtifact[],
  incoming: readonly RecentArtifact[],
): RecentArtifact[] {
  const byRef = new Map<string, RecentArtifact>();
  for (const a of existing) byRef.set(a.ref, a);
  for (const a of incoming) {
    const prev = byRef.get(a.ref);
    if (!prev || a.updatedAt >= prev.updatedAt) byRef.set(a.ref, a);
  }
  return [...byRef.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_LEDGER_ENTRIES);
}
