/**
 * Permission Profile → CLI Args — batch 3-E, item 1.
 *
 * Maps the catalog-level `CatConfig.permissionProfile` tri-level gate
 * (strict/standard/trusted, see packages/shared/src/types/cat-breed.ts) onto
 * concrete CLI flags for the two providers whose headless permission model
 * is well-understood in this codebase: Claude (`claude` CLI) and Codex
 * (`codex` CLI). Every other provider (Grok, Gemini, Kimi, Pi, OpenCode,
 * A2A, CatAgent, Antigravity, Dare) ignores `permissionProfile` entirely and
 * keeps its current bypass-everything behavior at all three tiers — see the
 * batch 3-E report for the full rationale (docs/research/clowder-raft-*).
 *
 * HARD CONSTRAINT: profile absent/undefined or 'trusted' → today's behavior,
 * byte-for-byte (Claude `bypassPermissions`, Codex env-driven sandbox/approval
 * defaults, unchanged). Existing cats with no `permissionProfile` field are
 * completely unaffected.
 *
 * ## Design notes
 *
 * Claude CLI ships 4 permission modes (default/plan/acceptEdits/
 * bypassPermissions); in headless `-p` (print) mode there is no TTY to answer
 * a prompt, so any tool call not pre-approved by the mode (or an explicit
 * `--allowedTools` entry) is auto-denied rather than hanging — this mirrors
 * the validated finding in docs/bug-report/grok-headless-terminal-permission/
 * bug-report.md for a sibling provider (Grok: `permission-mode=default` +
 * explicit `--allow` list is the only pattern that was smoke-tested and
 * confirmed not to hang; blanket bypass was explicitly rejected there). This
 * module assumes the same "unapproved ⇒ denied, not hung" contract for
 * Claude's own CLI, per Anthropic's documented print-mode semantics — this
 * assumption has NOT been re-verified with a live smoke test in this batch
 * (see report for the follow-up recommendation).
 *
 * There is no third built-in Claude mode between acceptEdits and
 * bypassPermissions, so `standard`'s extra headroom over `strict` comes from
 * pairing acceptEdits with an explicit `--allowedTools` entry (a real,
 * documented Claude CLI flag — see docs/architecture/cli-integration.md's
 * original `--allowedTools Read,Edit,Glob,Grep` reference) rather than a new
 * discrete permission-mode value:
 *
 *   strict:   --permission-mode acceptEdits
 *             (Edit/Write/NotebookEdit auto-approved; Bash and everything
 *              else denied — a cat that can revise files but cannot run
 *              shell commands or reach any other gated tool.)
 *   standard: --permission-mode acceptEdits --allowedTools Bash
 *             (adds blanket Bash approval on top of strict — a cat that can
 *              edit files AND run shell commands, e.g. git/tests/build, but
 *              nothing else beyond that.)
 *   trusted:  --permission-mode bypassPermissions
 *             (current default — everything auto-approved, no gate at all.)
 *
 * Codex CLI's own sandbox/approval axes already form a natural 3-tier ladder
 * once profiled against the current env-driven defaults
 * (packages/api/src/config/codex-cli.ts: DEFAULT_CODEX_SANDBOX_MODE =
 * 'danger-full-access', DEFAULT_CODEX_APPROVAL_POLICY = 'on-request' — i.e.
 * today's *trusted* is "no sandbox at all, rarely asks"):
 *
 *   strict:   --sandbox workspace-write --config approval_policy="untrusted"
 *             (confined to the workspace, no network; asks before anything
 *              not on Codex's own small pre-approved command list.)
 *   standard: --sandbox workspace-write --config approval_policy="on-failure"
 *             (still confined to the workspace/no network, but commands run
 *              automatically inside the sandbox and only escalate to asking
 *              if the sandboxed attempt itself fails — less friction than
 *              strict for ordinary dev commands.)
 *   trusted:  no override — env-driven getCodexSandboxMode()/
 *             getCodexApprovalPolicy() defaults apply unchanged.
 */

import type { CatPermissionProfile } from '@cat-cafe/shared';
import type { CodexApprovalPolicy, CodexSandboxMode } from '../../../../../config/codex-cli.js';

/** Claude CLI's own permission-mode values that this module ever emits. */
export type ClaudePermissionMode = 'acceptEdits' | 'bypassPermissions';

export interface ClaudePermissionCliArgs {
  readonly permissionMode: ClaudePermissionMode;
  /** Extra tool names/patterns pre-approved regardless of permissionMode (--allowedTools). */
  readonly allowedTools?: readonly string[];
}

/** Resolve the Claude CLI args for a given permission profile. Absent/'trusted' → current bypass behavior. */
export function resolveClaudePermissionCliArgs(profile: CatPermissionProfile | undefined): ClaudePermissionCliArgs {
  switch (profile) {
    case 'strict':
      return { permissionMode: 'acceptEdits' };
    case 'standard':
      return { permissionMode: 'acceptEdits', allowedTools: ['Bash'] };
    case 'trusted':
    default:
      return { permissionMode: 'bypassPermissions' };
  }
}

export interface CodexPermissionCliOverrides {
  /** undefined = no override, caller falls back to getCodexSandboxMode() env default. */
  readonly sandboxMode?: CodexSandboxMode;
  /** undefined = no override, caller falls back to getCodexApprovalPolicy() env default. */
  readonly approvalPolicy?: CodexApprovalPolicy;
}

/** Resolve the Codex CLI sandbox/approval overrides for a given permission profile.
 *  Absent/'trusted' → {} (no override — today's env-driven defaults apply unchanged). */
export function resolveCodexPermissionCliOverrides(profile: CatPermissionProfile | undefined): CodexPermissionCliOverrides {
  switch (profile) {
    case 'strict':
      return { sandboxMode: 'workspace-write', approvalPolicy: 'untrusted' };
    case 'standard':
      return { sandboxMode: 'workspace-write', approvalPolicy: 'on-failure' };
    case 'trusted':
    default:
      return {};
  }
}
