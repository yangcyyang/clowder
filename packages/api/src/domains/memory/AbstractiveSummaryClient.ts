/**
 * Phase G: Opus API client for generating abstractive summaries + durable candidates.
 *
 * Design: Opus outputs NATURAL LANGUAGE (what it's good at).
 * Program parses the output into structured segments (what code is good at).
 *
 * 铲屎官原话："我们就不能让他返回自然语言直接帮他加格式吗？格式就是程序加。"
 */

import { hasCanonicalSummaryRecallFields } from './SummaryRecallContract.js';

export interface AbstractiveInput {
  previousSummary: string | null;
  messages: Array<{ id: string; content: string; catId?: string; timestamp: number }>;
  threadId: string;
}

export interface TopicSegment {
  summary: string;
  topicKey: string;
  topicLabel: string;
  boundaryReason: string;
  boundaryConfidence: 'high' | 'medium' | 'low';
  fromMessageId: string;
  toMessageId: string;
  messageCount: number;
  relatedSegmentIds?: string[];
  candidates?: DurableCandidate[];
}

export interface DurableCandidate {
  kind: 'decision' | 'lesson' | 'method';
  title: string;
  claim: string;
  why_durable: string;
  evidence: Array<{ threadId: string; messageId: string; span: string }>;
  relatedAnchors: string[];
  confidence: 'explicit' | 'inferred';
}

export interface AbstractiveResult {
  segments: TopicSegment[];
}

export type AbstractiveFailureKind =
  | 'invalid_format'
  | 'provider_unavailable'
  | 'provider_error'
  | 'empty_response'
  | 'timeout';

export interface SummaryGenerationIdentity {
  providerId: SummaryProviderId;
  modelId: string;
  promptVersion: typeof SUMMARY_PROMPT_VERSION;
}

export type AbstractiveGenerationOutcome =
  | { kind: 'ok'; result: AbstractiveResult; attempts: 1 | 2; identity: SummaryGenerationIdentity }
  | {
      kind: AbstractiveFailureKind;
      attempts: 0 | 1 | 2;
      identity: SummaryGenerationIdentity;
      detail?: string;
    };

export const SUMMARY_PROMPT_VERSION = 'g2-thread-abstract-v2';

export type SummaryProviderId = 'anthropic-api' | 'codex-cli' | 'pi-cli';
export const DEFAULT_PI_SUMMARY_MODEL = 'mimo/mimo-v2.5-pro-ultraspeed';

interface ProviderProfile {
  mode: 'api_key' | 'subscription';
  baseUrl: string;
  apiKey: string;
}

export function getAbstractiveSummaryModelId(env: NodeJS.ProcessEnv = process.env): string {
  const providerId = getSummaryProviderId(env);
  if (providerId === 'codex-cli') {
    const catId = env.CAT_CAFE_SUMMARY_CODEX_CAT_ID?.trim() || 'gpt52';
    const model = env.CAT_CAFE_SUMMARY_CODEX_MODEL?.trim() || 'gpt-5.5';
    return `codex-cli:${catId}:${model}`;
  }
  if (providerId === 'pi-cli') {
    const catId = env.CAT_CAFE_SUMMARY_PI_CAT_ID?.trim() || 'pi';
    const model = env.CAT_CAFE_SUMMARY_PI_MODEL?.trim() || DEFAULT_PI_SUMMARY_MODEL;
    return `pi-cli:${catId}:${model}`;
  }
  return env.CAT_CAFE_SUMMARY_MODEL?.trim() || 'claude-3-5-haiku-latest';
}

function getAbstractiveSummaryMaxTokens(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.CAT_CAFE_SUMMARY_MAX_TOKENS ?? '', 10);
  if (!Number.isFinite(parsed)) return 4096;
  return Math.min(8192, Math.max(1024, parsed));
}

export function getSummaryProviderId(env: NodeJS.ProcessEnv = process.env): SummaryProviderId {
  const raw = env.CAT_CAFE_SUMMARY_PROVIDER?.trim().toLowerCase();
  if (raw === 'codex-cli') return 'codex-cli';
  if (raw === 'pi' || raw === 'pi-cli') return 'pi-cli';
  return 'anthropic-api';
}

