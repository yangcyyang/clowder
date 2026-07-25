import { readFile as readFileFs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, normalize, sep } from 'node:path';
import { parse as parseToml } from 'smol-toml';

export type LocalCliModelSource = 'cli' | 'config' | 'static' | 'remote';
export type LocalCliModelsStatus = 'ok' | 'config_only' | 'static_only' | 'failed' | 'unsupported';

export interface LocalCliModelCandidate {
  readonly id: string;
  readonly source: LocalCliModelSource;
  readonly isDefault?: boolean;
}

/**
 * Fourth model discovery source: an explicitly env-configured HTTP endpoint (e.g. a local
 * Anthropic-compatible gateway such as CLIProxyAPI) that reports the model catalog it actually
 * serves. Opt-in only — no URL/key is ever inferred from disk, only from env vars the operator sets.
 * This is a per-provider table; providers without an entry here simply have no remote source (yet).
 */
export interface RemoteModelDiscoveryDefinition {
  /** Env var holding the discovery endpoint, e.g. an OpenAI/Anthropic-compatible `/v1/models` URL. */
  readonly urlEnvVar: string;
  /** Optional env var holding a bearer key for the discovery endpoint. Only used when explicitly set. */
  readonly keyEnvVar?: string;
  /** Parses the endpoint's already-JSON-decoded response body into a flat list of model ids. */
  readonly parse: (payload: unknown) => string[];
}

export interface LocalCliModelsProbeDefinition {
  readonly command?: { readonly args: readonly string[]; readonly parse: (stdout: string) => string[] };
  readonly configFile?: {
    /**
     * One or more candidate config locations, tried in order; the first readable file whose
     * extract yields ids wins. Supports CLI home migrations (e.g. kimi ~/.kimi → ~/.kimi-code).
     * A `$VAR/...` entry resolves VAR from env and is skipped when unset (e.g. $KIMI_CODE_HOME).
     */
    readonly path: string | readonly string[];
    readonly extract: (content: string) => string[];
    /**
     * Treat the extractor's first returned id as the CLI's own declared default (extractors that
     * read a `default_model`-style field emit it first). Otherwise the allowlist default applies.
     */
    readonly defaultFromFirstEntry?: boolean;
  };
  readonly static?: readonly string[];
  readonly remote?: RemoteModelDiscoveryDefinition;
}

export interface RemoteFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export interface ModelChainOptions {
  readonly installed: boolean;
  readonly resolvedPath?: string;
  readonly defaultModel?: string;
  readonly modelsProbe?: LocalCliModelsProbeDefinition;
  readonly homeDir?: string;
  readonly runCommand: (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
  readonly readFile?: (path: string) => Promise<string>;
  /** Env source for remote discovery lookups; defaults to `process.env`. Injectable for tests. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Fetch implementation for remote discovery; defaults to the global `fetch`. Injectable for tests. */
  readonly fetchRemote?: (
    url: string,
    init: { readonly signal: AbortSignal; readonly headers?: Record<string, string> },
  ) => Promise<RemoteFetchResponse>;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes are the intended input.
const ANSI_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const CREDENTIAL_FILE_PATTERN = /(auth|credential|token|key)/i;
const SECRET_PATTERN = /\bsk_(?:agent|machine|proj|live|test)_[A-Za-z0-9_-]+/g;

export function redactProbeOutput(value: string): string {
  return value.replace(SECRET_PATTERN, (match) => {
    const prefix = match.split('_').slice(0, 2).join('_');
    return `${prefix}_<redacted>`;
  });
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

function uniqueModelIds(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = stripAnsi(raw).trim().slice(0, 256);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function parseLineModelCatalog(stdout: string): string[] {
  return uniqueModelIds(stdout.split(/\r?\n/));
}

export function parseGrokModelCatalog(stdout: string): string[] {
  const models: string[] = [];
  for (const rawLine of stripAnsi(stdout).split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^[*-]\s+([^\s]+)(?:\s+\(default\))?$/);
    if (match?.[1]) models.push(match[1]);
  }
  return uniqueModelIds(models);
}

export function parseCodexModelCatalog(content: string): string[] {
  const parsed = parseJsonObject(content);
  if (!parsed || !Array.isArray(parsed.models)) return [];
  return uniqueModelIds(
    parsed.models.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const model = item as Record<string, unknown>;
      return typeof model.slug === 'string' && model.visibility !== 'hide' ? [model.slug] : [];
    }),
  );
}

export function extractJsonModelFields(content: string): string[] {
  const parsed = parseJsonObject(content);
  if (!parsed) return [];
  const models: string[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'model' && typeof nested === 'string') models.push(nested);
      else visit(nested);
    }
  };
  visit(parsed);
  return uniqueModelIds(models);
}

