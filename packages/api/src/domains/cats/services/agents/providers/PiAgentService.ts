/**
 * Pi Agent Service — local `pi` CLI subprocess bridge.
 *
 * Pi emits NDJSON in `--mode json`. We only surface assistant text blocks to
 * Clowder chat; thinking/tool internals stay out of the visible message stream.
 */

import { type CatId, createCatId } from '@cat-cafe/shared';
import { getCatModel } from '../../../../../config/cat-models.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { formatCliExitError } from '../../../../../utils/cli-format.js';
import { formatCliNotFoundError, resolveCliCommand } from '../../../../../utils/cli-resolve.js';
import { isCliError, isCliTimeout, isLivenessWarning, spawnCli } from '../../../../../utils/cli-spawn.js';
import type { SpawnFn } from '../../../../../utils/cli-types.js';
import type { AgentMessage, AgentService, AgentServiceOptions, MessageMetadata, TokenUsage } from '../../types.js';

const log = createModuleLogger('pi-agent');

interface PiAgentServiceOptions {
  catId?: CatId;
  model?: string;
  cliCommand?: string;
  spawnFn?: SpawnFn;
}

interface PiUsage {
  input?: unknown;
  output?: unknown;
  total?: unknown;
  totalTokens?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  cost?: { total?: unknown };
}

interface PiMessage {
  role?: unknown;
  api?: unknown;
  provider?: unknown;
  model?: unknown;
  usage?: PiUsage;
  content?: unknown;
}

