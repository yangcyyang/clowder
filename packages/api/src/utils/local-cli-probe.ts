import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveCliCommand } from './cli-resolve.js';

const execFileAsync = promisify(execFile);

export type LocalCliId = 'claude' | 'codex' | 'gemini' | 'opencode' | 'kimi' | 'cursor' | 'opencli';

export interface LocalCliProbeDefinition {
  readonly id: LocalCliId;
  readonly label: string;
  readonly command: LocalCliId;
  readonly clientId?: 'anthropic' | 'openai' | 'google' | 'opencode' | 'kimi';
  readonly defaultModel?: string;
  readonly installHint: string;
  readonly versionArgs: readonly string[];
}

export interface LocalCliProbeResult {
  readonly id: LocalCliId;
  readonly label: string;
  readonly command: LocalCliId;
  readonly clientId?: LocalCliProbeDefinition['clientId'];
  readonly defaultModel?: string;
  readonly installed: boolean;
  readonly resolvedPath?: string;
  readonly version?: string;
  readonly versionStatus: 'ok' | 'failed' | 'not_installed';
  readonly authStatus: 'unknown';
  readonly authStatusReason: string;
  readonly installHint: string;
}

export const LOCAL_CLI_ALLOWLIST: readonly LocalCliProbeDefinition[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    clientId: 'anthropic',
    defaultModel: 'claude-sonnet-5',
    installHint: 'npm install -g @anthropic-ai/claude-code',
    versionArgs: ['--version'],
  },
  {
    id: 'codex',
    label: 'Codex',
    command: 'codex',
    clientId: 'openai',
    defaultModel: 'gpt-5.5',
    installHint: 'npm install -g @openai/codex',
    versionArgs: ['--version'],
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    command: 'gemini',
    clientId: 'google',
    defaultModel: 'gemini-3.1-pro-preview',
    installHint: 'npm install -g @google/gemini-cli',
    versionArgs: ['--version'],
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    command: 'opencode',
    clientId: 'opencode',
    defaultModel: 'xiaomi-mimo/mimo-v2.5-pro',
    installHint: 'npm install -g opencode',
    versionArgs: ['--version'],
  },
  {
    id: 'kimi',
    label: 'Kimi CLI',
    command: 'kimi',
    clientId: 'kimi',
    defaultModel: 'kimi-code/kimi-for-coding',
    installHint: 'uv tool install --python 3.13 kimi-cli',
    versionArgs: ['--version'],
  },
  {
    id: 'cursor',
    label: 'Cursor CLI',
    command: 'cursor',
    installHint: '在 Cursor 中启用 shell command，或安装 cursor CLI',
    versionArgs: ['--version'],
  },
  {
    id: 'opencli',
    label: 'OpenCLI',
    command: 'opencli',
    installHint: '安装 opencli 并确保命令可被后端进程访问',
    versionArgs: ['--version'],
  },
] as const;

export interface ProbeLocalClisOptions {
  readonly resolveCommand?: (command: LocalCliId) => string | null;
  readonly runCommand?: (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
}

function firstLine(value: string): string | undefined {
  const redacted = value.replace(/\bsk_(?:agent|machine|proj|live|test)_[A-Za-z0-9_-]+/g, (match) => {
    const prefix = match.split('_').slice(0, 2).join('_');
    return `${prefix}_<redacted>`;
  });
  const line = redacted
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return undefined;
  // Keep probe output useful but never forward large command output into UI.
  return line.slice(0, 160);
}

async function runVersionProbe(
  file: string,
  args: readonly string[],
  runCommand: NonNullable<ProbeLocalClisOptions['runCommand']>,
): Promise<Pick<LocalCliProbeResult, 'version' | 'versionStatus'>> {
  try {
    const { stdout, stderr } = await runCommand(file, args);
    return {
      version: firstLine(stdout) ?? firstLine(stderr),
      versionStatus: 'ok',
    };
  } catch {
    return { versionStatus: 'failed' };
  }
}

export async function probeLocalAgentClis(options: ProbeLocalClisOptions = {}): Promise<LocalCliProbeResult[]> {
  const resolveCommand = options.resolveCommand ?? resolveCliCommand;
  const runCommand =
    options.runCommand ??
    (async (file: string, args: readonly string[]) =>
      execFileAsync(file, [...args], {
        timeout: 5_000,
        maxBuffer: 16 * 1024,
        windowsHide: true,
      }));

  const results: LocalCliProbeResult[] = [];
  for (const definition of LOCAL_CLI_ALLOWLIST) {
    const resolvedPath = resolveCommand(definition.command);
    if (!resolvedPath) {
      results.push({
        id: definition.id,
        label: definition.label,
        command: definition.command,
        clientId: definition.clientId,
        defaultModel: definition.defaultModel,
        installed: false,
        versionStatus: 'not_installed',
        authStatus: 'unknown',
        authStatusReason: '未安装，未执行认证探测。',
        installHint: definition.installHint,
      });
      continue;
    }

    const version = await runVersionProbe(resolvedPath, definition.versionArgs, runCommand);
    results.push({
      id: definition.id,
      label: definition.label,
      command: definition.command,
      clientId: definition.clientId,
      defaultModel: definition.defaultModel,
      installed: true,
      resolvedPath,
      ...version,
      authStatus: 'unknown',
      authStatusReason: '安全模式：只做只读版本探测，不读取凭证文件；认证状态由首次实际运行验证。',
      installHint: definition.installHint,
    });
  }
  return results;
}