export function extractOpenCodeConfigModels(content: string): string[] {
  const parsed = parseJsonObject(content);
  if (!parsed) return [];
  const models: string[] = typeof parsed.model === 'string' ? [parsed.model] : [];
  if (parsed.provider && typeof parsed.provider === 'object' && !Array.isArray(parsed.provider)) {
    for (const [providerId, value] of Object.entries(parsed.provider as Record<string, unknown>)) {
      models.push(...extractOpenCodeProviderModels(providerId, value));
    }
  }
  return uniqueModelIds(models);
}

function extractOpenCodeProviderModels(providerId: string, value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const providerModels = (value as Record<string, unknown>).models;
  if (!providerModels || typeof providerModels !== 'object' || Array.isArray(providerModels)) return [];
  return Object.keys(providerModels as Record<string, unknown>).map((modelId) => `${providerId}/${modelId}`);
}

export function extractKimiConfigModels(content: string): string[] {
  try {
    const parsed = parseToml(content) as Record<string, unknown>;
    const models: string[] = typeof parsed.default_model === 'string' ? [parsed.default_model] : [];
    if (parsed.models && typeof parsed.models === 'object' && !Array.isArray(parsed.models)) {
      models.push(...Object.keys(parsed.models as Record<string, unknown>));
    }
    return uniqueModelIds(models);
  } catch {
    return [];
  }
}

/**
 * Parses an OpenAI/Anthropic-compatible `/v1/models` JSON body (`{ data: [{ id }, ...] }`, or a
 * bare array of ids/objects) into a flat list of model ids. Tolerant of unexpected shapes — a
 * malformed or non-conforming payload simply yields no ids rather than throwing.
 */
export function parseRemoteModelCatalog(payload: unknown): string[] {
  const list: unknown[] = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as Record<string, unknown>).data)
      ? ((payload as Record<string, unknown>).data as unknown[])
      : [];
  const ids = list.map((item) => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string') {
      return (item as Record<string, unknown>).id as string;
    }
    return '';
  });
  return uniqueModelIds(ids);
}

export function parseCursorModelCatalog(stdout: string): string[] {
  const models: string[] = [];
  for (const rawLine of stripAnsi(stdout).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line === 'Available models' || line.startsWith('Tip:') || /authentication required/i.test(line))
      continue;
    const separator = line.indexOf(' - ');
    if (separator > 0) models.push(line.slice(0, separator));
  }
  return uniqueModelIds(models);
}

