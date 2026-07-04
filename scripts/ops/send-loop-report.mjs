#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const DEFAULT_API_URL = 'http://127.0.0.1:3004';
const DEFAULT_THREAD_ID = 'default';
const DEFAULT_USER = 'codex';

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function usage(exitCode = 0) {
  const out = exitCode === 0 ? console.log : console.error;
  out(`Usage:
  node scripts/ops/send-loop-report.mjs --content-file /tmp/report.txt
  node scripts/ops/send-loop-report.mjs --content "[loop] N8 ... completed\\n..."

Options:
  --api-url <url>       Default: ${DEFAULT_API_URL}
  --thread <id>         Default: ${DEFAULT_THREAD_ID}
  --user <id>           Default: ${DEFAULT_USER}
  --delivery-mode <m>   immediate | queue | force. Default: immediate
  --dry-run             Validate and print payload without sending

Contract:
  Content must be 1-5 lines.
  First line must start with "[loop] ".
  If review is needed, put the reviewer mention at the start of its own line.`);
  process.exit(exitCode);
}

function readStdin() {
  if (process.stdin.isTTY) return '';
  return readFileSync(0, 'utf8');
}

function resolveContent() {
  const inline = readArg('--content');
  if (inline !== undefined) return inline.replaceAll('\\n', '\n');

  const file = readArg('--content-file');
  if (file) return readFileSync(file, 'utf8');

  return readStdin();
}

function validateContent(content) {
  const normalized = content.replace(/\s+$/g, '');
  if (!normalized.trim()) throw new Error('report content is required');
  const lines = normalized.split(/\r?\n/);
  if (lines.length > 5) throw new Error(`report must be <= 5 lines, got ${lines.length}`);
  if (!lines[0].startsWith('[loop] ')) throw new Error('first line must start with "[loop] "');
  for (const [index, line] of lines.entries()) {
    if (line.length > 180) throw new Error(`line ${index + 1} is too long (${line.length} chars)`);
  }
  return normalized;
}

async function main() {
  if (hasFlag('--help') || hasFlag('-h')) usage(0);

  const apiUrl = (readArg('--api-url') || process.env.CLOWDER_API_URL || DEFAULT_API_URL).replace(/\/+$/, '');
  const threadId = readArg('--thread') || process.env.CLOWDER_REPORT_THREAD_ID || DEFAULT_THREAD_ID;
  const user = readArg('--user') || process.env.CLOWDER_REPORT_USER || DEFAULT_USER;
  const deliveryMode = readArg('--delivery-mode') || 'immediate';
  if (!['immediate', 'queue', 'force'].includes(deliveryMode)) {
    throw new Error(`invalid --delivery-mode: ${deliveryMode}`);
  }

  const content = validateContent(resolveContent());
  const payload = { threadId, content, deliveryMode };

  if (hasFlag('--dry-run')) {
    console.log(JSON.stringify({ apiUrl, user, payload }, null, 2));
    return;
  }

  const response = await fetch(`${apiUrl}/api/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Cat-Cafe-User': user,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(`POST /api/messages failed: ${response.status} ${response.statusText}`);
    error.details = body;
    throw error;
  }
  console.log(JSON.stringify(body, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exit(1);
});
