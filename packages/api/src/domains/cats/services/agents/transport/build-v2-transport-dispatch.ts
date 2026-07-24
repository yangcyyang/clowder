/**
 * ADR-024 W1-B: route-side four-slot assembly.
 *
 * Given the pieces both routes already compute (static-identity options, the
 * per-turn InvocationContext, session-stable instruction blocks, history text,
 * and the current user message), produce the four-slot `TransportPayload` and the
 * derived string channels (`systemPrompt` + `-p` body) used by the invocation path.
 *
 * Slot assignment (see report / prompt-cache-class.ts):
 *   - system  : static identity (memory/lessons/project OMITTED) + F042 Identity line
 *   - history : catModePrompt + session bootstrap + mcp callback instructions + conversation history
 *   - meta    : per-turn volatile body + memory/lessons/project (relocated from static, D1)
 *   - userMsg : current user / A2A trigger message
 *
 * The `-p` body is strictly history → meta → userMsg (meta 不得在 userMsg 之后).
 */

import type { CatId } from '@cat-cafe/shared';
import {
  buildInvocationIdentityLine,
  buildStaticIdentity,
  buildTurnMetaBlock,
  type InvocationContext,
  type StaticIdentityOptions,
} from '../../context/SystemPromptBuilder.js';
import {
  assembleTransportPayload,
  renderTransportPromptBody,
  SLOT_SEPARATOR,
  type TransportPayload,
} from './assemble-transport-payload.js';

export interface V2TransportDispatchInput {
  readonly catId: CatId;
  /** The per-turn context — MUST already carry contextUsageWarning if one fired this turn. */
  readonly context: InvocationContext;
  /** Same static-identity options used for the v1 build (cacheLayout is forced to 'v2' here). */
  readonly staticIdentityOptions: StaticIdentityOptions;
  /** Mode system prompt for this cat (session-stable) → history slot. */
  readonly catModePrompt?: string | undefined;
  /** Session #2+ bootstrap continuity digest (session-stable) → history slot. */
  readonly sessionBootstrap?: string | undefined;
  /** HTTP callback fallback instructions (session-stable) → history slot. */
  readonly mcpInstructions?: string | undefined;
  /** Assembled conversation history / context text → history slot. */
  readonly historyText?: string | undefined;
  /** Current user / A2A trigger message → userMsg slot. */
  readonly userMsg: string;
  /** Session-writable blocks relocated to the META slot (D1). */
  readonly agentMemoryContext?: string | null;
  readonly lessonsContext?: string | null;
  readonly projectContext?: string | null;
  readonly maxPromptTokens?: number;
  /**
   * ADR-024 §2.6: pre-formatted "收件箱" summary for the [Agent Status] bar — see
   * route-helpers.ts formatInboxSnapshotSummary(intentSnapshot). Optional: route-serial/
   * route-parallel wire this in once unfrozen (see W2-C report); renders "无" until then.
   */
  readonly inboxSnapshotSummary?: string | null;
  /**
   * ADR-024 D4: per-turn volatile B-layer transport content (evidence, coverageMap,
   * navigationHeader, [Agent Inbox Snapshot]) relocated out of `contextText` by
   * assembleSmartWindowContext (IncrementalContextResult.metaTransportText).
   * Appended after the turn-meta block inside the META slot. Empty/absent on the
   * legacy (non-smart-window) path — that path never produced these blocks per-turn.
   */
  readonly metaTransportText?: string | null;
}

export interface V2TransportDispatch {
  /** system slot → provider system channel (Claude: --append-system-prompt). */
  readonly systemPrompt: string;
  /** `-p` body: history → meta → userMsg. */
  readonly promptBody: string;
  /** The structured four-slot payload for adapters that map slots directly. */
  readonly transportPayload: TransportPayload;
}

export function buildV2TransportDispatch(input: V2TransportDispatchInput): V2TransportDispatch {
  // system slot: static identity WITHOUT memory/lessons/project (they move to meta),
  // then the F042 Identity line pinned into system (D1 明文例外).
  const systemStatic = buildStaticIdentity(input.catId, {
    ...input.staticIdentityOptions,
    cacheLayout: 'v2',
  });
  const identityLine = buildInvocationIdentityLine(input.context);
  const system = [systemStatic, identityLine].filter((s) => s && s.length > 0).join(SLOT_SEPARATOR);

  // meta slot: per-turn volatile body + relocated session-writable reference context,
  // followed by the relocated B-layer transport products (D4, W2-C wiring).
  const turnMetaBlock = buildTurnMetaBlock(input.context, {
    agentMemoryContext: input.agentMemoryContext,
    lessonsContext: input.lessonsContext,
    projectContext: input.projectContext,
    inboxSnapshotSummary: input.inboxSnapshotSummary,
    ...(input.maxPromptTokens !== undefined ? { maxPromptTokens: input.maxPromptTokens } : {}),
  });
  const meta = [turnMetaBlock, input.metaTransportText]
    .filter((s): s is string => !!s && s.length > 0)
    .join(SLOT_SEPARATOR);

  // history slot: session-stable instruction blocks ahead of the real conversation,
  // preserving their existing relative order (mode → bootstrap → mcp → history).
  const history = [input.catModePrompt, input.sessionBootstrap, input.mcpInstructions, input.historyText]
    .filter((s): s is string => !!s && s.length > 0)
    .join(SLOT_SEPARATOR);

  const transportPayload = assembleTransportPayload({
    system,
    history,
    meta,
    userMsg: input.userMsg,
  });

  return {
    systemPrompt: system,
    promptBody: renderTransportPromptBody(transportPayload),
    transportPayload,
  };
}
