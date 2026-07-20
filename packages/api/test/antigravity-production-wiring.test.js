import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { AntigravityAgentService } from '../dist/domains/cats/services/agents/providers/antigravity/AntigravityAgentService.js';
import { AntigravityBridge } from '../dist/domains/cats/services/agents/providers/antigravity/AntigravityBridge.js';

function stubGate() {
  return {
    authorize: async () => ({ allowed: true, state: 'off' }),
    isInScope: () => false,
  };
}

describe('A1 production wiring: capability receipt gate is required by-type', () => {
  test('AntigravityAgentService.forProduction throws without a capability receipt gate', () => {
    assert.throws(() => AntigravityAgentService.forProduction({ catId: 'antigravity' }), /capability receipt gate/i);
  });

  test('AntigravityAgentService.forProduction builds a gated service when the gate is provided', () => {
    // Service-owned bridge construction writes an audit dir under cwd — use a
    // throwaway tmp cwd so the worktree stays clean.
    const previousCwd = process.cwd();
    process.chdir(mkdtempSync(join(tmpdir(), 'piaoA-401-')));
    try {
      const service = AntigravityAgentService.forProduction({
        catId: 'antigravity',
        model: 'claude-opus-4-6',
        capabilityReceiptGate: stubGate(),
      });
      assert.ok(service instanceof AntigravityAgentService);
    } finally {
      process.chdir(previousCwd);
    }
  });

  test('AntigravityBridge.forProduction throws without a capability receipt gate', () => {
    assert.throws(() => AntigravityBridge.forProduction(undefined, {}), /capability receipt gate/i);
    assert.throws(() => AntigravityBridge.forProduction(undefined, { capabilityReceiptGate: undefined }), /capability receipt gate/i);
  });

  test('AntigravityBridge.forProduction builds a bridge when the gate is provided', () => {
    const bridge = AntigravityBridge.forProduction(undefined, {
      capabilityReceiptGate: stubGate(),
      sessionStorePath: join(mkdtempSync(join(tmpdir(), 'piaoA-401-')), 'sessions.json'),
    });
    assert.ok(bridge instanceof AntigravityBridge);
  });
});
