#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_CAPTURE_CHARS = 256_000;
const MAX_ANNOTATION_CHARS = 8_000;
const MAX_SUMMARY_LINES = 40;
const MAX_COLLECTED_DIAGNOSTIC_LINES = 500;

function appendBounded(current, chunk) {
  const combined = current + chunk;
  return combined.length > MAX_CAPTURE_CHARS ? combined.slice(-MAX_CAPTURE_CHARS) : combined;
}

export function createDiagnosticLineCollector() {
  const partial = { stdout: '', stderr: '' };
  const blockLinesRemaining = { stdout: 0, stderr: 0 };
  const collected = [];

  const collectLine = (stream, line) => {
    const isErrorBlockStart = /^\s*error:\s*(?:\|-)?\s*$/u.test(line);
    const isStructuredDiagnostic =
      /^\s*not ok\s+\d+\s+-\s+/u.test(line) ||
      /^\s*(?:failureType|error|code|expected|actual|operator):\s+/u.test(line) ||
      /^\s*#\s*(?:tests|pass|fail|cancelled|skipped)\s+\d+\s*$/u.test(line);
    if (isStructuredDiagnostic || blockLinesRemaining[stream] > 0) {
      if (collected.length < MAX_COLLECTED_DIAGNOSTIC_LINES) collected.push(line.slice(0, 2_000));
    }
    if (isErrorBlockStart) {
      blockLinesRemaining[stream] = 4;
    } else if (blockLinesRemaining[stream] > 0 && line.trim()) {
      blockLinesRemaining[stream] -= 1;
    }
  };

  return {
    write(stream, chunk) {
      const combined = partial[stream] + chunk;
      const lines = combined.split(/\r?\n/);
      partial[stream] = lines.pop() ?? '';
      for (const line of lines) collectLine(stream, line);
    },
    finish() {
      for (const stream of ['stdout', 'stderr']) {
        if (partial[stream]) collectLine(stream, partial[stream]);
      }
      return collected.join('\n');
    },
  };
}

export function redactDiagnostic(value) {
  return value
    .replace(/sk_(agent|machine)_[A-Za-z0-9_-]+/g, 'sk_$1_<redacted>')
    .replace(/Bearer\s+[^\s'"`]+/gi, 'Bearer <redacted>')
    .replace(/(authorization|token|secret|password)=([^\s]+)/gi, '$1=<redacted>');
}

export function summarizeTapFailure(output) {
  const lines = redactDiagnostic(output).split(/\r?\n/);
  const selected = [];
  const seen = new Set();
  let errorBlockLinesRemaining = 0;
  const keep = (line) => {
    const normalized = line.trim().replace(/^#\s*/, '');
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    selected.push(normalized);
  };

  for (const line of lines) {
    if (/^\s*not ok\s+\d+\s+-\s+/u.test(line)) keep(line);
    if (/^\s*(?:failureType|error|code|expected|actual|operator):\s+/u.test(line)) keep(line);
    if (/^\s*error:\s*(?:\|-)?\s*$/u.test(line)) {
      errorBlockLinesRemaining = 4;
      continue;
    }
    if (errorBlockLinesRemaining > 0 && line.trim()) {
      keep(line);
      errorBlockLinesRemaining -= 1;
    }
    if (/^\s*#\s*(?:tests|pass|fail|cancelled|skipped)\s+\d+\s*$/u.test(line)) keep(line);
  }

  if (selected.length === 0) {
    for (const line of lines.slice(-20)) keep(line);
  }

  const summary = selected.slice(0, MAX_SUMMARY_LINES).join('\n');
  return summary.length > MAX_ANNOTATION_CHARS
    ? `${summary.slice(0, MAX_ANNOTATION_CHARS - 15)}\n…<truncated>`
    : summary;
}

export function escapeWorkflowCommand(value) {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function parseArgs(args) {
  const separator = args.indexOf('--');
  if (separator === -1 || separator === args.length - 1) {
    throw new Error('usage: run-ci-with-annotations.mjs --label <label> -- <command> [args...]');
  }
  const labelIndex = args.indexOf('--label');
  const label = labelIndex !== -1 && labelIndex + 1 < separator ? args[labelIndex + 1] : 'CI step';
  return { label, command: args[separator + 1], commandArgs: args.slice(separator + 2) };
}

export async function runWithAnnotations(args = process.argv.slice(2)) {
  const { label, command, commandArgs } = parseArgs(args);
  let captured = '';
  const diagnosticCollector = createDiagnosticLineCollector();
  const child = spawn(command, commandArgs, { stdio: ['inherit', 'pipe', 'pipe'] });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    const text = chunk.toString();
    captured = appendBounded(captured, text);
    diagnosticCollector.write('stdout', text);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    const text = chunk.toString();
    captured = appendBounded(captured, text);
    diagnosticCollector.write('stderr', text);
  });

  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0 || signal) {
        const title = escapeWorkflowCommand(`${label} failed`);
        const diagnosticOutput = diagnosticCollector.finish();
        const summary = escapeWorkflowCommand(summarizeTapFailure(diagnosticOutput || captured));
        process.stdout.write(`\n::error title=${title}::${summary}\n`);
      }
      resolvePromise(exitCode);
    });
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  runWithAnnotations()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`[ci-annotations] ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
