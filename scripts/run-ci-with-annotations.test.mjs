import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createDiagnosticLineCollector,
  escapeWorkflowCommand,
  redactDiagnostic,
  summarizeTapFailure,
} from './run-ci-with-annotations.mjs';

describe('GitHub CI failure annotations', () => {
  it('extracts TAP failures and totals without dumping unrelated logs', () => {
    const summary = summarizeTapFailure(`
TAP version 13
noisy line
    not ok 2 - linux path contract
      failureType: 'testCodeFailure'
      error: 'expected /tmp, got /private/tmp'
# tests 3
# pass 2
# fail 1
`);
    assert.match(summary, /not ok 2 - linux path contract/);
    assert.match(summary, /error: 'expected \/tmp, got \/private\/tmp'/);
    assert.match(summary, /fail 1/);
    assert.doesNotMatch(summary, /noisy line/);
  });

  it('keeps the first lines of block-style TAP errors', () => {
    const summary = summarizeTapFailure(`
    not ok 1 - native module contract
      error: |-
        The module was compiled for NODE_MODULE_VERSION 141.
        This Node.js requires NODE_MODULE_VERSION 115.
      code: 'ERR_DLOPEN_FAILED'
`);
    assert.match(summary, /compiled for NODE_MODULE_VERSION 141/);
    assert.match(summary, /ERR_DLOPEN_FAILED/);
  });

  it('retains an early failure across stream chunks after the bounded tail moves on', () => {
    const collector = createDiagnosticLineCollector();
    collector.write('stdout', 'not o');
    collector.write('stdout', 'k 1 - early Linux failure\n');
    collector.write('stdout', `${'noise'.repeat(100_000)}\n`);
    const output = collector.finish();
    assert.match(output, /not ok 1 - early Linux failure/);
    assert.doesNotMatch(output, /noise/);
  });

  it('redacts credentials before publishing diagnostics', () => {
    const redacted = redactDiagnostic('Bearer abc123 authorization=secret token=value sk_agent_example123');
    assert.equal(redacted, 'Bearer <redacted> authorization=<redacted> token=<redacted> sk_agent_<redacted>');
  });

  it('escapes GitHub workflow command control characters', () => {
    assert.equal(escapeWorkflowCommand('a%b\nc\r'), 'a%25b%0Ac%0D');
  });
});
