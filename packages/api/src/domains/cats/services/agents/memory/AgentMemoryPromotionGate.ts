/**
 * 票C (P1-4) — Memory promotion review gate.
 *
 * Problem: successful agent output was auto-written into durable agent memory
 * (.cat-cafe/memory/{catId}.md) with NO promotion review — no source grading,
 * no fact/preference classification, no conflict detection, no user/reviewer
 * approval. One wrong output → durable memory → next static prompt → error
 * amplified (closed-loop self-pollution).
 *
 * Gate modes (CAT_CAFE_MEMORY_PROMOTION_MODE, default off — zero behavior change):
 *  - off:     legacy behavior, auto-writer writes straight to durable memory.
 *  - shadow:  evaluate every write and attach the would-be decision to the
 *             result + decision metric, but write exactly as today
 *             (observe-first, same discipline as 票A capability receipt gate).
 *  - enforce: auto-writer output goes to a per-cat CANDIDATE QUEUE
 *             (.cat-cafe/memory/candidates/{catId}.jsonl, status pending_review)
 *             instead of durable memory. Only explicit user instructions
 *             ("记住：…") fast-track, recorded with reviewer=user. Conflicts
 *             and contradictions are HELD — existing memory keeps serving.
 *
 * Promotion criteria (v1, deterministic heuristics — deliberately simple and
 * auditable; extend CONFLICT RULES below rather than adding cleverness):
 *  1. Source grade:   user-stated (explicit "记住：…" in the raw user message)
 *                     > observed-behavior (grounded task report) > model-guess
 *                     (hedged, unsourced: 大概/可能/也许/…).
 *  2. Content class:  fact | preference | session-temp. Session-temp content
 *                     (本次会话/临时/仅暂存…) is never durable.
 *  3. Conflict check: same-key contradiction with existing durable memory →
 *                     HOLD, never auto-overwrite. Closed-decision contradictions
 *                     always hold (flagged), even for user-stated sources —
 *                     reopening a closed decision needs a human; the user can
 *                     edit the memory file directly.
 *  4. Confidence:     low-confidence unsourced guesses are dropped (not even
 *                     queued); medium/high confidence clean content becomes a
 *                     pending_review candidate.
 *  5. Dedup:          content already present in durable memory or already
 *                     queued does not create duplicates.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { STATUS } from '../../../../../infrastructure/telemetry/genai-semconv.js';
import { memoryPromotionGateDecisions } from '../../../../../infrastructure/telemetry/instruments.js';
import { findMonorepoRoot } from '../../../../../utils/monorepo-root.js';
import { getAgentMemoryDir } from './AgentMemoryStore.js';

const log = createModuleLogger('agent-memory-promotion-gate');

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

export type MemoryPromotionMode = 'off' | 'shadow' | 'enforce';

export function resolveMemoryPromotionMode(env: NodeJS.ProcessEnv = process.env): MemoryPromotionMode {
  const raw = (env.CAT_CAFE_MEMORY_PROMOTION_MODE ?? '').trim().toLowerCase();
  // Unknown values fail safe to OFF (legacy behavior), never to enforce —
  // a typo must not silently start holding memory writes.
  if (raw === 'shadow' || raw === 'enforce') return raw;
  return 'off';
}

// ---------------------------------------------------------------------------
// Evaluation types
// ---------------------------------------------------------------------------

export type MemoryPromotionAction = 'promote' | 'candidate' | 'hold' | 'skip';
export type MemoryPromotionSkipReason = 'duplicate' | 'low_confidence' | 'session_temp';
export type MemorySourceGrade = 'user-stated' | 'observed-behavior' | 'model-guess';
export type MemoryContentClass = 'fact' | 'preference' | 'session-temp';
export type MemoryConfidence = 'high' | 'medium' | 'low';

export interface MemoryPromotionConflict {
  readonly kind: 'closed-decision' | 'fact' | 'preference';
  /** Conflict key, e.g. 'port' | 'brevity' | '<closed decision snippet>'. */
  readonly key: string;
  /** The existing durable-memory line that contradicts the candidate. */
  readonly existingLine: string;
  /** True when a human must look at this (closed-decision contradictions). */
  readonly flagged: boolean;
}

