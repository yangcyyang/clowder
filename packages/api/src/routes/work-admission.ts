import type { CatId } from '@cat-cafe/shared';
import { redactSecretsInText } from '../utils/env-var-secret-guard.js';

export interface PendingPlanContext {
  messageId: string;
  title: string;
}

export type WorkAdmissionDecision =
  | {
      kind: 'create_from_message';
      taskTitle: string;
      ownerCatId?: CatId;
      /** as_task_explicit: F194 §3 step 3 — user checked "As Task", bypassing classifyWorkAdmission entirely. */
      reason: 'explicit_action' | 'line_leading_mention_action' | 'as_task_explicit';
    }
  | {
      kind: 'resume_pending_plan';
      pendingPlanMessageId: string;
      taskTitle: string;
      ownerCatId?: CatId;
      reason: 'approval_with_pending_plan';
    }
  | { kind: 'reply_only'; reason: string };

export interface WorkAdmissionInput {
  content: string;
  targetCatIds?: readonly CatId[];
  pendingPlan?: PendingPlanContext;
}

const QUESTION_DOMINANT_RE = /[?？]\s*$|^(?:是否|为什么|为何|如何|怎么|怎样|什么|哪(?:个|些)|谁|能否|可否)/i;
const DISCUSSION_RE =
  /^(?:需要.*)?(?:探讨|讨论|聊聊)|(?:先讨论|有个想法|我在想|看看你怎么想|你怎么看|你觉得|有什么建议|要不要)/i;
const STATUS_QUERY_RE = /^(?:做好了吗|完成了吗|进度|怎么样了|还有多久)[？?。！!\s]*$/i;
const PROBLEM_REPORT_RE = /^(?:我发现|发现|有个报错|有一个报错|这里报错|.+不见了|.+坏了)/i;
const MEMORY_ONLY_RE = /^(?:记一下|记住|备忘|提醒我)[：:，,\s]/i;
const DELAY_RE = /^(?:明天|之后|以后|晚点|回头).*(?:再说|再看|再处理)/i;
const CONDITION_RE = /^(?:如果|假如|倘若|等.+(?:后|再)|待.+(?:后|再)|只要|除非)/i;
const REPORTED_SPEECH_RE = /^(?:老板|领导|客户|用户|Claude|Codex|他|她|他们).{0,16}(?:说|让|要求|提到|表示)/i;
const NEGATION_RE = /^(?:先别|别急|不要|不需要|暂停|停止|先不|暂不|别).{0,24}(?:做|改|修|建|部署|执行|推进|处理|创建)?/i;
const ACK_ONLY_RE = /^(?:收到|谢谢|辛苦了|好的|好)[。！!\s]*$/i;
const APPROVAL_RE =
  /^(?:确认|可以|同意|就这个|你来推进(?:哈|吧)?|按照你(?:的)?排期来|就按第?\s*\d+\s*个?方案做|就按.+方案做|直接拍\s*[A-ZＡ-Ｚ]|拍\s*[A-ZＡ-Ｚ]|按这个(?:做)?|开始吧|继续吧?)[。！!\s]*$/i;
const LINE_LEADING_MENTION_RE = /^\s*@[^\s，,：:]+\s+/u;
const DIRECT_ACTION_RE =
  /(?:^|[，,。；;！!\s])(?:开工|按这个做|安排|执行|你来推进|来做|去做|去查|修复|修一下|弄(?:一下|一个)|上线吧|部署|重启|清理|翻译|整理|写|查|检查|排查|导出|抓取|压缩|备份|review|跑一遍|默认打开|给.+配)|^(?:帮我|请)(?:把|做|改|修|建|部署|重启|清理|写|查|导出|翻译)|^把.+(?:清理|翻译|整理|打开|压缩|改|修|建|部署|重启|写|查|跑|导出|抓取)/i;

// F194 FP tightening: long pasted documents/excerpts (e.g. reference material, meeting notes)
// often contain an incidental action-shaped verb (e.g. "改") without being an instruction. A
// numbered-paragraph structure with no leading @mention is a strong signal of "pasted document,
// not a command" — bail out to reply_only before DIRECT_ACTION_RE gets a chance to match.
const LONG_STRUCTURED_DOCUMENT_LENGTH_THRESHOLD = 500;
const LEADING_MENTION_ANYWHERE_RE = /^\s*@/u;
// Matches a numbered-paragraph marker ("1. ", "12." ...) either at the true start of the
// message or right after sentence-level punctuation/whitespace — the latter also covers
// paragraphs whose original newlines were collapsed into spaces before reaching this classifier.
const NUMBERED_PARAGRAPH_MARKER_RE = /(?:^|[\s。！!])[1-9]\d?\.\s*(?=\S)/gu;

function isLongStructuredDocument(content: string): boolean {
  if (content.length <= LONG_STRUCTURED_DOCUMENT_LENGTH_THRESHOLD) return false;
  if (LEADING_MENTION_ANYWHERE_RE.test(content)) return false;
  const markers = content.match(NUMBERED_PARAGRAPH_MARKER_RE);
  return (markers?.length ?? 0) >= 2;
}

