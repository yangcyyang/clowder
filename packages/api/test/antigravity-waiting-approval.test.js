import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';
import { AntigravityAgentService } from '../dist/domains/cats/services/agents/providers/antigravity/AntigravityAgentService.js';
import { AntigravityBridge } from '../dist/domains/cats/services/agents/providers/antigravity/AntigravityBridge.js';

function createBridge() {
  return new AntigravityBridge({ port: 1234, csrfToken: 'test', useTls: false });
}

async function collect(iterable) {
  const messages = [];
  for await (const msg of iterable) messages.push(msg);
  return messages;
}

function createMockServiceBridge({ resolveOutstandingSteps } = {}) {
  return {
    ensureConnected: mock.fn(async () => ({ port: 1234, csrfToken: 'test', useTls: false })),
    startCascade: mock.fn(async () => 'test-cascade-001'),
    sendMessage: mock.fn(async () => 0),
    getTrajectorySteps: mock.fn(async () => []),
    getTrajectory: mock.fn(async () => ({ status: 'CASCADE_RUN_STATUS_IDLE', numTotalSteps: 0 })),
    pollForSteps: mock.fn(async function* () {
      yield {
        steps: [],
        cursor: {
          baselineStepCount: 0,
          lastDeliveredStepCount: 0,
          terminalSeen: false,
          lastActivityAt: Date.now(),
          awaitingUserInput: true,
        },
      };
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'DONE',
            plannerResponse: { response: 'browser approved' },
          },
        ],
        cursor: {
          baselineStepCount: 0,
          lastDeliveredStepCount: 1,
          terminalSeen: true,
          lastActivityAt: Date.now(),
        },
      };
    }),
    getOrCreateSession: mock.fn(async () => 'test-cascade-001'),
    resolveModelId: mock.fn(() => 'MODEL_PLACEHOLDER_M26'),
    resolveOutstandingSteps: resolveOutstandingSteps ?? mock.fn(async () => {}),
    nativeExecuteAndPush: mock.fn(async () => false),
  };
}