export const LOCAL_CLI_MODELS_PROBES = {
  // Claude Code 2.1.203 has no non-interactive model-list command; settings.json is the safe L2 source.
  claude: {
    configFile: { path: '~/.claude/settings.json', extract: extractJsonModelFields },
    static: [
      'claude-opus-5',
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-opus-4-7',
      'claude-opus-4-6',
    ],
    // Remote source (4th tier): an explicit local Anthropic-compatible gateway (e.g. CLIProxyAPI)
    // that can report newly released models before the static list above is next hand-updated.
    // Opt-in only via env; the key (if any) is provided by env too, never read from a credential file.
    remote: {
      urlEnvVar: 'CLOWDER_MODEL_DISCOVERY_ANTHROPIC_URL',
      keyEnvVar: 'CLOWDER_MODEL_DISCOVERY_ANTHROPIC_KEY',
      // Multi-upstream gateways (CLIProxyAPI) list every proxied family in /v1/models;
      // only claude-* belongs in the Claude candidate slot.
      parse: (payload: unknown) => parseRemoteModelCatalog(payload).filter((id) => id.startsWith('claude')),
    },
  },
  // Codex 0.144.0 exposes debug models --bundled, but its ~287KB output exceeds the shared 16KB safety cap.
  // L1 is still attempted; normal execution therefore falls through to the explicit, non-credential model cache.
  codex: {
    command: { args: ['debug', 'models', '--bundled'], parse: parseCodexModelCatalog },
    configFile: { path: '~/.codex/models_cache.json', extract: parseCodexModelCatalog },
    static: [
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex-spark',
    ],
  },
  // Gemini CLI 0.28.2 has no list-models command and the local settings file may contain no model field.
  gemini: {
    configFile: { path: '~/.gemini/settings.json', extract: extractJsonModelFields },
    static: [
      'gemini-3.1-pro-preview',
      'gemini-3.1-flash-lite',
      'gemini-3-flash-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
    ],
  },
  // OpenCode 1.15.13: models --pure is non-interactive and prints one provider/model id per line.
  opencode: {
    command: { args: ['models', '--pure'], parse: parseLineModelCatalog },
    configFile: { path: '~/.config/opencode/opencode.json', extract: extractOpenCodeConfigModels },
    static: ['xiaomi-mimo/mimo-v2.5-pro'],
  },
  // Kimi Code CLI has no models command; config.toml exposes default_model and the models table.
  // The CLI's home migrated ~/.kimi → ~/.kimi-code (official docs: KIMI_CODE_HOME overrides it),
  // so newer installs keep the legacy file around with a stale, smaller model table — probe the
  // env override first, then the new home, then the legacy one.
  kimi: {
    configFile: {
      path: ['$KIMI_CODE_HOME/config.toml', '~/.kimi-code/config.toml', '~/.kimi/config.toml'],
      extract: extractKimiConfigModels,
      defaultFromFirstEntry: true,
    },
    static: ['kimi-code/k3', 'kimi-code/k3-256k', 'kimi-code/kimi-for-coding', 'kimi-code/kimi-for-coding-highspeed'],
  },
  // Grok CLI 0.2.93 prints a human-readable catalog with one bullet per model.
  grok: {
    command: { args: ['models'], parse: parseGrokModelCatalog },
    static: ['grok-4.5', 'grok-composer-2.5-fast'],
  },
  // Cursor Agent 2026.07.01 has an account-scoped, non-interactive models command; unauthenticated runs fail cleanly.
  cursor: {
    command: { args: ['models'], parse: parseCursorModelCatalog },
    configFile: { path: '~/.cursor/cli-config.json', extract: extractJsonModelFields },
    static: [],
  },
  // OpenCLI 1.8.4 has no generic agent-model catalog; app adapters may launch UI and are intentionally unsupported.
  opencli: { static: [] },
} as const satisfies Record<string, LocalCliModelsProbeDefinition>;

function resolveExplicitConfigPath(rawPath: string, homeDir: string): string {
  const normalizedRaw = normalize(rawPath);
  if (rawPath.split(/[\\/]/).includes('..') || normalizedRaw.split(sep).includes('..')) {
    throw new Error('model config path traversal is not allowed');
  }
  if (CREDENTIAL_FILE_PATTERN.test(basename(rawPath))) {
    throw new Error('credential-shaped model config filename is not allowed');
  }
  if (rawPath === '~') return homeDir;
  if (rawPath.startsWith('~/')) return join(homeDir, rawPath.slice(2));
  if (isAbsolute(rawPath)) return rawPath;
  throw new Error('model config path must be absolute or home-relative');
}

function candidates(
  ids: readonly string[],
  source: LocalCliModelSource,
  defaultModel?: string,
): LocalCliModelCandidate[] {
  return uniqueModelIds(ids).map((id) => ({
    id,
    source,
    ...(id === defaultModel ? { isDefault: true } : {}),
  }));
}

/** Adds remote-only candidates (by id) on top of a base tier's result, tagged with source 'remote'. */
function mergeRemoteCandidates(
  base: readonly LocalCliModelCandidate[],
  remote: readonly LocalCliModelCandidate[],
): LocalCliModelCandidate[] {
  if (remote.length === 0) return [...base];
  const seen = new Set(base.map((item) => item.id));
  const merged = [...base];
  for (const item of remote) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged;
}

const REMOTE_MODEL_DISCOVERY_TIMEOUT_MS = 3_000;

/**
 * Best-effort remote model discovery. Never throws: an unconfigured URL, network error, timeout,
 * non-2xx response, or unparsable body all resolve to an empty list so the caller silently falls
 * back to whatever the command/config/static tiers already produced (fail-open).
 * Never reads a credential file — the URL and key can only come from explicit env vars.
 */