interface PiAssistantEvent {
  type?: unknown;
  delta?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function extractUsage(raw: unknown): TokenUsage | undefined {
  const usage = asRecord(raw) as PiUsage | null;
  if (!usage) return undefined;
  const inputTokens = asNumber(usage.input);
  const outputTokens = asNumber(usage.output);
  const totalTokens = asNumber(usage.totalTokens) ?? asNumber(usage.total);
  const cacheReadTokens = asNumber(usage.cacheRead);
  const cacheCreationTokens = asNumber(usage.cacheWrite);
  const costUsd = asNumber(usage.cost?.total);
  const parsed: TokenUsage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function updateMetadataFromMessage(metadata: MessageMetadata, rawMessage: unknown): void {
  const message = asRecord(rawMessage) as PiMessage | null;
  if (!message) return;
  if (typeof message.provider === 'string' && message.provider.trim()) metadata.provider = message.provider;
  if (typeof message.model === 'string' && message.model.trim()) metadata.model = message.model;
  const usage = extractUsage(message.usage);
  if (usage) metadata.usage = { ...(metadata.usage ?? {}), ...usage };
}

function extractAssistantText(rawMessage: unknown): string {
  const message = asRecord(rawMessage) as PiMessage | null;
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return '';
  const parts: string[] = [];
  for (const block of message.content) {
    const item = asRecord(block);
    if (item?.type === 'text' && typeof item.text === 'string') parts.push(item.text);
  }
  return parts.join('');
}

function extractSessionId(rawEvent: unknown): string | undefined {
  const event = asRecord(rawEvent);
  if (!event) return undefined;
  if (event.type === 'session' && typeof event.id === 'string' && event.id.trim()) return event.id;
  if (typeof event.sessionId === 'string' && event.sessionId.trim()) return event.sessionId;
  return undefined;
}

function extractTextDelta(rawEvent: unknown): string | null {
  const event = asRecord(rawEvent);
  const assistantEvent = asRecord(event?.assistantMessageEvent) as PiAssistantEvent | null;
  if (assistantEvent?.type === 'text_delta' && typeof assistantEvent.delta === 'string') {
    return assistantEvent.delta;
  }
  return null;
}

function appendUserCliArgs(baseArgs: string[], cliConfigArgs?: readonly string[]): string[] {
  const userParts: string[] = [];
  for (const arg of cliConfigArgs ?? []) userParts.push(...arg.trim().split(/\s+/).filter(Boolean));
  return userParts.length > 0 ? [...baseArgs, ...userParts] : baseArgs;
}

export class PiAgentService implements AgentService {
  readonly catId: CatId;
  private readonly model: string;
  private readonly cliCommand: string;
  private readonly spawnFn: SpawnFn | undefined;

  constructor(options?: PiAgentServiceOptions) {
    this.catId = options?.catId ?? createCatId('pi');
    this.model = options?.model ?? getCatModel(this.catId as string);
    this.cliCommand = options?.cliCommand ?? 'pi';
    this.spawnFn = options?.spawnFn;
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const effectiveModel = options?.callbackEnv?.CAT_CAFE_PI_MODEL_OVERRIDE ?? this.model;
    const metadata: MessageMetadata = { provider: 'pi', model: effectiveModel || 'default' };
    const args = this.buildArgs(prompt, options, effectiveModel);

    if (options?.sessionId) {
      metadata.sessionId = options.sessionId;
      yield {
        type: 'session_init',
        catId: this.catId,
        sessionId: options.sessionId,
        metadata,
        timestamp: Date.now(),
      };
    }

    try {
      const piCommand = resolveCliCommand(this.cliCommand);
      if (!piCommand) {
        yield {
          type: 'error',
          catId: this.catId,
          error: formatCliNotFoundError(this.cliCommand),
          metadata,
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
        return;
      }

      const childEnv =
        options?.callbackEnv || options?.accountEnv
          ? { ...(options?.callbackEnv ?? {}), ...(options?.accountEnv ?? {}) }
          : undefined;
      const cliOpts = {
        command: piCommand,
        args,
        ...(options?.workingDirectory ? { cwd: options.workingDirectory } : {}),
        ...(childEnv ? { env: childEnv } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
        ...(options?.cliSessionId ? { cliSessionId: options.cliSessionId } : {}),
        ...(options?.livenessProbe ? { livenessProbe: options.livenessProbe } : {}),
        ...(options?.parentSpan ? { parentSpan: options.parentSpan } : {}),
      };
      const events = options?.spawnCliOverride
        ? options.spawnCliOverride(cliOpts)
        : spawnCli(cliOpts, this.spawnFn ? { spawnFn: this.spawnFn } : undefined);

      let emittedSessionInit = Boolean(options?.sessionId);
      let textEventCount = 0;
      let fallbackFinalText = '';

      for await (const event of events) {
        if (isCliTimeout(event)) {
          yield {
            type: 'system_info',
            catId: this.catId,
            content: JSON.stringify({
              type: 'timeout_diagnostics',
              silenceDurationMs: event.silenceDurationMs,
              processAlive: event.processAlive,
              lastEventType: event.lastEventType,
              firstEventAt: event.firstEventAt,
              lastEventAt: event.lastEventAt,
              cliSessionId: event.cliSessionId,
              invocationId: event.invocationId,
              rawArchivePath: event.rawArchivePath,
            }),
            timestamp: Date.now(),
          };
          yield {
            type: 'error',
            catId: this.catId,
            error: `Pi CLI 响应超时 (${Math.round(event.timeoutMs / 1000)}s${event.firstEventAt == null ? ', 未收到首帧' : ''})`,
            metadata,
            timestamp: Date.now(),
          };
          continue;
        }

        if (isLivenessWarning(event)) {
          log.warn(
            {
              catId: this.catId,
              invocationId: options?.invocationId,
              level: (event as { level?: string }).level,
              silenceMs: (event as { silenceDurationMs?: number }).silenceDurationMs,
            },
            '[PiAgent] liveness warning — CLI may be stuck',
          );
          yield {
            type: 'system_info',
            catId: this.catId,
            content: JSON.stringify({ type: 'liveness_warning', ...event }),
            timestamp: Date.now(),
          };
          continue;
        }

        if (isCliError(event)) {
          yield {
            type: 'error',
            catId: this.catId,
            error: formatCliExitError('Pi CLI', event),
            metadata,
            timestamp: Date.now(),
          };
          continue;
        }

        const sessionId = extractSessionId(event);
        if (sessionId) {
          metadata.sessionId = sessionId;
          if (!emittedSessionInit) {
            emittedSessionInit = true;
            yield {
              type: 'session_init',
              catId: this.catId,
              sessionId,
              metadata: { ...metadata, sessionId },
              timestamp: Date.now(),
            };
          }
        }

        const eventRecord = asRecord(event);
        updateMetadataFromMessage(metadata, eventRecord?.message);
        updateMetadataFromMessage(metadata, asRecord(eventRecord?.assistantMessageEvent)?.partial);

        const delta = extractTextDelta(event);
        if (delta) {
          textEventCount++;
          yield { type: 'text', catId: this.catId, content: delta, metadata, timestamp: Date.now() };
        }

        if (eventRecord?.type === 'message_end') {
          fallbackFinalText = extractAssistantText(eventRecord.message);
        }
      }

      if (textEventCount === 0 && fallbackFinalText.trim()) {
        yield {
          type: 'text',
          catId: this.catId,
          content: fallbackFinalText,
          metadata,
          timestamp: Date.now(),
        };
      }

      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
    } catch (err) {
      yield {
        type: 'error',
        catId: this.catId,
        error: err instanceof Error ? err.message : String(err),
        metadata,
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
    }
  }

  private buildArgs(prompt: string, options: AgentServiceOptions | undefined, model: string): string[] {
    const args = ['--print', '--mode', 'json', '--no-context-files'];
    if (options?.sessionId) args.push('--session', options.sessionId);
    if (model) args.push('--model', model);
    if (options?.systemPrompt?.trim()) args.push('--append-system-prompt', options.systemPrompt.trim());
    return [...appendUserCliArgs(args, options?.cliConfigArgs), prompt];
  }
}
