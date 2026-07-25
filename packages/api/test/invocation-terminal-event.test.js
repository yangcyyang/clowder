/**
 * invocation-terminal-event.ts tests (batch 3-B, item 1 — Terminal Invariant)
 * Maka absorption #2: a terminal InvocationStatus must be backed by an
 * immutable termination fact recorded in the same atomic write as the
 * status transition.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('invocation-terminal-event', () => {
  /** @type {typeof import('../dist/domains/cats/services/stores/ports/invocation-terminal-event.js')} */
  let mod;

  test('module loads', async () => {
    mod = await import('../dist/domains/cats/services/stores/ports/invocation-terminal-event.js');
    assert.ok(mod.resolveTerminalEvent);
    assert.ok(mod.buildTerminalEvent);
    assert.ok(mod.isTerminalInvocationStatus);
    assert.ok(mod.TERMINAL_INVOCATION_STATUSES);
  });

  test('TERMINAL_INVOCATION_STATUSES is exactly succeeded/failed/canceled', () => {
    assert.deepEqual([...mod.TERMINAL_INVOCATION_STATUSES].sort(), ['canceled', 'failed', 'succeeded']);
  });

  test('isTerminalInvocationStatus rejects non-terminal and unknown statuses', () => {
    assert.equal(mod.isTerminalInvocationStatus('running'), false);
    assert.equal(mod.isTerminalInvocationStatus('queued'), false);
    assert.equal(mod.isTerminalInvocationStatus(undefined), false);
    assert.equal(mod.isTerminalInvocationStatus('bogus'), false);
  });

  test('resolveTerminalEvent returns undefined for non-terminal target status', () => {
    assert.equal(mod.resolveTerminalEvent({ status: 'running' }), undefined);
    assert.equal(mod.resolveTerminalEvent({ status: undefined }), undefined);
  });

  test('resolveTerminalEvent honors an explicit terminalEvent verbatim', () => {
    const explicit = mod.buildTerminalEvent('process_restart', 'startup-reconciler', { previousStatus: 'running' });
    const resolved = mod.resolveTerminalEvent({ status: 'failed', terminalEvent: explicit });
    assert.equal(resolved, explicit);
  });

  test('resolveTerminalEvent synthesizes a benign implicit event for succeeded with no explicit fact', () => {
    const resolved = mod.resolveTerminalEvent({ status: 'succeeded' });
    assert.equal(resolved.kind, 'succeeded');
    assert.equal(resolved.source, 'legacy-implicit');
    assert.ok(resolved.at > 0);
  });

  test('resolveTerminalEvent synthesizes a benign implicit event for canceled with no explicit fact', () => {
    const resolved = mod.resolveTerminalEvent({ status: 'canceled' });
    assert.equal(resolved.kind, 'canceled_system');
    assert.equal(resolved.source, 'legacy-implicit');
  });

  test('resolveTerminalEvent classifies failed-with-error via provider-error-classification', () => {
    const resolved = mod.resolveTerminalEvent({ status: 'failed', error: 'connect ECONNRESET' });
    assert.equal(resolved.kind, 'transient_network');
    assert.equal(resolved.source, 'derived-from-error');
    assert.equal(resolved.detail.error, 'connect ECONNRESET');
  });

  test('resolveTerminalEvent tags failed-with-no-error as missing_terminal_event (Maka anomaly case)', () => {
    const resolved = mod.resolveTerminalEvent({ status: 'failed' });
    assert.equal(resolved.kind, 'missing_terminal_event');
    assert.equal(resolved.source, 'invocation-record-store');
    assert.equal(resolved.detail.attemptedStatus, 'failed');
  });

  test('resolveTerminalEvent treats whitespace-only error as no evidence', () => {
    const resolved = mod.resolveTerminalEvent({ status: 'failed', error: '   ' });
    assert.equal(resolved.kind, 'missing_terminal_event');
  });

  test('buildTerminalEvent stamps kind/source/at and omits detail when absent', () => {
    const before = Date.now();
    const event = mod.buildTerminalEvent('agent_error', 'test-source');
    assert.equal(event.kind, 'agent_error');
    assert.equal(event.source, 'test-source');
    assert.ok(event.at >= before);
    assert.equal('detail' in event, false);
  });

  test('buildTerminalEvent preserves detail when provided', () => {
    const event = mod.buildTerminalEvent('agent_error', 'test-source', { foo: 'bar' });
    assert.deepEqual(event.detail, { foo: 'bar' });
  });
});