describe('Antigravity waiting approval', () => {
  test('pollForSteps yields awaiting-user-input state instead of throwing stall', async () => {
    const bridge = createBridge();
    mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_RUNNING',
      numTotalSteps: 0,
      awaitingUserInput: true,
    }));

    const ac = new AbortController();
    const iter = bridge.pollForSteps('cascade-1', 0, 100, 20, ac.signal)[Symbol.asyncIterator]();

    const first = await iter.next();
    assert.equal(first.done, false);
    assert.equal(first.value.steps.length, 0);
    assert.equal(first.value.cursor.awaitingUserInput, true);

    ac.abort();
    await assert.rejects(async () => {
      await iter.next();
    }, /abort/i);
  });

  test('service auto-approves via resolveOutstandingSteps when autoApprove=true (default)', async () => {
    const resolveOutstandingSteps = mock.fn(async () => {});
    const bridge = createMockServiceBridge({ resolveOutstandingSteps });
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('open browser'));

    assert.equal(resolveOutstandingSteps.mock.calls.length, 1, 'resolveOutstandingSteps should be called once');
    assert.equal(resolveOutstandingSteps.mock.calls[0].arguments[0], 'test-cascade-001');

    const waiting = messages.find((msg) => msg.type === 'liveness_signal');
    assert.equal(waiting, undefined, 'should NOT emit liveness_signal when auto-approve succeeds');

    const texts = messages.filter((msg) => msg.type === 'text');
    assert.equal(texts.length, 1);
    assert.equal(texts[0].content, 'browser approved');
  });

  test('an exact receipt scope preserves generic auto-approval when no RUN_COMMAND is present', async () => {
    const resolveOutstandingSteps = mock.fn(async () => {});
    const bridge = {
      ...createMockServiceBridge({ resolveOutstandingSteps }),
      isCapabilityReceiptScope: mock.fn(() => true),
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('open browser'));

    assert.equal(resolveOutstandingSteps.mock.calls.length, 1);
    assert.equal(
      messages.some((msg) => msg.errorCode === 'waiting_capability_approval'),
      false,
    );
    assert.equal(messages.find((msg) => msg.type === 'text')?.content, 'browser approved');
  });

  test('service falls back to liveness_signal when auto-approve fails', async () => {
    const resolveOutstandingSteps = mock.fn(async () => {
      throw new Error('ResolveOutstandingSteps: 400 — invalid');
    });
    const bridge = createMockServiceBridge({ resolveOutstandingSteps });
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('open browser'));

    assert.equal(resolveOutstandingSteps.mock.calls.length, 1, 'should attempt auto-approve');

    const waiting = messages.find((msg) => msg.type === 'liveness_signal');
    assert.ok(waiting, 'should fall back to liveness_signal on failure');
    const parsed = JSON.parse(waiting.content);
    assert.match(parsed.message, /等待权限批准/);
  });

  test('service emits liveness_signal when resolve succeeds but awaitingUserInput persists', async () => {
    const resolveOutstandingSteps = mock.fn(async () => {});
    const bridge = {
      ...createMockServiceBridge({ resolveOutstandingSteps }),
      pollForSteps: mock.fn(async function* () {
        // 1st batch: awaitingUserInput — service should try auto-approve
        yield {
          steps: [],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 0,
            terminalSeen: false,
            lastActivityAt: Date.now(),
            awaitingUserInput: true,
          },
        };
        // 2nd batch: STILL awaitingUserInput — resolve was a no-op
        yield {
          steps: [],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 0,
            terminalSeen: false,
            lastActivityAt: Date.now(),
            awaitingUserInput: true,
          },
        };
        // 3rd batch: finally resolved
        yield {
          steps: [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'DONE', plannerResponse: { response: 'done' } }],
          cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: true, lastActivityAt: Date.now() },
        };
      }),
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('open browser'));

    // Should only attempt resolve ONCE, not retry on second awaitingUserInput
    assert.equal(resolveOutstandingSteps.mock.calls.length, 1, 'should attempt resolve only once');

    // Must emit liveness_signal on the second awaitingUserInput (resolve didn't work)
    const waiting = messages.filter((msg) => msg.type === 'liveness_signal');
    assert.ok(waiting.length >= 1, 'must emit liveness_signal when resolve did not clear awaitingUserInput');
  });

  test('env var ANTIGRAVITY_AUTO_APPROVE=false disables auto-approve', async () => {
    const original = process.env['ANTIGRAVITY_AUTO_APPROVE'];
    try {
      process.env['ANTIGRAVITY_AUTO_APPROVE'] = 'false';
      const resolveOutstandingSteps = mock.fn(async () => {});
      const bridge = createMockServiceBridge({ resolveOutstandingSteps });
      // No explicit autoApprove option — should read from env
      const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

      const messages = await collect(service.invoke('open browser'));

      assert.equal(resolveOutstandingSteps.mock.calls.length, 0, 'should NOT call resolve when env disables it');
      const waiting = messages.find((msg) => msg.type === 'liveness_signal');
      assert.ok(waiting, 'should emit liveness_signal');
    } finally {
      if (original === undefined) delete process.env['ANTIGRAVITY_AUTO_APPROVE'];
      else process.env['ANTIGRAVITY_AUTO_APPROVE'] = original;
    }
  });

  test('service probes resolveOutstandingSteps on stall when autoApprove=true OUTSIDE capability receipt scope', async () => {
    const resolveOutstandingSteps = mock.fn(async () => {});
    const bridge = {
      ...createMockServiceBridge({ resolveOutstandingSteps }),
      isCapabilityReceiptScope: mock.fn(() => false),
      pollForSteps: mock.fn(async function* () {
        // Simulate stall: RUNNING but no awaitingUserInput flag, bridge throws stall
        throw new Error('Antigravity stall: no activity for 60213ms (steps=5, status=CASCADE_RUN_STATUS_RUNNING)');
      }),
    };
    let callCount = 0;
    // Replace pollForSteps: first call throws stall, second call succeeds after probe
    bridge.pollForSteps = mock.fn(async function* () {
      callCount++;
      if (callCount === 1) {
        throw new Error('Antigravity stall: no activity for 60213ms (steps=5, status=CASCADE_RUN_STATUS_RUNNING)');
      }
      // After probe-approve, cascade unblocks
      yield {
        steps: [
          { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'DONE', plannerResponse: { response: 'probed ok' } },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: true, lastActivityAt: Date.now() },
      };
    });
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('open browser'));

    assert.equal(resolveOutstandingSteps.mock.calls.length, 1, 'should probe resolveOutstandingSteps on stall');
    const texts = messages.filter((msg) => msg.type === 'text');
    assert.equal(texts.length, 1, 'should get response after probe unblocks cascade');
    assert.equal(texts[0].content, 'probed ok');
  });

  test('service auto-approves approval_pending RUN_COMMAND even when cursor.awaitingUserInput is false', async () => {
    const resolveOutstandingSteps = mock.fn(async () => {});
    const waitingStep = {
      type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: {
        toolCall: {
          id: 'toolu_waiting_without_cursor_flag',
          name: 'run_command',
          argumentsJson: JSON.stringify({ CommandLine: 'echo hi', Cwd: '/tmp', SafeToAutoRun: false }),
        },
      },
    };
    const bridge = {
      ...createMockServiceBridge({ resolveOutstandingSteps }),
      nativeExecuteAndPush: mock.fn(async (step) =>
        step.type === 'CORTEX_STEP_TYPE_RUN_COMMAND' ? 'approval_pending' : false,
      ),
      pollForSteps: mock.fn(async function* () {
        yield {
          steps: [waitingStep],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 0,
            terminalSeen: false,
            lastActivityAt: Date.now(),
            awaitingUserInput: false,
          },
        };
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: { response: 'approved without waiting for stall' },
            },
          ],
          cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: true, lastActivityAt: Date.now() },
        };
      }),
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('run command'));

    assert.equal(resolveOutstandingSteps.mock.calls.length, 1, 'approval_pending should trigger immediate resolve');
    assert.equal(resolveOutstandingSteps.mock.calls[0].arguments[0], 'test-cascade-001');
    assert.equal(
      messages.some((msg) => msg.type === 'liveness_signal'),
      false,
      'successful immediate auto-approve should not show waiting UI',
    );
    const text = messages.find((msg) => msg.type === 'text');
    assert.equal(text?.content, 'approved without waiting for stall');
  });

  test('A1: type-drifted run_command step still suppresses auto-approve inside receipt scope', async () => {
    // F-1 fix: suppression must use the SAME discriminator as the executor
    // (metadata.toolCall.name), not step.type. A step whose type string drifts
    // but which the executor WOULD gate must still suppress LS auto-approve.
    const resolveOutstandingSteps = mock.fn(async () => {});
    const driftedWaitingStep = {
      type: 'CORTEX_STEP_TYPE_RUN_COMMAND_DRIFTED', // type drift: no longer the canonical constant
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: {
        toolCall: {
          id: 'toolu_type_drift',
          name: 'run_command',
          argumentsJson: JSON.stringify({ CommandLine: 'echo hi', Cwd: '/tmp' }),
        },
        sourceTrajectoryStepInfo: { trajectoryId: 'trajectory-1', stepIndex: 11 },
      },
    };
    const bridge = {
      ...createMockServiceBridge({ resolveOutstandingSteps }),
      isCapabilityReceiptScope: mock.fn(() => true),
      nativeExecuteAndPush: mock.fn(async () => 'capability_pending'),
      pollForSteps: mock.fn(async function* () {
        yield {
          steps: [driftedWaitingStep],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 0,
            terminalSeen: false,
            lastActivityAt: Date.now(),
            awaitingUserInput: true,
          },
        };
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: { response: 'capability approved' },
            },
          ],
          cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: true, lastActivityAt: Date.now() },
        };
      }),
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('run command'));

    assert.equal(
      resolveOutstandingSteps.mock.calls.length,
      0,
      'type drift must NOT reopen the LS-side auto-approve bypass inside receipt scope',
    );
    assert.ok(
      messages.some((msg) => msg.errorCode === 'waiting_capability_approval'),
      'must wait for capability approval, not LS auto-approval',
    );
  });

  test('A1: ambiguous waiting step (no toolCall name) fails toward suppression inside receipt scope', async () => {
    // F-1 fix: when the tool name cannot be determined, suppress auto-approve
    // (fail safe) rather than letting an unidentified waiting step through.
    const resolveOutstandingSteps = mock.fn(async () => {});
    const ambiguousWaitingStep = {
      type: 'CORTEX_STEP_TYPE_UNSPECIFIED',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: {},
    };
    const bridge = {
      ...createMockServiceBridge({ resolveOutstandingSteps }),
      isCapabilityReceiptScope: mock.fn(() => true),
      nativeExecuteAndPush: mock.fn(async () => false),
      pollForSteps: mock.fn(async function* () {
        yield {
          steps: [ambiguousWaitingStep],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 0,
            terminalSeen: false,
            lastActivityAt: Date.now(),
            awaitingUserInput: true,
          },
        };
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: { response: 'resolved without auto-approve' },
            },
          ],
          cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: true, lastActivityAt: Date.now() },
        };
      }),
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('do something'));

    assert.equal(
      resolveOutstandingSteps.mock.calls.length,
      0,
      'ambiguous waiting step must suppress auto-approve inside receipt scope',
    );
  });

  test('A1: stall probe is suppressed inside capability receipt scope', async () => {
    // F-1 fix: the stall-probe auto-approve path must not approve steps while
    // the invocation is inside receipt scope.
    const resolveOutstandingSteps = mock.fn(async () => {});
    const bridge = {
      ...createMockServiceBridge({ resolveOutstandingSteps }),
      isCapabilityReceiptScope: mock.fn(() => true),
      pollForSteps: mock.fn(async function* () {
        throw new Error('Antigravity stall: no activity for 60213ms (steps=5, status=CASCADE_RUN_STATUS_RUNNING)');
      }),
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('open browser'));

    assert.equal(
      resolveOutstandingSteps.mock.calls.length,
      0,
      'stall probe must NOT auto-approve inside capability receipt scope',
    );
    const errors = messages.filter((msg) => msg.type === 'error');
    assert.ok(errors.length >= 1, 'stall must surface as an error when the probe is suppressed');
    assert.match(errors[0].error, /stall/i);
  });

  test('capability_pending never enters the legacy auto-approve path and retries the exact step', async () => {
    const resolveOutstandingSteps = mock.fn(async () => {});
    const waitingStep = {
      type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: {
        toolCall: {
          id: 'toolu_capability_pending',
          name: 'run_command',
          argumentsJson: JSON.stringify({ CommandLine: 'echo hi', Cwd: '/tmp', SafeToAutoRun: true }),
        },
        sourceTrajectoryStepInfo: { trajectoryId: 'trajectory-1', stepIndex: 7 },
      },
    };
    let nativeCalls = 0;
    const bridge = {
      ...createMockServiceBridge({ resolveOutstandingSteps }),
      isCapabilityReceiptScope: mock.fn(() => true),
      nativeExecuteAndPush: mock.fn(async (step) => {
        if (step.type !== 'CORTEX_STEP_TYPE_RUN_COMMAND') return false;
        nativeCalls += 1;
        return nativeCalls === 1 ? 'capability_pending' : true;
      }),
      pollForSteps: mock.fn(async function* () {
        yield {
          steps: [waitingStep],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 0,
            terminalSeen: false,
            lastActivityAt: Date.now(),
            awaitingUserInput: true,
          },
        };
        yield {
          steps: [waitingStep],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 0,
            terminalSeen: false,
            lastActivityAt: Date.now(),
            awaitingUserInput: true,
          },
        };
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: { response: 'capability approved' },
            },
          ],
          cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: true, lastActivityAt: Date.now() },
        };
      }),
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('run command'));

    assert.equal(resolveOutstandingSteps.mock.calls.length, 0);
    assert.equal(nativeCalls, 2, 'capability pending must remain retryable until the exact grant is consumed');
    const waiting = messages.find((msg) => msg.errorCode === 'waiting_capability_approval');
    assert.ok(waiting, 'must surface the capability-specific wait without LS auto-approval');
    assert.equal(messages.find((msg) => msg.type === 'text')?.content, 'capability approved');
  });

  test('capability_pending also disables the generic stall auto-approve probe', async () => {
    const resolveOutstandingSteps = mock.fn(async () => {});
    const waitingStep = {
      type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: {
        toolCall: {
          id: 'toolu_capability_stall',
          name: 'run_command',
          argumentsJson: JSON.stringify({ CommandLine: 'echo hi', Cwd: '/tmp', SafeToAutoRun: true }),
        },
        sourceTrajectoryStepInfo: { trajectoryId: 'trajectory-1', stepIndex: 8 },
      },
    };
    const bridge = {
      ...createMockServiceBridge({ resolveOutstandingSteps }),
      nativeExecuteAndPush: mock.fn(async () => 'capability_pending'),
      pollForSteps: mock.fn(async function* () {
        yield {
          steps: [waitingStep],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 0,
            terminalSeen: false,
            lastActivityAt: Date.now(),
            awaitingUserInput: false,
          },
        };
        throw new Error('Antigravity stall: capability approval is still pending');
      }),
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('run command'));
    assert.equal(resolveOutstandingSteps.mock.calls.length, 0);
    assert.match(messages.find((msg) => msg.type === 'error')?.error ?? '', /capability approval is still pending/);
  });

  test('capability_blocked terminates without any legacy auto-approve fallback', async () => {
    const resolveOutstandingSteps = mock.fn(async () => {});
    const waitingStep = {
      type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: {
        toolCall: {
          id: 'toolu_capability_blocked',
          name: 'run_command',
          argumentsJson: JSON.stringify({ CommandLine: 'echo hi', Cwd: '/tmp', SafeToAutoRun: true }),
        },
        sourceTrajectoryStepInfo: { trajectoryId: 'trajectory-1', stepIndex: 9 },
      },
    };
    const bridge = {
      ...createMockServiceBridge({ resolveOutstandingSteps }),
      isCapabilityReceiptScope: mock.fn(() => true),
      nativeExecuteAndPush: mock.fn(async () => 'capability_blocked'),
      pollForSteps: mock.fn(async function* () {
        yield {
          steps: [waitingStep],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 0,
            terminalSeen: false,
            lastActivityAt: Date.now(),
            awaitingUserInput: false,
          },
        };
      }),
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('run command'));

    assert.equal(resolveOutstandingSteps.mock.calls.length, 0);
    assert.ok(messages.some((msg) => msg.errorCode === 'capability_authorization_blocked'));
  });

  test('P1: probe retry resumes from last delivered cursor, not from stepsBefore', async () => {
    const resolveOutstandingSteps = mock.fn(async () => {});
    let callCount = 0;
    const bridge = {
      ...createMockServiceBridge({ resolveOutstandingSteps }),
      pollForSteps: mock.fn(async function* () {
        callCount++;
        if (callCount === 1) {
          // First poll: deliver one step, then stall
          yield {
            steps: [
              {
                type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                status: 'DONE',
                plannerResponse: { response: 'first chunk' },
              },
            ],
            cursor: {
              baselineStepCount: 0,
              lastDeliveredStepCount: 1,
              terminalSeen: false,
              lastActivityAt: Date.now(),
            },
          };
          throw new Error('Antigravity stall: no activity for 60213ms (steps=1, status=CASCADE_RUN_STATUS_RUNNING)');
        }
        // Second poll (after probe): only the NEW step, not the old one
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: { response: 'second chunk' },
            },
          ],
          cursor: {
            baselineStepCount: 1,
            lastDeliveredStepCount: 2,
            terminalSeen: true,
            lastActivityAt: Date.now(),
          },
        };
      }),
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('open browser'));

    const texts = messages.filter((msg) => msg.type === 'text');
    // Must be exactly 2 text messages, no duplicates
    assert.equal(texts.length, 2, 'must not replay already-delivered steps');
    assert.equal(texts[0].content, 'first chunk');
    assert.equal(texts[1].content, 'second chunk');

    // pollForSteps must have been called with updated cursor on retry
    assert.equal(bridge.pollForSteps.mock.calls.length, 2);
    // Second call should start from step 1 (last delivered), not 0 (original stepsBefore)
    assert.equal(bridge.pollForSteps.mock.calls[1].arguments[1], 1, 'retry must resume from lastDeliveredStepCount=1');
  });

  test('service does not probe on stall when autoApprove=false', async () => {
    const resolveOutstandingSteps = mock.fn(async () => {});
    const bridge = {
      ...createMockServiceBridge({ resolveOutstandingSteps }),
      pollForSteps: mock.fn(async function* () {
        throw new Error('Antigravity stall: no activity for 60213ms (steps=5, status=CASCADE_RUN_STATUS_RUNNING)');
      }),
    };
    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'claude-opus-4-6',
      bridge,
      autoApprove: false,
    });

    const messages = await collect(service.invoke('open browser'));

    assert.equal(resolveOutstandingSteps.mock.calls.length, 0, 'should NOT probe when autoApprove=false');
    const errors = messages.filter((msg) => msg.type === 'error');
    assert.ok(errors.length >= 1, 'should emit error on stall');
    assert.match(errors[0].error, /stall/i);
  });

  test('service emits liveness_signal when autoApprove=false', async () => {
    const resolveOutstandingSteps = mock.fn(async () => {});
    const bridge = createMockServiceBridge({ resolveOutstandingSteps });
    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'claude-opus-4-6',
      bridge,
      autoApprove: false,
    });

    const messages = await collect(service.invoke('open browser'));

    assert.equal(resolveOutstandingSteps.mock.calls.length, 0, 'should NOT call resolveOutstandingSteps');

    const waiting = messages.find((msg) => msg.type === 'liveness_signal');
    assert.ok(waiting, 'should emit liveness_signal when auto-approve disabled');
    const parsed = JSON.parse(waiting.content);
    assert.equal(parsed.type, 'info');
    assert.match(parsed.message, /等待权限批准/);
  });

  test('Bug-7 P1: keeps upstream_error when stream_error also present in same batch', async () => {
    const bridge = {
      ...createMockServiceBridge(),
      pollForSteps: mock.fn(async function* () {
        // LS sends generic stream_error THEN specific upstream_error in one batch
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: { stopReason: 'STOP_REASON_CLIENT_STREAM_ERROR' },
            },
            {
              type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
              status: 'DONE',
              errorMessage: { error: { userErrorMessage: 'The model produced an invalid tool call.' } },
            },
          ],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 2,
            terminalSeen: true,
            lastActivityAt: Date.now(),
          },
        };
      }),
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('test'));

    const errors = messages.filter((msg) => msg.type === 'error');
    // Must keep the more specific upstream_error, not swallow it behind stream_error
    const hasUpstream = errors.some((e) => e.errorCode === 'upstream_error');
    assert.ok(hasUpstream, 'upstream_error must NOT be suppressed when stream_error also present');
    assert.match(errors.find((e) => e.errorCode === 'upstream_error').error, /invalid tool call/i);
    // stream_error should be suppressed in favor of upstream_error
    const hasStream = errors.some((e) => e.errorCode === 'stream_error');
    assert.equal(hasStream, false, 'stream_error should be suppressed when upstream_error provides more detail');
  });

  test('G10: model_capacity error emitted correctly at service level', async () => {
    const bridge = {
      ...createMockServiceBridge(),
      pollForSteps: mock.fn(async function* () {
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
              status: 'DONE',
              errorMessage: {
                error: {
                  userErrorMessage:
                    'Our servers are experiencing high traffic right now, please try again in a minute.',
                },
              },
            },
          ],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 1,
            terminalSeen: true,
            lastActivityAt: Date.now(),
          },
        };
      }),
    };
    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'claude-opus-4-6',
      bridge,
      modelCapacityRetryDelaysMs: [],
    });

    const messages = await collect(service.invoke('test'));

    const errors = messages.filter((m) => m.type === 'error');
    assert.equal(errors.length, 1, 'should emit exactly one error');
    assert.equal(errors[0].errorCode, 'model_capacity', 'high traffic must be classified as model_capacity');
    assert.match(errors[0].error, /high traffic/i);
  });

  test('G10: model_capacity with tool activity still classifies correctly', async () => {
    const bridge = {
      ...createMockServiceBridge(),
      pollForSteps: mock.fn(async function* () {
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_TOOL_CALL',
              status: 'DONE',
              toolCall: { toolName: 'web_search', input: '{}' },
            },
            {
              type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
              status: 'DONE',
              errorMessage: {
                error: {
                  userErrorMessage:
                    'Our servers are experiencing high traffic right now, please try again in a minute.',
                },
              },
            },
          ],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 2,
            terminalSeen: true,
            lastActivityAt: Date.now(),
          },
        };
      }),
    };
    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'claude-opus-4-6',
      bridge,
      modelCapacityRetryDelaysMs: [],
    });

    const messages = await collect(service.invoke('test'));

    const errors = messages.filter((m) => m.type === 'error');
    assert.ok(errors.length >= 1, 'should emit error');
    assert.equal(errors[0].errorCode, 'model_capacity');
  });

  test('Bug-7: deduplicates consecutive upstream_error in same batch', async () => {
    const bridge = {
      ...createMockServiceBridge(),
      pollForSteps: mock.fn(async function* () {
        // LS sends two identical ERROR_MESSAGE steps in one batch
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
              status: 'DONE',
              errorMessage: { error: { userErrorMessage: 'The model produced an invalid tool call.' } },
            },
            {
              type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
              status: 'DONE',
              errorMessage: { error: { userErrorMessage: 'The model produced an invalid tool call.' } },
            },
          ],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 2,
            terminalSeen: true,
            lastActivityAt: Date.now(),
          },
        };
      }),
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });

    const messages = await collect(service.invoke('test'));

    const errors = messages.filter((msg) => msg.type === 'error');
    // Must yield only ONE error to the user, not two identical red bars
    assert.equal(errors.length, 1, 'duplicate upstream_error must be deduplicated to single error');
    assert.match(errors[0].error, /invalid tool call/i);
  });
});
