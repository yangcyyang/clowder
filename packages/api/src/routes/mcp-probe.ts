/**
 * MCP Probe Helpers
 *
 * Probes an MCP stdio server with `tools/list` and returns lightweight
 * connection + tool metadata for the Capability Center UI.
 */

import { resolve } from 'node:path';
import type { CapabilityEntry, McpToolInfo } from '@cat-cafe/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolveBinaryRoot, resolvePencilCommand } from '../config/capabilities/capability-orchestrator.js';

export interface McpProbeResult {
  connectionStatus: 'connected' | 'disconnected' | 'unknown';
  tools?: McpToolInfo[];
}

const DEFAULT_PROBE_TIMEOUT_MS = 2500;
const SLOW_START_PROBE_TIMEOUT_MS = 7000;
// The SDK shutdown sequence waits up to 2s before SIGTERM and another 2s before SIGKILL.
// Do not abandon close() early: doing so leaves timed-out probe children attached to the API/test process.
const CLOSE_TIMEOUT_MS = 4500;
const MIN_STEP_TIMEOUT_MS = 100;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`Probe timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function sanitizeEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  const safe: Record<string, string> = { ...getDefaultEnvironment() };
  if (!env) return safe;
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') safe[key] = value;
  }
  return safe;
}

function remainingTimeout(deadlineMs: number): number {
  return Math.max(MIN_STEP_TIMEOUT_MS, deadlineMs - Date.now());
}

async function closeTransportBounded(transport: StdioClientTransport, transportClosed?: Promise<void>): Promise<void> {
  const closePromise = transport.close().catch(() => {});
  const settled = transportClosed ? Promise.all([closePromise, transportClosed]).then(() => undefined) : closePromise;
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      settled,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, CLOSE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function normalizeTools(tools: Array<{ name?: string | undefined; description?: string | undefined }>): McpToolInfo[] {
  const byName = new Map<string, McpToolInfo>();
  for (const tool of tools) {
    const name = typeof tool.name === 'string' ? tool.name.trim() : '';
    if (!name) continue;
    const description = typeof tool.description === 'string' ? tool.description.trim() : undefined;
    if (!byName.has(name)) {
      byName.set(name, description ? { name, description } : { name });
    }
  }
  return [...byName.values()];
}

export function resolveProbeTimeoutMs(capability: CapabilityEntry, overrideTimeoutMs?: number): number {
  if (typeof overrideTimeoutMs === 'number' && Number.isFinite(overrideTimeoutMs) && overrideTimeoutMs > 0) {
    return overrideTimeoutMs;
  }

  const command = capability.mcpServer?.command?.toLowerCase() ?? '';
  const args = capability.mcpServer?.args ?? [];
  const argsLower = args.map((arg) => arg.toLowerCase());
  const argsJoined = argsLower.join(' ');

  // npx/pnpm-dlx based servers often need extra cold-start time.
  const isNpxLike = command === 'npx' || command === 'pnpm' || command === 'pnpmx';
  const looksLikePlaywright = argsJoined.includes('playwright');
  const isDlx = argsJoined.includes('dlx') || argsJoined.includes('-y');
  if (isNpxLike && (isDlx || looksLikePlaywright)) {
    return SLOW_START_PROBE_TIMEOUT_MS;
  }

  // Docker MCP gateway can be briefly unavailable while it reloads enabled servers.
  const isDockerGatewayRun =
    command === 'docker' && argsLower[0] === 'mcp' && argsLower[1] === 'gateway' && argsLower[2] === 'run';
  if (isDockerGatewayRun) {
    return SLOW_START_PROBE_TIMEOUT_MS;
  }

  return DEFAULT_PROBE_TIMEOUT_MS;
}

export async function probeMcpCapability(
  capability: CapabilityEntry,
  options: {
    projectRoot: string;
    timeoutMs?: number;
  },
): Promise<McpProbeResult> {
  if (capability.type !== 'mcp') return { connectionStatus: 'unknown' };
  if (!capability.mcpServer) return { connectionStatus: 'unknown' };

  let command = capability.mcpServer.command;
  let args = [...(capability.mcpServer.args ?? [])];
  if ((!command || command.trim().length === 0) && capability.mcpServer.resolver === 'pencil') {
    const resolved = await resolvePencilCommand();
    if (!resolved) return { connectionStatus: 'unknown' };
    command = resolved.command;
    args = resolved.args;
  }
  if (!command || command.trim().length === 0) return { connectionStatus: 'unknown' };

  // For built-in cat-cafe MCP servers, re-resolve args to use the actual
  // binary root rather than the persisted path which may point at a stale
  // worktree. Uses projectRoot (repo root) as explicit fallback since
  // process.cwd() may be a subdirectory (e.g. packages/api).
  if (capability.source === 'cat-cafe' && args.length > 0) {
    const binaryRoot = resolveBinaryRoot(options.projectRoot);
    args = args.map((arg) => {
      const match = arg.match(/packages\/mcp-server\/dist\/(.+\.js)$/);
      if (match) return resolve(binaryRoot, 'packages/mcp-server/dist', match[1]);
      return arg;
    });
  }

  const timeoutMs = resolveProbeTimeoutMs(capability, options.timeoutMs);
  const deadlineMs = Date.now() + timeoutMs;
  const serverParams: StdioServerParameters = {
    command,
    args,
    cwd: capability.mcpServer.workingDir ?? options.projectRoot,
    // Probe only needs tools/list result; discard stderr to avoid pipe backpressure.
    stderr: 'ignore',
  };
  const env = sanitizeEnv(capability.mcpServer.env);
  if (env && Object.keys(env).length > 0) serverParams.env = env;

  const transport = new StdioClientTransport(serverParams);
  const client = new Client({ name: 'cat-cafe-capability-probe', version: '0.1.0' }, { capabilities: {} });
  let resolveTransportClosed: (() => void) | undefined;
  const transportClosed = new Promise<void>((resolve) => {
    resolveTransportClosed = resolve;
  });
  const previousOnClose = transport.onclose;
  transport.onclose = () => {
    previousOnClose?.();
    resolveTransportClosed?.();
  };
  let transportStarted = false;

  try {
    const connectAbort = new AbortController();
    const connectPromise = client.connect(transport, { signal: connectAbort.signal });
    transportStarted = transport.pid !== null;
    const connectTimeoutMs = remainingTimeout(deadlineMs);
    try {
      await withTimeout(connectPromise, connectTimeoutMs, () =>
        connectAbort.abort(new Error(`Probe timeout after ${connectTimeoutMs}ms`)),
      );
    } catch (error) {
      connectAbort.abort(error);
      throw error;
    }

    const listAbort = new AbortController();
    const listTimeoutMs = remainingTimeout(deadlineMs);
    let result: Awaited<ReturnType<Client['listTools']>>;
    try {
      result = await withTimeout(client.listTools(undefined, { signal: listAbort.signal }), listTimeoutMs, () =>
        listAbort.abort(new Error(`Probe timeout after ${listTimeoutMs}ms`)),
      );
    } catch (error) {
      listAbort.abort(error);
      throw error;
    }
    return {
      connectionStatus: 'connected',
      tools: normalizeTools(result.tools ?? []),
    };
  } catch {
    return {
      connectionStatus: 'disconnected',
      tools: [],
    };
  } finally {
    await closeTransportBounded(transport, transportStarted ? transportClosed : undefined).catch(() => {});
  }
}