async function probeRemoteModels(
  options: ModelChainOptions,
  probe: LocalCliModelsProbeDefinition,
): Promise<LocalCliModelCandidate[]> {
  const remote = probe.remote;
  if (!remote) return [];

  const env = options.env ?? process.env;
  const url = env[remote.urlEnvVar]?.trim();
  if (!url) return [];
  const key = remote.keyEnvVar ? env[remote.keyEnvVar]?.trim() : undefined;

  const fetchImpl =
    options.fetchRemote ??
    ((target: string, init: { signal: AbortSignal; headers?: Record<string, string> }) =>
      fetch(target, init) as Promise<RemoteFetchResponse>);

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), REMOTE_MODEL_DISCOVERY_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}),
    });
    if (!response.ok) return [];
    const payload = await response.json();
    return candidates(remote.parse(payload), 'remote', options.defaultModel);
  } catch {
    // Timeout (AbortError), network failure, or a body that isn't valid JSON — all fail open.
    return [];
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export async function probeLocalCliModels(
  options: ModelChainOptions,
): Promise<{ models: LocalCliModelCandidate[]; modelsStatus: LocalCliModelsStatus }> {
  const probe = options.modelsProbe;
  if (!probe) return { models: [], modelsStatus: 'unsupported' };

  const remoteModelsPromise = probeRemoteModels(options, probe);

  const commandModels = await probeCommandModels(options, probe);
  if (commandModels.length > 0) {
    return { models: mergeRemoteCandidates(commandModels, await remoteModelsPromise), modelsStatus: 'ok' };
  }

  const configModels = await probeConfigModels(options, probe);
  if (configModels.length > 0) {
    return { models: mergeRemoteCandidates(configModels, await remoteModelsPromise), modelsStatus: 'config_only' };
  }

  const remoteModels = await remoteModelsPromise;

  if (probe.static && probe.static.length > 0) {
    const staticModels = candidates(probe.static, 'static', options.defaultModel);
    return { models: mergeRemoteCandidates(staticModels, remoteModels), modelsStatus: 'static_only' };
  }

  // No static fallback configured for this provider, but the remote source alone produced a
  // catalog (currently unreachable for any built-in provider, since every `remote` entry above
  // is paired with a non-empty `static` list; kept for forward-compatibility with future tables).
  if (remoteModels.length > 0) {
    return { models: remoteModels, modelsStatus: 'ok' };
  }

  const hasProbeLayer = Boolean(probe.command || probe.configFile);
  return { models: [], modelsStatus: hasProbeLayer ? 'failed' : 'unsupported' };
}

async function probeCommandModels(
  options: ModelChainOptions,
  probe: LocalCliModelsProbeDefinition,
): Promise<LocalCliModelCandidate[]> {
  if (!probe.command || !options.installed || !options.resolvedPath) return [];
  try {
    const result = await options.runCommand(options.resolvedPath, probe.command.args);
    return candidates(probe.command.parse(redactProbeOutput(result.stdout)), 'cli', options.defaultModel);
  } catch {
    // A timeout, buffer cap, auth failure, or parser error falls through to L2.
    return [];
  }
}

async function probeConfigModels(
  options: ModelChainOptions,
  probe: LocalCliModelsProbeDefinition,
): Promise<LocalCliModelCandidate[]> {
  if (!probe.configFile || !options.installed) return [];
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const rawPaths = Array.isArray(probe.configFile.path) ? probe.configFile.path : [probe.configFile.path];
  for (const rawPath of rawPaths) {
    let candidatePath = rawPath;
    const envPrefix = /^\$([A-Z0-9_]+)\//.exec(rawPath);
    if (envPrefix) {
      const base = env[envPrefix[1] ?? ''];
      if (!base) continue;
      candidatePath = `${base}/${rawPath.slice(envPrefix[0].length)}`;
    }
    try {
      const path = resolveExplicitConfigPath(candidatePath, home);
      const content = await (options.readFile ?? ((value) => readFileFs(value, 'utf8')))(path);
      const ids = probe.configFile.extract(redactProbeOutput(content));
      if (ids.length === 0) continue;
      const defaultId = probe.configFile.defaultFromFirstEntry ? ids[0] : options.defaultModel;
      return candidates(ids, 'config', defaultId);
    } catch {
      // Includes explicit rejection of sensitive or traversing paths; try the next candidate
      // location, and only after all of them fail fall through to L3.
      continue;
    }
  }
  return [];
}
