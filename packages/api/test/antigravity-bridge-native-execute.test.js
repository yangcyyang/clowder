import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, mock, test } from 'node:test';
import { AntigravityBridge } from '../dist/domains/cats/services/agents/providers/antigravity/AntigravityBridge.js';
import { AuditLogger } from '../dist/domains/cats/services/agents/providers/antigravity/executors/AuditLogger.js';
import { ExecutorRegistry } from '../dist/domains/cats/services/agents/providers/antigravity/executors/ExecutorRegistry.js';
import { RunCommandExecutor } from '../dist/domains/cats/services/agents/providers/antigravity/executors/RunCommandExecutor.js';

function tempStorePath() {
  return path.join(os.tmpdir(), `antigravity-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function makeStep({
  status = 'CORTEX_STEP_STATUS_WAITING',
  commandLine = 'echo probe',
  stepIndex = 0,
  trajectoryId = 't1',
  safeToAutoRun = true,
} = {}) {
  return {
    type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
    status,
    metadata: {
      toolCall: {
        id: 'toolu_1',
        name: 'run_command',
        argumentsJson: JSON.stringify({ CommandLine: commandLine, Cwd: '/tmp', SafeToAutoRun: safeToAutoRun }),
      },
      sourceTrajectoryStepInfo: { trajectoryId, stepIndex, cascadeId: 'c1' },
    },
  };
}

describe('AntigravityBridge.nativeExecuteAndPush', () => {
  const cleanupPaths = [];
  const cleanupDirs = [];

  afterEach(() => {
    for (const p of cleanupPaths) {
      try {
        fs.unlinkSync(p);
      } catch {}
    }
    for (const d of cleanupDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {}
    }
    cleanupPaths.length = 0;
    cleanupDirs.length = 0;
  });

  function makeBridge(options = {}) {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-audit-'));
    cleanupDirs.push(logDir);
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 't', useTls: false },
      { sessionStorePath: storePath, ...options },
    );
    mock.method(bridge, 'ensureConnected', async () => ({ port: 1234, csrfToken: 't', useTls: false }));
    const rpcMock = mock.fn(async () => ({ stdout: 'probe\n', stderr: '', exitCode: 0 }));
    Object.getPrototypeOf(bridge).rpc = rpcMock;
    mock.method(bridge, 'sendMessage', async () => 1);
    const registry = new ExecutorRegistry();
    const audit = new AuditLogger(logDir);
    registry.register(new RunCommandExecutor({ rpc: rpcMock }));
    bridge.attachExecutors(registry, audit);
    return { bridge, rpcMock, audit, registry, logDir };
  }

  const authorizationContext = {
    invocationId: 'inv-cap-1',
    threadId: 'thread-canary',
    userId: 'default-user',
    catId: 'antig-opus',
  };

  test('executes WAITING RUN_COMMAND step and pushes result', async () => {
    const { bridge, rpcMock } = makeBridge();
    const step = makeStep({ commandLine: 'echo probe' });
    const handled = await bridge.nativeExecuteAndPush(step, {
      cascadeId: 'c1',
      cwd: '/tmp',
      modelName: 'claude-opus-4-6',
    });
    assert.equal(handled, true);
    // rpcMock receives both executor calls (2-arg: method, payload) and bridge calls
    // (3-arg: conn, method, payload). Extract method from whichever position is a string.
    const methods = rpcMock.mock.calls.map((c) => {
      const args = c.arguments;
      return typeof args[0] === 'string' ? args[0] : args[1];
    });
    assert.ok(methods.includes('RunCommand'), `expected RunCommand call, got ${methods.join(',')}`);
    assert.ok(methods.includes('CancelCascadeSteps'), `expected CancelCascadeSteps call, got ${methods.join(',')}`);
    assert.equal(bridge.sendMessage.mock.callCount(), 1);
    const [cascadeIdArg, textArg, modelArg] = bridge.sendMessage.mock.calls[0].arguments;
    assert.equal(cascadeIdArg, 'c1');
    assert.match(textArg, /\[native-executor result for: echo probe\]/);
    assert.equal(modelArg, 'claude-opus-4-6', 'tool-result writeback must preserve the requested model');
  });

  test('pre-approves run_command permission before invoking RunCommand unary', async () => {
    const { bridge, rpcMock } = makeBridge();
    const step = makeStep({ commandLine: 'git log --oneline -5', stepIndex: 23, trajectoryId: 'traj-1' });

    const handled = await bridge.nativeExecuteAndPush(step, {
      cascadeId: 'c1',
      cwd: '/tmp',
      modelName: 'claude-opus-4-6',
    });

    assert.equal(handled, true);
    const methods = rpcMock.mock.calls.map((c) => {
      const args = c.arguments;
      return typeof args[0] === 'string' ? args[0] : args[1];
    });
    const approvalIdx = methods.indexOf('HandleCascadeUserInteraction');
    const runIdx = methods.indexOf('RunCommand');
    assert.notEqual(approvalIdx, -1, 'must call HandleCascadeUserInteraction to satisfy PermissionManager first');
    assert.notEqual(runIdx, -1, 'must still execute RunCommand');
    assert.ok(approvalIdx < runIdx, 'permission approval must happen before RunCommand unary');

    const approvalCall = rpcMock.mock.calls.find((c) => {
      const args = c.arguments;
      const method = typeof args[0] === 'string' ? args[0] : args[1];
      return method === 'HandleCascadeUserInteraction';
    });
    assert.ok(approvalCall, 'approval call should be recorded');
    const payload =
      typeof approvalCall.arguments[0] === 'string' ? approvalCall.arguments[1] : approvalCall.arguments[2];
    assert.deepEqual(payload, {
      cascadeId: 'c1',
      interaction: {
        permission: { allowed: true },
        trajectoryId: 'traj-1',
        stepIndex: 23,
      },
    });
  });

  test('permission guard RPC failure does not block RunCommand + pushToolResult fallback', async () => {
    const { bridge, logDir } = makeBridge();
    const rpcMock = mock.fn(async (...args) => {
      const method = typeof args[0] === 'string' ? args[0] : args[1];
      if (method === 'HandleCascadeUserInteraction') {
        throw new Error('permission rpc unavailable');
      }
      return { stdout: 'probe\n', stderr: '', exitCode: 0 };
    });
    Object.getPrototypeOf(bridge).rpc = rpcMock;
    const registry = new ExecutorRegistry();
    const audit = new AuditLogger(logDir);
    registry.register(new RunCommandExecutor({ rpc: rpcMock }));
    bridge.attachExecutors(registry, audit);

    const step = makeStep({ commandLine: 'git log --oneline -5', stepIndex: 23, trajectoryId: 'traj-1' });
    const handled = await bridge.nativeExecuteAndPush(step, {
      cascadeId: 'c1',
      cwd: '/tmp',
      modelName: 'claude-opus-4-6',
    });

    assert.equal(handled, true, 'permission guard should be best-effort, not a hard stop');
    const methods = rpcMock.mock.calls.map((c) => {
      const args = c.arguments;
      return typeof args[0] === 'string' ? args[0] : args[1];
    });
    assert.ok(methods.includes('HandleCascadeUserInteraction'));
    assert.ok(methods.includes('RunCommand'), 'must still execute RunCommand when permission hint fails');
    assert.ok(methods.includes('CancelCascadeSteps'), 'must still cancel stuck step before writeback');
    assert.equal(bridge.sendMessage.mock.callCount(), 1, 'must still inject fallback result message');
  });

  test('refused commands are blocked before permission approval RPC', async () => {
    const { bridge, rpcMock } = makeBridge();
    const step = makeStep({ commandLine: 'redis-cli -p 6399 flushall', stepIndex: 23, trajectoryId: 'traj-1' });

    const handled = await bridge.nativeExecuteAndPush(step, {
      cascadeId: 'c1',
      cwd: '/tmp',
      modelName: 'claude-opus-4-6',
    });

    assert.equal(handled, true, 'bridge should treat refused command as handled without touching LS permission flow');
    const methods = rpcMock.mock.calls.map((c) => {
      const args = c.arguments;
      return typeof args[0] === 'string' ? args[0] : args[1];
    });
    assert.equal(
      methods.includes('HandleCascadeUserInteraction'),
      false,
      'unsafe commands must not be permission-approved before local refusal logic runs',
    );
    assert.equal(methods.includes('RunCommand'), false, 'unsafe commands must not reach RunCommand unary');
    assert.ok(methods.includes('CancelCascadeSteps'), 'refused command should still cancel the waiting step');
    assert.equal(bridge.sendMessage.mock.callCount(), 1, 'refused command should still write back fallback result');
    const textArg = bridge.sendMessage.mock.calls[0].arguments[1];
    assert.match(textArg, /Redis 6399 is user sanctum/i);
  });

  test('capability gate consumes exact intent before LS approval and RunCommand', async () => {
    const authorize = mock.fn(async () => ({ allowed: true, state: 'granted', receiptId: 'receipt-1' }));
    const { bridge, rpcMock } = makeBridge({ capabilityReceiptGate: { authorize } });
    const step = makeStep({ commandLine: 'git status', stepIndex: 23, trajectoryId: 'traj-1' });

    const handled = await bridge.nativeExecuteAndPush(step, {
      cascadeId: 'c1',
      cwd: '/tmp',
      modelName: 'claude-opus-4-6',
      authorizationContext,
    });

    assert.equal(handled, true);
    assert.equal(authorize.mock.callCount(), 1);
    const [gateIntent] = authorize.mock.calls[0].arguments;
    assert.deepEqual(
      {
        version: gateIntent.version,
        executorId: gateIntent.executorId,
        action: gateIntent.action,
        invocationId: gateIntent.invocationId,
        threadId: gateIntent.threadId,
        catId: gateIntent.catId,
        userId: gateIntent.userId,
      },
      {
        version: 1,
        executorId: 'antigravity.native.run_command',
        action: 'run_command',
        ...authorizationContext,
      },
    );
    assert.equal(gateIntent.argumentDigest.length, 64);
    const methods = rpcMock.mock.calls.map((call) => {
      const args = call.arguments;
      return typeof args[0] === 'string' ? args[0] : args[1];
    });
    assert.ok(methods.indexOf('HandleCascadeUserInteraction') < methods.indexOf('RunCommand'));
  });

  test('redacts command input and executor output from exact-grant success audits', async () => {
    const authorize = mock.fn(async () => ({ allowed: true, state: 'granted', receiptId: 'receipt-success' }));
    const { bridge } = makeBridge({ capabilityReceiptGate: { authorize } });
    const registry = new ExecutorRegistry();
    registry.register(
      new RunCommandExecutor({
        rpc: async () => ({
          stdout: 'TOP_SECRET_STDOUT',
          stderr: 'TOP_SECRET_STDERR',
          exitCode: 0,
        }),
      }),
    );
    const audit = { record: mock.fn(async () => {}) };
    bridge.attachExecutors(registry, audit);

    const handled = await bridge.nativeExecuteAndPush(makeStep({ commandLine: 'echo TOP_SECRET_COMMAND' }), {
      cascadeId: 'c1',
      cwd: '/tmp',
      authorizationContext,
    });

    assert.equal(handled, true);
    assert.equal(audit.record.mock.callCount(), 1);
    const [entry] = audit.record.mock.calls[0].arguments;
    assert.deepEqual(Object.keys(entry.input).sort(), ['argumentDigest', 'receiptId']);
    assert.equal(entry.input.receiptId, 'receipt-success');
    assert.match(entry.input.argumentDigest, /^[0-9a-f]{64}$/);
    assert.equal(entry.result.status, 'success');
    assert.equal(entry.result.output.reason, 'capability_execution_completed');
    const serializedEntry = JSON.stringify(entry);
    assert.doesNotMatch(serializedEntry, /TOP_SECRET/);
    assert.doesNotMatch(serializedEntry, /echo /);
    assert.doesNotMatch(serializedEntry, /\/tmp/);
    assert.equal('stdout' in entry.result, false);
    assert.equal('stderr' in entry.result, false);
    assert.equal('exitCode' in entry.result, false);
  });

  test('redacts exact-grant executor error details while preserving the returned error result', async () => {
    const authorize = mock.fn(async () => ({ allowed: true, state: 'granted', receiptId: 'receipt-error' }));
    const { bridge } = makeBridge({ capabilityReceiptGate: { authorize } });
    const registry = new ExecutorRegistry();
    registry.register(
      new RunCommandExecutor({
        rpc: async () => {
          throw new Error('TOP_SECRET_EXECUTOR_ERROR');
        },
      }),
    );
    const audit = { record: mock.fn(async () => {}) };
    bridge.attachExecutors(registry, audit);

    const handled = await bridge.nativeExecuteAndPush(makeStep({ commandLine: 'echo TOP_SECRET_COMMAND' }), {
      cascadeId: 'c1',
      cwd: '/tmp',
      authorizationContext,
    });

    assert.equal(handled, true);
    assert.equal(audit.record.mock.callCount(), 1);
    const [entry] = audit.record.mock.calls[0].arguments;
    assert.equal(entry.input.receiptId, 'receipt-error');
    assert.match(entry.input.argumentDigest, /^[0-9a-f]{64}$/);
    assert.deepEqual(entry.result, {
      status: 'error',
      error: 'capability_execution_failed',
      durationMs: 0,
    });
    assert.doesNotMatch(JSON.stringify(entry), /TOP_SECRET|echo |\/tmp/);
    assert.match(bridge.sendMessage.mock.calls[0].arguments[1], /TOP_SECRET_EXECUTOR_ERROR/);
  });

  test('redacts exact-gate denied and store-error audits without changing user-facing reasons', async () => {
    const cases = [
      {
        decision: { allowed: false, state: 'denied', requestId: 'request-denied', reason: 'TOP_SECRET_DENIAL' },
        expectedAuditReason: 'capability_authorization_denied',
        expectedUserReason: /TOP_SECRET_DENIAL/,
      },
      {
        decision: { allowed: false, state: 'error' },
        expectedAuditReason: 'capability_authorization_unavailable',
        expectedUserReason: /Capability authorization unavailable/,
      },
    ];

    for (const { decision, expectedAuditReason, expectedUserReason } of cases) {
      const authorize = mock.fn(async () => decision);
      const { bridge, registry } = makeBridge({ capabilityReceiptGate: { authorize } });
      const audit = { record: mock.fn(async () => {}) };
      bridge.attachExecutors(registry, audit);

      const handled = await bridge.nativeExecuteAndPush(makeStep({ commandLine: 'echo TOP_SECRET_GATE_INPUT' }), {
        cascadeId: 'c1',
        cwd: '/tmp',
        authorizationContext,
      });

      assert.equal(handled, true);
      assert.equal(audit.record.mock.callCount(), 1);
      const [entry] = audit.record.mock.calls[0].arguments;
      assert.deepEqual(Object.keys(entry.input), ['argumentDigest']);
      assert.match(entry.input.argumentDigest, /^[0-9a-f]{64}$/);
      assert.deepEqual(entry.result, { status: 'refused', reason: expectedAuditReason });
      assert.doesNotMatch(JSON.stringify(entry), /TOP_SECRET|echo |\/tmp/);
      assert.match(bridge.sendMessage.mock.calls[0].arguments[1], expectedUserReason);
    }
  });

  test('audits consumed_without_completion when execution crashes after an exact grant', async () => {
    const authorize = mock.fn(async () => ({ allowed: true, state: 'granted', receiptId: 'receipt-crash' }));
    const { bridge } = makeBridge({ capabilityReceiptGate: { authorize } });
    const executorError = new Error('executor crashed: TOP_SECRET_ARGUMENT');
    const registry = new ExecutorRegistry();
    registry.register({
      toolName: 'run_command',
      canHandle: () => true,
      execute: async () => {
        throw executorError;
      },
    });
    const audit = { record: mock.fn(async () => {}) };
    bridge.attachExecutors(registry, audit);

    await assert.rejects(
      bridge.nativeExecuteAndPush(makeStep({ commandLine: 'git status' }), {
        cascadeId: 'c1',
        cwd: '/tmp',
        authorizationContext,
      }),
      (error) => error === executorError,
    );

    assert.equal(audit.record.mock.callCount(), 1);
    const [entry] = audit.record.mock.calls[0].arguments;
    assert.equal(entry.result.status, 'error');
    assert.match(entry.result.error, /consumed_without_completion/);
    assert.match(entry.result.error, /receipt-crash/);
    const serializedEntry = JSON.stringify(entry);
    assert.doesNotMatch(serializedEntry, /git status/);
    assert.doesNotMatch(serializedEntry, /\/tmp/);
    assert.doesNotMatch(serializedEntry, /TOP_SECRET_ARGUMENT/);
  });

  test('distinguishes completed execution from an unconfirmed writeback after receipt consumption', async () => {
    const authorize = mock.fn(async () => ({ allowed: true, state: 'granted', receiptId: 'receipt-writeback' }));
    const { bridge, registry } = makeBridge({ capabilityReceiptGate: { authorize } });
    const audit = { record: mock.fn(async () => {}) };
    bridge.attachExecutors(registry, audit);
    const writebackError = new Error('writeback failed: PRIVATE_RESULT');
    bridge.sendMessage.mock.mockImplementation(async () => {
      throw writebackError;
    });

    await assert.rejects(
      bridge.nativeExecuteAndPush(makeStep({ commandLine: 'git status' }), {
        cascadeId: 'c1',
        cwd: '/tmp',
        authorizationContext,
      }),
      (error) => error === writebackError,
    );

    const marker = audit.record.mock.calls
      .map((call) => call.arguments[0])
      .find((entry) => entry.result.status === 'error' && entry.result.error.includes('consumed_'));
    assert.ok(marker);
    assert.match(marker.result.error, /consumed_with_unconfirmed_writeback/);
    assert.doesNotMatch(marker.result.error, /consumed_without_completion/);
    const serializedMarker = JSON.stringify(marker);
    assert.doesNotMatch(serializedMarker, /git status/);
    assert.doesNotMatch(serializedMarker, /\/tmp/);
    assert.doesNotMatch(serializedMarker, /PRIVATE_RESULT/);
  });

  test('pending capability approval blocks LS approval and execution', async () => {
    const authorize = mock.fn(async () => ({
      allowed: false,
      state: 'pending',
      requestId: 'request-1',
    }));
    const { bridge, rpcMock } = makeBridge({ capabilityReceiptGate: { authorize } });

    const handled = await bridge.nativeExecuteAndPush(makeStep({ commandLine: 'git status' }), {
      cascadeId: 'c1',
      cwd: '/tmp',
      authorizationContext,
    });

    assert.equal(handled, 'capability_pending');
    assert.equal(authorize.mock.callCount(), 1);
    assert.equal(rpcMock.mock.callCount(), 0);
    assert.equal(bridge.sendMessage.mock.callCount(), 0);
  });

  test('receipt gate runs before the legacy SafeToAutoRun approval path', async () => {
    const authorize = mock.fn(async () => ({
      allowed: false,
      state: 'pending',
      requestId: 'request-safe-false',
    }));
    const { bridge, rpcMock } = makeBridge({ capabilityReceiptGate: { authorize } });

    const handled = await bridge.nativeExecuteAndPush(makeStep({ commandLine: 'git status', safeToAutoRun: false }), {
      cascadeId: 'c1',
      cwd: '/tmp',
      authorizationContext,
    });

    assert.equal(handled, 'capability_pending');
    assert.equal(authorize.mock.callCount(), 1);
    assert.equal(rpcMock.mock.callCount(), 0);
    assert.equal(bridge.sendMessage.mock.callCount(), 0);
  });

  test('capability store errors fail closed and write back a refusal', async () => {
    const authorize = mock.fn(async () => ({ allowed: false, state: 'error' }));
    const { bridge, rpcMock, logDir } = makeBridge({ capabilityReceiptGate: { authorize } });

    const handled = await bridge.nativeExecuteAndPush(makeStep({ commandLine: 'git status' }), {
      cascadeId: 'c1',
      cwd: '/tmp',
      authorizationContext,
    });

    assert.equal(handled, true, 'failed-closed receipt gate should consume the stuck tool step as refused');
    const methods = rpcMock.mock.calls.map((call) => {
      const args = call.arguments;
      return typeof args[0] === 'string' ? args[0] : args[1];
    });
    assert.equal(methods.includes('HandleCascadeUserInteraction'), false);
    assert.equal(methods.includes('RunCommand'), false);
    assert.ok(methods.includes('CancelCascadeSteps'));
    const entry = JSON.parse(fs.readFileSync(path.join(logDir, fs.readdirSync(logDir)[0]), 'utf8').trim());
    assert.equal(entry.result.status, 'refused');
    assert.equal(entry.result.reason, 'capability_authorization_unavailable');
    assert.match(bridge.sendMessage.mock.calls[0].arguments[1], /capability authorization unavailable/i);
  });

  test('capability refusal still cancels and writes back when the audit sink throws', async () => {
    const authorize = mock.fn(async () => ({ allowed: false, state: 'error' }));
    const { bridge, rpcMock, registry } = makeBridge({ capabilityReceiptGate: { authorize } });
    bridge.attachExecutors(registry, {
      record: mock.fn(async () => {
        throw new Error('audit unavailable');
      }),
    });

    const handled = await bridge.nativeExecuteAndPush(makeStep({ commandLine: 'git status' }), {
      cascadeId: 'c1',
      cwd: '/tmp',
      authorizationContext,
    });

    assert.equal(handled, true);
    const methods = rpcMock.mock.calls.map((call) => {
      const args = call.arguments;
      return typeof args[0] === 'string' ? args[0] : args[1];
    });
    assert.equal(methods.includes('HandleCascadeUserInteraction'), false);
    assert.equal(methods.includes('RunCommand'), false);
    assert.ok(methods.includes('CancelCascadeSteps'));
    assert.equal(bridge.sendMessage.mock.callCount(), 1);
  });

  test('capability refusal returns an unbypassable blocked state when writeback throws', async () => {
    const authorize = mock.fn(async () => ({ allowed: false, state: 'error' }));
    const { bridge, rpcMock } = makeBridge({ capabilityReceiptGate: { authorize } });
    bridge.sendMessage.mock.mockImplementation(async () => {
      throw new Error('writeback unavailable');
    });

    const handled = await bridge.nativeExecuteAndPush(makeStep({ commandLine: 'git status' }), {
      cascadeId: 'c1',
      cwd: '/tmp',
      authorizationContext,
    });

    assert.equal(handled, 'capability_blocked');
    const methods = rpcMock.mock.calls.map((call) => {
      const args = call.arguments;
      return typeof args[0] === 'string' ? args[0] : args[1];
    });
    assert.equal(methods.includes('HandleCascadeUserInteraction'), false);
    assert.equal(methods.includes('RunCommand'), false);
    assert.ok(methods.includes('CancelCascadeSteps'));
  });

  test('capability refusal stays blocked when strict step cancellation fails', async () => {
    const authorize = mock.fn(async () => ({ allowed: false, state: 'denied', requestId: 'request-2' }));
    const { bridge } = makeBridge({ capabilityReceiptGate: { authorize } });
    const rpcMock = mock.fn(async (...args) => {
      const method = typeof args[0] === 'string' ? args[0] : args[1];
      if (method === 'CancelCascadeSteps') throw new Error('cancel unavailable');
      return { stdout: 'probe\n', stderr: '', exitCode: 0 };
    });
    Object.getPrototypeOf(bridge).rpc = rpcMock;

    const handled = await bridge.nativeExecuteAndPush(makeStep({ commandLine: 'git status' }), {
      cascadeId: 'c1',
      cwd: '/tmp',
      authorizationContext,
    });

    assert.equal(handled, 'capability_blocked');
    const methods = rpcMock.mock.calls.map((call) => {
      const args = call.arguments;
      return typeof args[0] === 'string' ? args[0] : args[1];
    });
    assert.equal(methods.includes('HandleCascadeUserInteraction'), false);
    assert.equal(methods.includes('RunCommand'), false);
    assert.ok(methods.includes('CancelCascadeSteps'));
    assert.equal(bridge.sendMessage.mock.callCount(), 1, 'best-effort refusal signal still reaches the cascade');
  });

  test('local refusal runs before the capability gate', async () => {
    const authorize = mock.fn(async () => ({ allowed: true, state: 'granted', receiptId: 'receipt-1' }));
    const { bridge } = makeBridge({ capabilityReceiptGate: { authorize } });

    await bridge.nativeExecuteAndPush(makeStep({ commandLine: 'redis-cli -p 6399 flushall' }), {
      cascadeId: 'c1',
      cwd: '/tmp',
      authorizationContext,
    });

    assert.equal(authorize.mock.callCount(), 0);
  });

  test('skips non-WAITING steps', async () => {
    const { bridge, rpcMock } = makeBridge();
    const step = makeStep({ status: 'CORTEX_STEP_STATUS_DONE' });
    const handled = await bridge.nativeExecuteAndPush(step, { cascadeId: 'c1', cwd: '/tmp' });
    assert.equal(handled, false);
    assert.equal(rpcMock.mock.callCount(), 0);
  });

  test('returns no_executor for step types not in registry', async () => {
    const { bridge, rpcMock } = makeBridge();
    const step = {
      type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: { toolCall: { name: 'read_file', argumentsJson: '{}' } },
    };
    const handled = await bridge.nativeExecuteAndPush(step, { cascadeId: 'c1', cwd: '/tmp' });
    assert.equal(handled, 'no_executor', 'step with no matching executor must return no_executor (not false)');
    assert.equal(rpcMock.mock.callCount(), 0);
  });

  test('skips when executor not attached', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 't', useTls: false },
      { sessionStorePath: storePath },
    );
    const step = makeStep();
    const handled = await bridge.nativeExecuteAndPush(step, { cascadeId: 'c1', cwd: '/tmp' });
    assert.equal(handled, false);
  });

  test('returns false when sourceTrajectoryStepInfo is missing — refuses to default stepIndex to 0', async () => {
    const { bridge, rpcMock } = makeBridge();
    const step = {
      type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: {
        toolCall: {
          id: 'toolu_no_step_info',
          name: 'run_command',
          argumentsJson: JSON.stringify({ CommandLine: 'echo danger', Cwd: '/tmp', SafeToAutoRun: true }),
        },
      },
    };
    const handled = await bridge.nativeExecuteAndPush(step, { cascadeId: 'c1', cwd: '/tmp' });
    assert.equal(handled, false, 'must not execute when stepIndex is unknown — would cancel wrong step');
    const cancelCalls = rpcMock.mock.calls.filter((c) => {
      const args = c.arguments;
      const method = typeof args[0] === 'string' ? args[0] : args[1];
      return method === 'CancelCascadeSteps';
    });
    assert.equal(cancelCalls.length, 0, 'must not call CancelCascadeSteps without valid stepIndex');
  });

  test('returns approval_pending when SafeToAutoRun is not true (respects Antigravity approval metadata)', async () => {
    const { bridge, rpcMock } = makeBridge();
    const variants = [
      { CommandLine: 'echo hi', Cwd: '/tmp', SafeToAutoRun: false },
      { CommandLine: 'echo hi', Cwd: '/tmp' }, // missing flag
      { CommandLine: 'echo hi', Cwd: '/tmp', SafeToAutoRun: 'true' }, // string, not bool
      { CommandLine: 'echo hi', Cwd: '/tmp', SafeToAutoRun: 1 }, // number, not bool
    ];
    for (const args of variants) {
      const step = {
        type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
        status: 'CORTEX_STEP_STATUS_WAITING',
        metadata: {
          toolCall: { id: 'toolu_gate', name: 'run_command', argumentsJson: JSON.stringify(args) },
          sourceTrajectoryStepInfo: { trajectoryId: 't1', stepIndex: 2, cascadeId: 'c1' },
        },
      };
      const handled = await bridge.nativeExecuteAndPush(step, { cascadeId: 'c1', cwd: '/tmp' });
      assert.equal(
        handled,
        'approval_pending',
        `must return approval_pending (not false) when SafeToAutoRun=${JSON.stringify(args.SafeToAutoRun)}`,
      );
    }
    // No RPC calls at all — neither RunCommand nor CancelCascadeSteps
    assert.equal(rpcMock.mock.callCount(), 0);
    assert.equal(bridge.sendMessage.mock.callCount(), 0);
  });

  test('writes audit entry with result', async () => {
    const { bridge, logDir } = makeBridge();
    const step = makeStep({ commandLine: 'ls' });
    await bridge.nativeExecuteAndPush(step, { cascadeId: 'c1', cwd: '/tmp' });
    const files = fs.readdirSync(logDir);
    assert.equal(files.length, 1);
    const entry = JSON.parse(fs.readFileSync(path.join(logDir, files[0]), 'utf8').trim());
    assert.equal(entry.tool, 'run_command');
    assert.equal(entry.cascadeId, 'c1');
    assert.equal(entry.input.commandLine, 'ls');
    assert.equal(entry.result.status, 'success');
  });
});
