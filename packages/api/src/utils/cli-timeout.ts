export const DEFAULT_CLI_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_CLI_TIMEOUT_LABEL = `${DEFAULT_CLI_TIMEOUT_MS} (30分钟)`;

export function parseCliTimeoutMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

export function readCliTimeoutMsFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return parseCliTimeoutMs(env.CLI_TIMEOUT_MS);
}

export function resolveCliTimeoutMs(overrideMs: number | undefined, env: NodeJS.ProcessEnv = process.env): number {
  return overrideMs ?? readCliTimeoutMsFromEnv(env) ?? DEFAULT_CLI_TIMEOUT_MS;
}

/**
 * R8-1: CLI stream idle watchdog (docs/research/reliability-raft-round8-absorption.md
 * §二). Env var is in SECONDS (CLOWDER_CLI_IDLE_TIMEOUT_SEC) — 0 or unset = fully
 * disabled, zero behavior change. Suggested grey-scale value: 300 (5 min).
 *
 * Distinct from DEFAULT_CLI_TIMEOUT_MS above (a total-elapsed hard cap, also reset by
 * activity) and from the CPU-aware ProcessLivenessProbe/#774 stallAutoKill (which only
 * fires when CPU is flat, i.e. does not defend against a "busy-looking but not talking"
 * child) — this watchdog is a dumber, more reliable backstop: it only cares whether
 * ANY byte arrived on stdout or stderr recently.
 */
export const DEFAULT_CLI_IDLE_TIMEOUT_SEC = 0;

export function parseCliIdleTimeoutSec(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

export function readCliIdleTimeoutSecFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return parseCliIdleTimeoutSec(env.CLOWDER_CLI_IDLE_TIMEOUT_SEC) ?? DEFAULT_CLI_IDLE_TIMEOUT_SEC;
}

/**
 * Resolves the idle watchdog timeout in ms. `overrideMs` (CliSpawnOptions.idleTimeoutMs,
 * dependency-injection for tests) always wins over the env var. 0 = disabled.
 */
export function resolveCliIdleTimeoutMs(overrideMs: number | undefined, env: NodeJS.ProcessEnv = process.env): number {
  if (overrideMs !== undefined) return overrideMs;
  return readCliIdleTimeoutSecFromEnv(env) * 1000;
}