function getAgentSummaryTimeoutMs(providerId: string, env: NodeJS.ProcessEnv = process.env): number {
  const envKey = providerId === 'pi-cli' ? 'CAT_CAFE_SUMMARY_PI_TIMEOUT_MS' : 'CAT_CAFE_SUMMARY_CODEX_TIMEOUT_MS';
  const parsed = Number.parseInt(env[envKey] ?? '', 10);
  if (!Number.isFinite(parsed)) return 90_000;
  return Math.min(300_000, Math.max(15_000, parsed));
}

function getApiSummaryTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.CAT_CAFE_SUMMARY_API_TIMEOUT_MS ?? '', 10);
  if (!Number.isFinite(parsed)) return 90_000;
  return Math.min(300_000, Math.max(15_000, parsed));
}

// ─── System Prompt: natural language output ──────────────────────
const SYSTEM_PROMPT = `You are a thread summarizer for Clowder AI, an AI-collaborative project management system.

IMPORTANT: You are a SUMMARIZER, not a conversation participant. Do NOT respond to the messages — summarize them.

Given a batch of thread messages, write a summary using this exact format:

# Title of what was discussed

## 当前状态/任务 (Current status)

The status as of the newest message_id included in this batch.

## 已确认决策/约束 (Decision/constraint)

Only decisions or constraints supported by the input.

## 下一步 (Next action)

The next action supported by the input.

## 风险/锚点 (Risk/anchor)

Risks, uncertainty, and the exact input message_id or message_id range to inspect for details.

## Durable Knowledge (if any)

[decision!] Short title — Use ! when the human explicitly confirmed or multiple cats reached consensus
[decision] Short title — Use plain tag when you infer this is durable but it was not explicitly confirmed
[lesson!] / [lesson] — Same convention: ! = human confirmed, plain = inferred
[method!] / [method] — Same convention

Rules:
- The # title line is REQUIRED
- All four recall sections are REQUIRED and together should be 200-400 characters
- Use the exact bilingual section labels above; do not rename or merge them
- Use only facts present in Previous Summary or Messages; never invent status, decisions, next steps, risks, or anchors
- If a field is absent, write "未从输入确认" / "Not confirmed by input" instead of guessing
- Treat Current status as the state at the summary watermark, not as knowledge of later messages
- Risk/anchor may cite only message_id values supplied in the input
- [decision], [lesson], [method] tags are OPTIONAL — only include if there's genuinely durable knowledge
- Add ! suffix (e.g. [decision!]) ONLY when the human/CVO explicitly confirmed the decision or lesson in the conversation
- Do NOT extract brainstorm branches, temporary TODOs, or session-local context
- Keep it concise — this is a summary, not a transcript
- Write in the same language as the messages (Chinese/English/mixed)
- Maximum 2 candidates per summary — if you find more, keep only the most durable ones

## Knowledge Admission Standards

Before tagging anything as [decision], [lesson], or [method], ask yourself these 3 questions.
If ANY answer is "no", do NOT extract it:
1. Would a new team member benefit from knowing this 3 months from now?
2. Does this hold true independent of the specific code/file/PR being discussed?
3. Can this prevent future repeated debates or repeated mistakes?

General rule: if it loses meaning outside the current file/PR/bug, it is NOT durable knowledge.

| Kind | MUST contain | MUST NOT be |
|------|-------------|-------------|
| decision | Choice rationale, tradeoffs, long-term constraint | A code change, debug step, or implementation detail |
| lesson | Recurrence risk, avoidance strategy | A one-time error, single incident symptom |
| method | Reusable principle applicable to other features | A one-off implementation technique |

BAD (do NOT extract these):
- [decision] Rewrote JSON parser to use parseNaturalLanguageOutput
- [decision] Added mkdirSync before writeFileSync to fix ENOENT
- [lesson] writeFileSync throws ENOENT when directory does not exist
- [lesson] regex needs !? suffix for optional exclamation mark
- [method] Used JSON.parse to extract candidates from summary_segments

GOOD (these ARE durable knowledge):
- [decision] Knowledge Feed uses YAML files as truth source, not SQLite — for git-trackability
- [decision!] Entry point hierarchy follows usage frequency: high-freq exposed, low-freq nested
- [lesson!] Fail-open catch blocks must log errors, not silently swallow — silent failures cause "looks OK but actually empty" bugs
- [method] Let the model output natural language; program adds structural fields afterward`;

