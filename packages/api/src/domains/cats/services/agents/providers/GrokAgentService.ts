import { type CatId, createCatId } from '@cat-cafe/shared';
import { getCatModel } from '../../../../../config/cat-models.js';
import { formatCliExitError } from '../../../../../utils/cli-format.js';
import { formatCliNotFoundError, resolveCliCommand } from '../../../../../utils/cli-resolve.js';
import {
  buildChildEnv,
  isCliError,
  isCliTimeout,
  isLivenessWarning,
  spawnCli,
} from '../../../../../utils/cli-spawn.js';
import type { SpawnFn } from '../../../../../utils/cli-types.js';
import type { AgentMessage, AgentService, AgentServiceOptions, MessageMetadata } from '../../types.js';
import { transformGrokEvent } from './grok-event-transform.js';

interface GrokAgentServiceOptions {
  catId?: CatId;
  model?: string;
  spawnFn?: SpawnFn;
  cliCommand?: string;
}

function buildPrompt(prompt: string, systemPrompt?: string): string {
  return systemPrompt?.trim() ? `${systemPrompt.trim()}\n\n${prompt}` : prompt;
}

const SENSITIVE_ENV_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

function redactSensitiveEnvValues(message: string, env: NodeJS.ProcessEnv): string {
  let redacted = message;
  for (const [name, value] of Object.entries(env)) {
    if (!SENSITIVE_ENV_NAME.test(name) || !value) continue;
    redacted = redacted.replaceAll(value, '<redacted>');
  }
  return redacted;
}

export class GrokAgentService implements AgentService {
  readonly catId: CatId;
  private readonly model: string;
  private readonly spawnFn: SpawnFn | undefined;
  private readonly cliCommand: string;

  constructor(options?: GrokAgentServiceOptions) {
    this.catId = options?.catId ?? createCatId('grok');
    this.model = options?.model ?? getCatModel(this.catId as string);
    this.spawnFn = options?.spawnFn;
    this.cliCommand = options?.cliCommand ?? 'grok';
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const metadata: MessageMetadata = { provider: 'grok', model: this.model };
    const command = resolveCliCommand(this.cliCommand);
    if (!command) {
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

    const args = [
      '-p',
      buildPrompt(prompt, options?.systemPrompt),
      '--output-format',
      'streaming-json',
      '--model',
      this.model,
      '--permission-mode',
      'auto',
    ];
    if (options?.sessionId) {
      args.push('--resume', options.sessionId);
      metadata.sessionId = options.sessionId;
      yield {
        type: 'session_init',
        catId: this.catId,
        sessionId: options.sessionId,
        metadata: { ...metadata },
        timestamp: Date.now(),
      };
    }

    for (const value of options?.cliConfigArgs ?? []) {
      args.push(...value.trim().split(/\s+/).filter(Boolean));
    }

    const profileMode = options?.callbackEnv?.CAT_CAFE_GROK_PROFILE_MODE;
    const env: Record<string, string | null> = {
      ...(options?.callbackEnv ?? {}),
      ...(profileMode === 'subscription' ? { XAI_API_KEY: null } : {}),
      ...(options?.accountEnv ?? {}),
    };
    const childEnv = buildChildEnv(env);
    const cliOptions = {
      command,
      args,
      ...(options?.workingDirectory ? { cwd: options.workingDirectory } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
      ...(options?.cliSessionId ? { cliSessionId: options.cliSessionId } : {}),
      ...(options?.livenessProbe ? { livenessProbe: options.livenessProbe } : {}),
      ...(options?.parentSpan ? { parentSpan: options.parentSpan } : {}),
    };

    let thought = '';
    let emittedSession = Boolean(options?.sessionId);
    const flushThought = (): AgentMessage | null => {
      if (!thought) return null;
      const message: AgentMessage = {
        type: 'system_info',
        catId: this.catId,
        content: JSON.stringify({ type: 'thinking', catId: this.catId, text: thought }),
        metadata,
        timestamp: Date.now(),
      };
      thought = '';
      return message;
    };

    try {
      const events = options?.spawnCliOverride
        ? options.spawnCliOverride(cliOptions)
        : spawnCli(cliOptions, this.spawnFn ? { spawnFn: this.spawnFn } : undefined);
      for await (const rawEvent of events) {
        if (isCliTimeout(rawEvent)) {
          yield {
            type: 'error',
            catId: this.catId,
            error: `Grok CLI 响应超时 (${Math.round(rawEvent.timeoutMs / 1000)}s)`,
            metadata,
            timestamp: Date.now(),
          };
          continue;
        }
        if (isLivenessWarning(rawEvent)) continue;
        if (isCliError(rawEvent)) {
          yield {
            type: 'error',
            catId: this.catId,
            error: formatCliExitError('Grok CLI', rawEvent),
            metadata,
            timestamp: Date.now(),
          };
          continue;
        }

        const event = transformGrokEvent(rawEvent);
        if (event.kind === 'thought') {
          thought += event.data;
          continue;
        }
        if (event.kind === 'text') {
          const thinkingMessage = flushThought();
          if (thinkingMessage) yield thinkingMessage;
          if (event.data) {
            yield {
              type: 'text',
              catId: this.catId,
              content: event.data,
              metadata,
              timestamp: Date.now(),
            };
          }
          continue;
        }
        if (event.kind === 'error') {
          const message = event.message.trim() || 'Grok CLI reported an error';
          yield {
            type: 'error',
            catId: this.catId,
            error: redactSensitiveEnvValues(message, childEnv),
            metadata,
            timestamp: Date.now(),
          };
          continue;
        }
        if (event.kind === 'end') {
          const thinkingMessage = flushThought();
          if (thinkingMessage) yield thinkingMessage;
          if (event.sessionId) {
            metadata.sessionId = event.sessionId;
            if (!emittedSession) {
              emittedSession = true;
              yield {
                type: 'session_init',
                catId: this.catId,
                sessionId: event.sessionId,
                metadata: { ...metadata },
                timestamp: Date.now(),
              };
            }
          }
        }
      }
      const thinkingMessage = flushThought();
      if (thinkingMessage) yield thinkingMessage;
      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
    } catch (error) {
      yield {
        type: 'error',
        catId: this.catId,
        error: error instanceof Error ? error.message : String(error),
        metadata,
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
    }
  }
}