export interface MemoryPromotionEvaluation {
  readonly action: MemoryPromotionAction;
  readonly sourceGrade: MemorySourceGrade;
  readonly contentClass: MemoryContentClass;
  readonly confidence: MemoryConfidence;
  readonly skipReason?: MemoryPromotionSkipReason;
  readonly conflict?: MemoryPromotionConflict;
  /** Set on fast-tracked promotions: who approved (always 'user' in v1). */
  readonly reviewer?: 'user';
  /** Trace of matched rules, for shadow-mode observability and review. */
  readonly rules: readonly string[];
}

export interface MemoryPromotionInput {
  /** Candidate content (one-line summary text, WITHOUT the delivery prefix). */
  readonly candidateText: string;
  /** Current durable memory file content ('' when no memory file exists). */
  readonly existingMemory: string;
  /** Raw user message text, when available — grounds user-stated grading. */
  readonly userMessageText?: string | undefined;
  /** Contents already sitting in the candidate queue (dedup baseline). */
  readonly queuedContents?: readonly string[];
}

// ---------------------------------------------------------------------------
// Candidate queue (JSONL ledger, per cat)
// ---------------------------------------------------------------------------

export interface MemoryCandidateRecord {
  readonly id: string;
  readonly catId: string;
  readonly invocationId: string;
  readonly threadId: string;
  /** Full delivery line as it would have been written to durable memory. */
  readonly content: string;
  readonly evaluation: MemoryPromotionEvaluation;
  readonly status: 'pending_review' | 'promoted';
  readonly reviewer?: 'user';
  readonly createdAt: number;
}

function assertSafeCatId(catId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(catId)) {
    throw new Error(`Invalid catId "${catId}"`);
  }
}

export function getMemoryCandidatesDir(projectRoot = findMonorepoRoot()): string {
  return join(getAgentMemoryDir(projectRoot), 'candidates');
}

export function getMemoryCandidatesPath(catId: string, projectRoot = findMonorepoRoot()): string {
  assertSafeCatId(catId);
  return join(getMemoryCandidatesDir(projectRoot), `${catId}.jsonl`);
}