// ─── Build user prompt ──────────────────────────────────────────
function buildUserPrompt(input: AbstractiveInput): string {
  const parts: string[] = [];

  parts.push('Summarize the following thread messages.\n');

  if (input.previousSummary) {
    parts.push(`## Previous Summary\n${input.previousSummary}\n`);
  }

  parts.push(`## Messages\n`);
  const MAX_MSG_CHARS = 1000;
  const MAX_TOTAL_CHARS = 80000;
  let totalChars = 0;
  for (const msg of input.messages) {
    const speaker = msg.catId ?? 'user';
    const time = new Date(msg.timestamp).toISOString().slice(0, 19);
    const content = msg.content.length > MAX_MSG_CHARS ? `${msg.content.slice(0, MAX_MSG_CHARS)}...` : msg.content;
    const line = `[message_id=${msg.id}] [${time}] [${speaker}]: ${content}`;
    totalChars += line.length;
    if (totalChars > MAX_TOTAL_CHARS) {
      parts.push(`[... ${input.messages.length} total messages, truncated]`);
      break;
    }
    parts.push(line);
  }

  return parts.join('\n');
}

function buildRepairPrompt(originalPrompt: string, invalidOutput: string): string {
  return [
    originalPrompt,
    '',
    '## Format Repair',
    'The previous response was rejected because it did not satisfy the exact summary format.',
    'Repair the response using only the original input. Return the complete summary, not an explanation.',
    'All four required recall sections must have a non-empty value.',
    '',
    '## Rejected Response',
    invalidOutput.slice(0, 12_000),
  ].join('\n');
}

type TextGenerationOutcome =
  | { kind: 'ok'; text: string }
  | { kind: Exclude<AbstractiveFailureKind, 'invalid_format'>; detail?: string };

function parseGeneratedSummary(text: string, input: AbstractiveInput): AbstractiveResult | null {
  const result = parseNaturalLanguageOutput(text, input);
  if (!result) return null;
  return result.segments.every((segment) => hasCanonicalSummaryRecallFields(segment.summary)) ? result : null;
}

async function generateWithSingleRepair(
  input: AbstractiveInput,
  requestText: (prompt: string) => Promise<TextGenerationOutcome>,
  logger: { info: (msg: string) => void; error: (msg: string, err?: unknown) => void },
  logPrefix: string,
  identity: SummaryGenerationIdentity,
): Promise<AbstractiveGenerationOutcome> {
  const originalPrompt = buildUserPrompt(input);
  const first = await requestText(originalPrompt);
  if (first.kind !== 'ok') return { ...first, attempts: 1, identity };

  const firstResult = parseGeneratedSummary(first.text, input);
  if (firstResult) {
    logger.info(
      `${logPrefix} parsed: "${firstResult.segments[0]?.topicLabel}" (${firstResult.segments[0]?.summary.length} chars, ${firstResult.segments[0]?.candidates?.length ?? 0} candidates)`,
    );
    return { kind: 'ok', result: firstResult, attempts: 1, identity };
  }

  logger.info(`${logPrefix} invalid format; attempting one repair`);
  const repaired = await requestText(buildRepairPrompt(originalPrompt, first.text));
  if (repaired.kind !== 'ok') return { ...repaired, attempts: 2, identity };

  const repairedResult = parseGeneratedSummary(repaired.text, input);
  if (!repairedResult) {
    logger.info(`${logPrefix} repair still invalid`);
    return {
      kind: 'invalid_format',
      attempts: 2,
      identity,
      detail: 'repair output still violates recall contract',
    };
  }

  logger.info(
    `${logPrefix} repaired and parsed: "${repairedResult.segments[0]?.topicLabel}" (${repairedResult.segments[0]?.summary.length} chars, ${repairedResult.segments[0]?.candidates?.length ?? 0} candidates)`,
  );
  return { kind: 'ok', result: repairedResult, attempts: 2, identity };
}

