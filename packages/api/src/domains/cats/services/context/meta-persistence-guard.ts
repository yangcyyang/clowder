/**
 * ADR-024 D3: meta-block persistence-exclusion guard.
 *
 * D3 unvariant (docs/decisions/024-kv-cache-friendly-context-layout.md):
 * the queue-tail META block (`[META] 本轮动态上下文...`, see
 * SystemPromptBuilder.ts `META_BLOCK_HEADER`) is a per-turn, throwaway
 * artifact. It must NEVER be written into ThreadStore / message storage, and
 * must NEVER enter transcript, summary, thread-memory, or session-seal
 * output. The exclusion has to happen on the INGESTION side of the
 * compression pipeline (AutoSummarizer / SessionSealer / TranscriptWriter /
 * buildThreadMemory) — not as post-hoc cleanup.
 *
 * This module is the single shared implementation those four modules import,
 * so the stripping rule (and the marker it keys off) lives in exactly one
 * place. It deliberately has ZERO dependencies beyond the marker constant
 * itself, so importing it does not pull in the (large, actively-edited)
 * SystemPromptBuilder module graph.
 */

import { META_BLOCK_HEADER } from './SystemPromptBuilder.js';

export { META_BLOCK_HEADER };

/**
 * Strip META-tagged paragraph segments from a text blob before it enters any
 * persistence / summary / memory ingestion pipeline (D3 invariant).
 *
 * A "segment" is a blank-line-delimited paragraph (ADR-024 D3: "输入快照里凡带
 * META_BLOCK_HEADER 标记的段落在摄入前剔除"). Only paragraphs that contain the
 * marker are dropped; sibling paragraphs are preserved byte-for-byte. This
 * covers both the expected case (a whole message IS the meta echo, i.e. a cat
 * mistakenly replied by quoting/repeating the meta block — ADR-024 风险 #2)
 * and defensive cases where the marker shows up embedded inside a larger blob.
 *
 * Idempotent and safe on falsy/empty input.
 */
export function stripMetaBlockSegments(text: string | null | undefined): string {
  if (!text) return text ?? '';
  if (!text.includes(META_BLOCK_HEADER)) return text;

  const paragraphs = text.split('\n\n');
  const kept = paragraphs.filter((p) => !p.includes(META_BLOCK_HEADER));
  return kept.join('\n\n');
}

/** True if the text contains the META block marker anywhere. */
export function containsMetaBlockMarker(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.includes(META_BLOCK_HEADER);
}

/**
 * Filter an array of short free-text strings (decisions / open questions /
 * artifact refs / summary lines, ...), dropping any entry that carries the
 * META marker. Unlike `stripMetaBlockSegments`, entries here are treated as
 * atomic (a single sentence/line), not as multi-paragraph blobs — so a tagged
 * entry is dropped whole rather than partially redacted.
 */
export function dropMetaTaggedEntries<T extends string>(entries: readonly T[] | undefined): T[] {
  if (!entries || entries.length === 0) return entries ? [...entries] : [];
  return entries.filter((entry) => !containsMetaBlockMarker(entry));
}