export async function appendMemoryCandidate(
  record: MemoryCandidateRecord,
  projectRoot = findMonorepoRoot(),
): Promise<void> {
  const path = getMemoryCandidatesPath(record.catId, projectRoot);
  await mkdir(getMemoryCandidatesDir(projectRoot), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf-8');
}

export async function listMemoryCandidates(
  catId: string,
  projectRoot = findMonorepoRoot(),
): Promise<MemoryCandidateRecord[]> {
  const path = getMemoryCandidatesPath(catId, projectRoot);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return [];
  }
  const records: MemoryCandidateRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as MemoryCandidateRecord);
    } catch {
      log.warn({ catId, path }, 'skipping corrupt memory candidate line');
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// Heuristics (v1 rule table — deterministic, documented, extensible)
// ---------------------------------------------------------------------------

const USER_INSTRUCTION_RE = /(?:^|[\s，。;；])(?:请?记住|记下|给我记住)\s*[:：]/;
const HEDGING_RE = /大概|可能|也许|猜测|疑似|说不定|应该是/;
const SOURCE_MARK_RE = /用户(?:说|要求|明确|指令|纠正)|铲屎官(?:说|要求)/;
const SESSION_TEMP_RE = /本次会话|仅?临时|仅?暂存|session[- ]only|仅用于本轮|本轮(?:计算|会话)/i;
const PREFERENCE_RE = /偏好|喜欢|风格|简短|简洁|详细|格式|语气|以后|默认/;
const NEGATION_RE = /不|勿|禁止|别再|取消|撤销/;

function countNegations(text: string): number {
  const matches = text.match(new RegExp(NEGATION_RE.source, 'g'));
  return matches ? matches.length : 0;
}

/** Strip negation + punctuation + whitespace so polarity-free topic bigrams remain. */
function normalizeTopic(text: string): string {
  return text
    .replace(new RegExp(NEGATION_RE.source, 'g'), '')
    .replace(/[\s`*_#>，。：:；;、.!?？!（）()\-—/]/g, '')
    .toLowerCase();
}

function bigrams(text: string): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i < text.length - 1; i += 1) {
    grams.add(text.slice(i, i + 2));
  }
  return grams;
}

/** Jaccard similarity over char bigrams of polarity-free topic text. */
export function topicSimilarity(a: string, b: string): number {
  const ga = bigrams(normalizeTopic(a));
  const gb = bigrams(normalizeTopic(b));
  if (ga.size === 0 || gb.size === 0) return 0;
  let intersection = 0;
  for (const gram of ga) {
    if (gb.has(gram)) intersection += 1;
  }
  return intersection / (ga.size + gb.size - intersection);
}

/** Extract port numbers from lines that talk about ports. */
function extractPorts(text: string): Set<string> {
  const ports = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!/端口|port/i.test(line)) continue;
    for (const match of line.matchAll(/\b(\d{4,5})\b/g)) {
      ports.add(match[1] ?? '');
    }
  }
  ports.delete('');
  return ports;
}

interface MemorySection {
  heading: string;
  lines: string[];
}

/** Minimal section extractor for the durable memory markdown format. */
export function extractMemorySections(memory: string): MemorySection[] {
  const sections: MemorySection[] = [];
  let current: MemorySection | null = null;
  for (const line of memory.split(/\r?\n/)) {
    const headingMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headingMatch) {
      current = { heading: headingMatch[1] ?? '', lines: [] };
      sections.push(current);
      continue;
    }
    if (current && line.trim()) current.lines.push(line.trim());
  }
  return sections;
}

function findClosedDecisionConflict(candidate: string, existingMemory: string): MemoryPromotionConflict | null {
  const closed = extractMemorySections(existingMemory).find((section) => section.heading.includes('已关闭决策'));
  if (!closed) return null;
  const candidateNegations = countNegations(candidate);
  for (const line of closed.lines) {
    const body = line.replace(/^-\s*/, '');
    const similarity = topicSimilarity(candidate, body);
    if (similarity < 0.5) continue;
    // Same topic — polarity flip (negation parity differs) means contradiction.
    if ((countNegations(body) + candidateNegations) % 2 === 1) {
      return { kind: 'closed-decision', key: body.slice(0, 40), existingLine: body, flagged: true };
    }
  }
  return null;
}

function findPortConflict(candidate: string, existingMemory: string): MemoryPromotionConflict | null {
  const candidatePorts = extractPorts(candidate);
  if (candidatePorts.size === 0) return null;
  for (const line of existingMemory.split(/\r?\n/)) {
    if (!/端口|port/i.test(line)) continue;
    const linePorts = extractPorts(line);
    if (linePorts.size === 0) continue;
    const disjoint = [...candidatePorts].every((port) => !linePorts.has(port));
    if (disjoint) {
      return { kind: 'fact', key: 'port', existingLine: line.trim(), flagged: false };
    }
  }
  return null;
}

const EXISTING_BREVITY_RE = /(?:消息|回复|报告)[^。\n]{0,12}(?:简短|简洁|要短)/;
const CANDIDATE_VERBOSE_RE = /(?:长|详细|深度|完整)[^。\n]{0,6}(?:报告|回复|消息)|(?:报告|回复|消息)[^。\n]{0,12}(?:要|需要|要求)[^。\n]{0,6}(?:长|详细)/;

function findBrevityConflict(candidate: string, existingMemory: string): MemoryPromotionConflict | null {
  if (!CANDIDATE_VERBOSE_RE.test(candidate)) return null;
  for (const line of existingMemory.split(/\r?\n/)) {
    if (EXISTING_BREVITY_RE.test(line)) {
      return { kind: 'preference', key: 'brevity', existingLine: line.trim(), flagged: false };
    }
  }
  return null;
}

function classifyContent(candidate: string): MemoryContentClass {
  if (SESSION_TEMP_RE.test(candidate)) return 'session-temp';
  if (PREFERENCE_RE.test(candidate)) return 'preference';
  return 'fact';
}

function normalizeForDedup(text: string): string {
  return text
    .replace(/[\s`*_#>，。：:；;、.!?？!（）()\-—/]/g, '')
    .toLowerCase();
}

/**
 * Pure promotion evaluation. Decision order (first match wins):
 *   1. session-temp        → skip (never durable)
 *   2. duplicate           → skip (dedup vs durable memory + queue)
 *   3. closed-decision     → hold + flagged (always, even user-stated)
 *   4. user-stated         → promote (fast-track, reviewer=user; fact/preference
 *                            conflicts are recorded on the evaluation but the
 *                            explicit user directive wins)
 *   5. fact/pref conflict  → hold
 *   6. low confidence      → skip (unsourced model guess, dropped)
 *   7. otherwise           → candidate (pending review)
 */
export function evaluateMemoryPromotion(input: MemoryPromotionInput): MemoryPromotionEvaluation {
  const rules: string[] = [];
  const candidate = input.candidateText.trim();
  const contentClass = classifyContent(candidate);
  const userStated = Boolean(input.userMessageText && USER_INSTRUCTION_RE.test(input.userMessageText));
  const hedged = HEDGING_RE.test(candidate) && !SOURCE_MARK_RE.test(candidate) && !userStated;
  const sourceGrade: MemorySourceGrade = userStated ? 'user-stated' : hedged ? 'model-guess' : 'observed-behavior';
  const confidence: MemoryConfidence = userStated ? 'high' : hedged ? 'low' : 'medium';

  const base = { sourceGrade, contentClass, confidence };

  // 1. Session temp vars are never durable.
  if (contentClass === 'session-temp') {
    rules.push('session-temp');
    return { ...base, action: 'skip', skipReason: 'session_temp', rules };
  }

  // 2. Dedup against durable memory and the pending queue.
  // Per-entry comparison, not whole-blob substring: a candidate embedded in a
  // longer entry is a duplicate only when the extra characters are wrapper
  // decoration (message/invocation prefix, date). Extra negation characters
  // (不/无/没/未/别/禁/勿) flip polarity — '恢复 X' inside '不恢复 X' is a
  // contradiction to be held (rule 3), never a duplicate.
  const DEDUP_NEGATION_RE = /[不无没未别禁勿]/;
  const needle = normalizeForDedup(candidate);
  const isDuplicateOf = (existing: string): boolean =>
    existing
      .split(/\r?\n/)
      .map((line) => normalizeForDedup(line))
      .some((entry) => {
        if (!entry) return false;
        if (entry === needle) return true;
        if (!entry.includes(needle)) return false;
        const extra = entry.split(needle).join('');
        return !DEDUP_NEGATION_RE.test(extra);
      });
  if (needle) {
    if (isDuplicateOf(input.existingMemory)) {
      rules.push('dedup:durable');
      return { ...base, action: 'skip', skipReason: 'duplicate', rules };
    }
    for (const queued of input.queuedContents ?? []) {
      if (isDuplicateOf(queued)) {
        rules.push('dedup:queue');
        return { ...base, action: 'skip', skipReason: 'duplicate', rules };
      }
    }
  }

  // 3. Closed-decision contradictions always hold + flagged.
  const closedConflict = findClosedDecisionConflict(candidate, input.existingMemory);
  if (closedConflict) {
    rules.push('conflict:closed-decision');
    return { ...base, action: 'hold', conflict: closedConflict, rules };
  }

  // 4. Explicit user instruction fast-tracks (reviewer=user recorded).
  if (userStated) {
    rules.push('fast-track:user-stated');
    const factConflict = findPortConflict(candidate, input.existingMemory);
    const prefConflict = factConflict ?? findBrevityConflict(candidate, input.existingMemory);
    if (prefConflict) rules.push(`conflict-overridden-by-user:${prefConflict.key}`);
    return {
      ...base,
      action: 'promote',
      reviewer: 'user',
      ...(prefConflict ? { conflict: prefConflict } : {}),
      rules,
    };
  }

  // 5. Fact/preference contradictions hold — never auto-overwrite.
  const portConflict = findPortConflict(candidate, input.existingMemory);
  if (portConflict) {
    rules.push('conflict:port');
    return { ...base, action: 'hold', conflict: portConflict, rules };
  }
  const brevityConflict = findBrevityConflict(candidate, input.existingMemory);
  if (brevityConflict) {
    rules.push('conflict:brevity');
    return { ...base, action: 'hold', conflict: brevityConflict, rules };
  }

  // 6. Unsourced hedged guesses are dropped, not even queued.
  if (confidence === 'low') {
    rules.push('low-confidence:unsourced-guess');
    return { ...base, action: 'skip', skipReason: 'low_confidence', rules };
  }

  // 7. Clean, medium/high confidence content → candidate queue.
  rules.push('candidate:pending-review');
  return { ...base, action: 'candidate', rules };
}

// ---------------------------------------------------------------------------
// Decision metric (bounded labels: mode × action)
// ---------------------------------------------------------------------------

export function recordPromotionDecision(mode: MemoryPromotionMode, evaluation: MemoryPromotionEvaluation): void {
  try {
    memoryPromotionGateDecisions.add(1, { mode, [STATUS]: evaluation.action });
  } catch {
    // Telemetry must never break the gate.
  }
}
