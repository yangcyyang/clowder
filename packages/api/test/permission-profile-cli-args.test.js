/**
 * Batch 3-E item 1: permission-profile-cli-args.ts mapping table tests.
 * Pure functions — no CLI spawn needed. See ClaudeAgentService/CodexAgentService
 * integration tests for the "actually reaches spawn args" wiring check.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { resolveClaudePermissionCliArgs, resolveCodexPermissionCliOverrides } = await import(
  '../dist/domains/cats/services/agents/providers/permission-profile-cli-args.js'
);

describe('resolveClaudePermissionCliArgs (mapping table)', () => {
  it('strict → acceptEdits, no allowedTools', () => {
    assert.deepEqual(resolveClaudePermissionCliArgs('strict'), { permissionMode: 'acceptEdits' });
  });

  it('standard → acceptEdits + allowedTools Bash', () => {
    assert.deepEqual(resolveClaudePermissionCliArgs('standard'), {
      permissionMode: 'acceptEdits',
      allowedTools: ['Bash'],
    });
  });

  it('trusted → bypassPermissions (current behavior)', () => {
    assert.deepEqual(resolveClaudePermissionCliArgs('trusted'), { permissionMode: 'bypassPermissions' });
  });

  it('HARD CONSTRAINT: undefined (field absent) → bypassPermissions, identical to trusted', () => {
    const undefinedResult = resolveClaudePermissionCliArgs(undefined);
    assert.deepEqual(undefinedResult, { permissionMode: 'bypassPermissions' });
    assert.deepEqual(undefinedResult, resolveClaudePermissionCliArgs('trusted'));
  });
});

describe('resolveCodexPermissionCliOverrides (mapping table)', () => {
  it('strict → workspace-write + untrusted approval', () => {
    assert.deepEqual(resolveCodexPermissionCliOverrides('strict'), {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'untrusted',
    });
  });

  it('standard → workspace-write + on-failure approval', () => {
    assert.deepEqual(resolveCodexPermissionCliOverrides('standard'), {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-failure',
    });
  });

  it('trusted → {} (no override, env-driven defaults apply unchanged)', () => {
    assert.deepEqual(resolveCodexPermissionCliOverrides('trusted'), {});
  });

  it('HARD CONSTRAINT: undefined (field absent) → {}, identical to trusted', () => {
    const undefinedResult = resolveCodexPermissionCliOverrides(undefined);
    assert.deepEqual(undefinedResult, {});
    assert.deepEqual(undefinedResult, resolveCodexPermissionCliOverrides('trusted'));
  });
});