function normalizeTaskTitle(content: string): string {
  // B4: redact secret-shaped values before truncating so a mid-title API key
  // cannot survive as the first 80 chars of the task title (2026-06-28 leak).
  const redacted = redactSecretsInText(content);
  const normalized = redacted
    .replace(/^\s*(?:@[^\s，,：:]+\s+)+/u, '')
    .replace(/^\s*(?:请|帮我|你来)\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '执行用户指令';
  return normalized.length > 80 ? `${normalized.slice(0, 79)}…` : normalized;
}

function uniqueOwner(targetCatIds: readonly CatId[] | undefined): CatId | undefined {
  if (!targetCatIds?.length) return undefined;
  const unique = [...new Set(targetCatIds)];
  return unique.length === 1 ? unique[0] : undefined;
}

/**
 * F194 auto-task admission is intentionally stricter than the prompt-level
 * Agent Intent Snapshot. False negatives keep the existing manual task path;
 * false positives pollute the task board and route replies to the wrong place.
 */
export function classifyWorkAdmission(input: WorkAdmissionInput): WorkAdmissionDecision {
  const content = input.content.trim();
  if (!content) return { kind: 'reply_only', reason: 'empty' };

  const targetCatIds = [...new Set(input.targetCatIds ?? [])];
  const hasLineLeadingMention = LINE_LEADING_MENTION_RE.test(content);
  const actionContent = hasLineLeadingMention
    ? content.replace(/^\s*(?:@[^\s，,：:]+\s+)+/u, '').trim()
    : content;
  if (hasLineLeadingMention && targetCatIds.length > 1) {
    return { kind: 'reply_only', reason: 'ambiguous_owner' };
  }

  if (ACK_ONLY_RE.test(content)) return { kind: 'reply_only', reason: 'ack_only' };
  if (STATUS_QUERY_RE.test(content)) return { kind: 'reply_only', reason: 'status_query' };
  if (QUESTION_DOMINANT_RE.test(content)) return { kind: 'reply_only', reason: 'question' };
  if (DISCUSSION_RE.test(content)) return { kind: 'reply_only', reason: 'discussion' };
  if (MEMORY_ONLY_RE.test(content)) return { kind: 'reply_only', reason: 'memory_only' };
  if (DELAY_RE.test(content)) return { kind: 'reply_only', reason: 'delay' };
  if (CONDITION_RE.test(content)) return { kind: 'reply_only', reason: 'condition_not_met' };
  if (REPORTED_SPEECH_RE.test(content)) return { kind: 'reply_only', reason: 'reported_speech' };
  if (NEGATION_RE.test(content)) return { kind: 'reply_only', reason: 'negative_or_hold' };
  if (PROBLEM_REPORT_RE.test(content)) return { kind: 'reply_only', reason: 'problem_report' };

  if (APPROVAL_RE.test(content)) {
    if (!input.pendingPlan) return { kind: 'reply_only', reason: 'approval_without_pending_plan' };
    const ownerCatId = uniqueOwner(targetCatIds);
    return {
      kind: 'resume_pending_plan',
      pendingPlanMessageId: input.pendingPlan.messageId,
      taskTitle: input.pendingPlan.title,
      ...(ownerCatId ? { ownerCatId } : {}),
      reason: 'approval_with_pending_plan',
    };
  }

  if (isLongStructuredDocument(content)) {
    return { kind: 'reply_only', reason: 'long_structured_document' };
  }

  if (!DIRECT_ACTION_RE.test(actionContent)) return { kind: 'reply_only', reason: 'no_explicit_action' };

  const ownerCatId = uniqueOwner(targetCatIds);
  return {
    kind: 'create_from_message',
    taskTitle: normalizeTaskTitle(content),
    ...(ownerCatId ? { ownerCatId } : {}),
    reason: hasLineLeadingMention ? 'line_leading_mention_action' : 'explicit_action',
  };
}

/**
 * F194 §3 step 3: the "As Task" explicit-declaration entry point (Raft's
 * per-message checkbox — one of the three explicit-declaration entrances,
 * see docs/research/clowder-raft-thread-task-design.md §5.3). Unlike
 * classifyWorkAdmission, this never returns `reply_only` — the user already
 * declared intent, so no heuristic gets a veto. Reuses the same title
 * truncation/redaction (normalizeTaskTitle) and single-@mention owner
 * resolution (uniqueOwner) as the classifier path, so downstream admission
 * (admitWorkMessage) behaves identically either way.
 */
export function forceCreateFromMessage(input: WorkAdmissionInput): Extract<
  WorkAdmissionDecision,
  { kind: 'create_from_message' }
> {
  const content = input.content.trim();
  const targetCatIds = [...new Set(input.targetCatIds ?? [])];
  const ownerCatId = uniqueOwner(targetCatIds);
  return {
    kind: 'create_from_message',
    taskTitle: normalizeTaskTitle(content),
    ...(ownerCatId ? { ownerCatId } : {}),
    reason: 'as_task_explicit',
  };
}