// ─── Parse natural language output into structured segments ─────
/** @internal Exported for testing only */
export function parseNaturalLanguageOutput(text: string, input: AbstractiveInput): AbstractiveResult | null {
  if (!text || text.trim().length < 10) return null;

  // Extract title: first line starting with # or ## or ### or **bold title**
  const titleMatch = text.match(/^#{1,3}\s+(.+)$/m) || text.match(/^\*\*(.+?)\*\*/m);
  let topicLabel: string;
  let titleEnd: number;

  if (titleMatch) {
    topicLabel = titleMatch[1].trim();
    titleEnd = text.indexOf(titleMatch[0]) + titleMatch[0].length;
  } else {
    // Fallback: use first non-empty line as title, or generate from thread ID
    const firstLine = text.trim().split('\n')[0]?.trim();
    topicLabel =
      firstLine && firstLine.length > 5 && firstLine.length < 200
        ? firstLine.replace(/^[-*>\s]+/, '').slice(0, 80)
        : `Thread ${input.threadId.slice(7, 19)} Summary`;
    titleEnd = firstLine ? text.indexOf(firstLine) + firstLine.length : 0;
  }

  const topicKey = topicLabel
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

  // Extract summary: text between title and [decision!?]/[lesson!?]/[method!?] or end
  const candidateStart = text.search(/\n##\s+Durable|\n\[(decision|lesson|method)!?\]/i);
  const summaryText =
    candidateStart > titleEnd ? text.slice(titleEnd, candidateStart).trim() : text.slice(titleEnd).trim();

  // Preserve recall section labels as plain-text fields. The delivery-only
  // consumer validates these labels before replacing raw history.
  const summary = summaryText
    .split('\n')
    .map((line) => {
      const heading = line.match(/^#{1,6}\s+(.+)$/);
      return heading ? `${heading[1].trim()}：` : line.trim().replace(/[ \t]+/g, ' ');
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 800);

  // If no summary extracted, use the whole text as summary
  if (!summary) {
    const fallback = text
      .replace(/^#{1,3}\s+.+$/m, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 800);
    if (!fallback) return null;
    return buildSingleSegment(topicLabel, topicKey, fallback, [], input);
  }

  // Extract candidates: [decision], [lesson], [method] tags
  const candidates = extractCandidates(text, input);
  return buildSingleSegment(topicLabel, topicKey, summary, candidates, input);
}

// Reject gate: candidates that are implementation details, not durable knowledge
const CODE_ACTION_RE =
  /^(加了?|改了?|删除?了?|重写|修复|调整|更新|移除|添加|replaced|rewrote|added|removed|changed|fixed|updated|moved)[\s\u4e00-\u9fff]/i;
const CODE_ARTIFACT_RE =
  /\b(regex|parser|schema|route|component|endpoint|middleware|handler|migration|refactor|writeFile|readFile|mkdir|JSON\.parse|tsc|lint)\b/i;
const FILE_EXT_RE = /\w+\.(tsx?|jsx?|mjs|cjs)\b/;
const CODE_IDENT_RE = /\b[a-z]+[A-Z]\w*/;
const MIN_TITLE_LENGTH = 8;

/** @internal Exported for testing only */
export function isImplementationNoise(title: string, claim: string): boolean {
  const text = `${title} ${claim}`;
  if (title.length < MIN_TITLE_LENGTH) return true;
  if (CODE_ACTION_RE.test(title)) return true;
  if (FILE_EXT_RE.test(title)) return true;
  if (CODE_IDENT_RE.test(title)) return true;
  // If title+claim contain multiple code artifacts, reject
  const artifactHits = (text.match(new RegExp(CODE_ARTIFACT_RE.source, 'gi')) || []).length;
  return artifactHits >= 2;
}

/** @internal Exported for testing only */
export const MAX_CANDIDATES_PER_SEGMENT = 2;

function extractCandidates(text: string, input: AbstractiveInput): DurableCandidate[] {
  const candidates: DurableCandidate[] = [];
  // Match [decision!] (explicit) or [decision] (inferred) — the ! suffix signals human confirmation
  const candidateRegex = /\[(decision|lesson|method)(!?)\]\s*(.+?)(?:\s*[—–-]\s*(.+))?$/gim;
  let match;
  while ((match = candidateRegex.exec(text)) !== null) {
    const kind = match[1].toLowerCase() as 'decision' | 'lesson' | 'method';
    const isExplicit = match[2] === '!';
    const title = match[3].trim();
    const claim = match[4]?.trim() || title;
    // Lightweight reject gate: skip implementation noise
    if (isImplementationNoise(title, claim)) continue;
    candidates.push({
      kind,
      title,
      claim,
      why_durable: 'Extracted from thread summary',
      evidence: [{ threadId: input.threadId, messageId: input.messages[0]?.id ?? '', span: '' }],
      relatedAnchors: [],
      confidence: isExplicit ? 'explicit' : 'inferred',
    });
  }
  // Cap: keep only the most confident candidates (explicit first, then by order)
  if (candidates.length > MAX_CANDIDATES_PER_SEGMENT) {
    candidates.sort((a, b) => (a.confidence === 'explicit' ? 0 : 1) - (b.confidence === 'explicit' ? 0 : 1));
    candidates.length = MAX_CANDIDATES_PER_SEGMENT;
  }
  return candidates;
}

function buildSingleSegment(
  topicLabel: string,
  topicKey: string,
  summary: string,
  candidates: DurableCandidate[],
  input: AbstractiveInput,
): AbstractiveResult | null {
  const firstMsg = input.messages[0];
  const lastMsg = input.messages[input.messages.length - 1];
  if (!firstMsg || !lastMsg) return null;

  return {
    segments: [
      {
        summary,
        topicKey,
        topicLabel,
        boundaryReason: 'single batch',
        boundaryConfidence: 'high',
        fromMessageId: firstMsg.id,
        toMessageId: lastMsg.id,
        messageCount: input.messages.length,
        candidates: candidates.length > 0 ? candidates : undefined,
      },
    ],
  };
}

// ─── Client factory ─────────────────────────────────────────────
export function createAbstractiveClient(
  resolveProfile: () => Promise<ProviderProfile | null>,
  logger: { info: (msg: string) => void; error: (msg: string, err?: unknown) => void },
): (input: AbstractiveInput) => Promise<AbstractiveGenerationOutcome> {
  return async (input: AbstractiveInput): Promise<AbstractiveGenerationOutcome> => {
    const identity: SummaryGenerationIdentity = {
      providerId: 'anthropic-api',
      modelId: getAbstractiveSummaryModelId(),
      promptVersion: SUMMARY_PROMPT_VERSION,
    };
    const profile = await resolveProfile();
    if (!profile || profile.mode !== 'api_key') {
      logger.info('[abstractive-client] no API key profile, skipping');
      return { kind: 'provider_unavailable', attempts: 0, identity, detail: 'no API key profile' };
    }

    const timeoutMs = getApiSummaryTimeoutMs();
    const deadlineAt = Date.now() + timeoutMs;
    const requestText = async (userContent: string): Promise<TextGenerationOutcome> => {
      const controller = new AbortController();
      const remainingMs = Math.max(1, deadlineAt - Date.now());
      const timeout = setTimeout(() => controller.abort(), remainingMs);
      try {
        const res = await fetch(`${profile.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'x-api-key': profile.apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: identity.modelId,
            max_tokens: getAbstractiveSummaryMaxTokens(),
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: userContent }],
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const detail = `API error ${res.status}: ${res.statusText}`;
          logger.error(`[abstractive-client] ${detail}`);
          return { kind: 'provider_error', detail };
        }

        const body = (await res.json()) as { content: Array<{ type: string; text?: string }> };
        const text = body.content?.find((content) => content.type === 'text')?.text?.trim();
        if (!text) {
          logger.error('[abstractive-client] no text in response');
          return { kind: 'empty_response', detail: 'no text in response' };
        }
        return { kind: 'ok', text };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        if (controller.signal.aborted) {
          logger.error(`[abstractive-client] timed out after ${timeoutMs}ms`);
          return { kind: 'timeout', detail };
        }
        logger.error(`[abstractive-client] fetch error: ${detail}`);
        return { kind: 'provider_error', detail };
      } finally {
        clearTimeout(timeout);
      }
    };

    return generateWithSingleRepair(input, requestText, logger, '[abstractive-client]', identity);
  };
}

type SummaryAgentMessage = {
  type: string;
  content?: string;
  error?: string;
};

type SummaryAgentInvoke = (
  prompt: string,
  options?: {
    systemPrompt?: string;
    signal?: AbortSignal;
    workingDirectory?: string;
    callbackEnv?: Record<string, string>;
    cliConfigArgs?: readonly string[];
  },
) => AsyncIterable<SummaryAgentMessage>;

interface AgentSummaryClientOptions {
  providerId?: string;
  modelId?: string;
  workingDirectory?: string;
  callbackEnv?: Record<string, string>;
  cliConfigArgs?: readonly string[];
  timeoutMs?: number;
}

export function createAgentAbstractiveClient(
  invokeAgent: SummaryAgentInvoke,
  logger: { info: (msg: string) => void; error: (msg: string, err?: unknown) => void },
  options: AgentSummaryClientOptions = {},
): (input: AbstractiveInput) => Promise<AbstractiveGenerationOutcome> {
  return async (input: AbstractiveInput): Promise<AbstractiveGenerationOutcome> => {
    const providerId = options.providerId ?? 'codex-cli';
    const timeoutMs = options.timeoutMs ?? getAgentSummaryTimeoutMs(providerId);
    const deadlineAt = Date.now() + timeoutMs;
    const identity: SummaryGenerationIdentity = {
      providerId: providerId === 'pi-cli' ? 'pi-cli' : 'codex-cli',
      modelId: options.modelId ?? getAbstractiveSummaryModelId(),
      promptVersion: SUMMARY_PROMPT_VERSION,
    };
    const requestText = async (prompt: string): Promise<TextGenerationOutcome> => {
      const controller = new AbortController();
      const remainingMs = Math.max(1, deadlineAt - Date.now());
      const timeout = setTimeout(() => controller.abort(), remainingMs);
      const chunks: string[] = [];
      try {
        for await (const event of invokeAgent(prompt, {
          systemPrompt: SYSTEM_PROMPT,
          signal: controller.signal,
          workingDirectory: options.workingDirectory,
          callbackEnv: options.callbackEnv,
          cliConfigArgs: options.cliConfigArgs,
        })) {
          if (event.type === 'text' && event.content) {
            chunks.push(event.content);
          } else if (event.type === 'error') {
            const detail = event.error ?? 'unknown error';
            logger.error(`[abstractive-client:${providerId}] agent error: ${detail}`);
            return { kind: 'provider_error', detail };
          }
        }

        const text = chunks.join('\n').trim();
        if (!text) {
          logger.error(`[abstractive-client:${providerId}] no text in response`);
          return { kind: 'empty_response', detail: 'no text in response' };
        }
        return { kind: 'ok', text };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        if (controller.signal.aborted) {
          logger.error(`[abstractive-client:${providerId}] timed out after ${timeoutMs}ms`);
          return { kind: 'timeout', detail };
        }
        logger.error(`[abstractive-client:${providerId}] invoke error: ${detail}`);
        return { kind: 'provider_error', detail };
      } finally {
        clearTimeout(timeout);
      }
    };

    return generateWithSingleRepair(input, requestText, logger, `[abstractive-client:${providerId}]`, identity);
  };
}
