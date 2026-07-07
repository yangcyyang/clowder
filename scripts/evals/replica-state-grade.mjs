#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const DEFAULT_MIN_NAME_COVERAGE = 0.8;

function parseArgs(argv) {
  const args = {
    minNameCoverage: DEFAULT_MIN_NAME_COVERAGE,
    required: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    const next = argv[index + 1];
    switch (item) {
      case '--target':
      case '--target-url':
        args.target = next;
        index += 1;
        break;
      case '--reference':
      case '--reference-html':
        args.reference = next;
        index += 1;
        break;
      case '--repo':
        args.repo = next;
        index += 1;
        break;
      case '--expected-total':
        args.expectedTotal = Number.parseInt(next, 10);
        index += 1;
        break;
      case '--min-name-coverage':
        args.minNameCoverage = Number.parseFloat(next);
        index += 1;
        break;
      case '--required':
        args.required = next
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
        index += 1;
        break;
      case '--json':
        args.json = true;
        break;
      default:
        throw new Error(`Unknown argument: ${item}`);
    }
  }

  if (!args.target) throw new Error('Missing --target URL or file path');
  if (!args.reference) throw new Error('Missing --reference HTML/file path');
  if (!args.repo) throw new Error('Missing --repo path');
  if (!Number.isFinite(args.minNameCoverage) || args.minNameCoverage < 0 || args.minNameCoverage > 1) {
    throw new Error('--min-name-coverage must be a number between 0 and 1');
  }
  return args;
}

function isUrl(value) {
  return /^https?:\/\//i.test(value);
}

async function readTarget(value) {
  if (!isUrl(value)) {
    const path = resolve(value);
    if (!existsSync(path)) throw new Error(`File not found: ${path}`);
    return { ok: true, status: 'file', bytes: readFileSync(path, 'utf8').length, html: readFileSync(path, 'utf8') };
  }

  const response = await fetch(value);
  const html = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    bytes: Buffer.byteLength(html, 'utf8'),
    html,
  };
}

function decodeEscapes(value) {
  return value
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function normalizeText(value) {
  return decodeEscapes(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function unescapeJsonString(value) {
  try {
    return JSON.parse(`"${value.replace(/"/g, '\\"')}"`);
  } catch {
    return decodeEscapes(value);
  }
}

function unique(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function extractToolNames(html) {
  const names = [];
  const decoded = decodeEscapes(html);

  for (const match of decoded.matchAll(/"name"\s*:\s*"((?:\\.|[^"\\])+)"/g)) {
    names.push(unescapeJsonString(match[1]));
  }

  for (const match of decoded.matchAll(/^###\s+(.+?)\s*$/gm)) {
    const name = match[1].replace(/\s+/g, ' ').trim();
    if (name && !name.includes('核心功能点')) names.push(name);
  }

  return unique(names).filter((name) => {
    if (name.length < 2 || name.length > 80) return false;
    if (/^(next\.|metadata$|viewport$|description$|children$|default$|react\.|script-)/i.test(name)) return false;
    if (/^(core function|core features|draft\s+\d*:)/i.test(name)) return false;
    if (/^(\d+|[一二三四五六七八九十]+)[.、]/.test(name)) return false;
    return true;
  });
}

function extractTotal(html) {
  const decoded = decodeEscapes(html);
  const patterns = [/全部工具\s*[·:：-]?\s*(\d{2,5})/i, /(\d{2,5})\s*(?:tools|工具)/i, /"total"\s*:\s*(\d{2,5})/i];
  for (const pattern of patterns) {
    const match = decoded.match(pattern);
    if (match?.[1]) return Number.parseInt(match[1], 10);
  }
  return null;
}

function gitInfo(repoPath) {
  const repo = resolve(repoPath);
  try {
    const inside = execFileSync('git', ['-C', repo, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (inside !== 'true') return { ok: false, repo, reason: 'not a git worktree' };

    const commitCount = Number.parseInt(
      execFileSync('git', ['-C', repo, 'rev-list', '--count', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(),
      10,
    );
    const head = execFileSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const subject = execFileSync('git', ['-C', repo, 'log', '-1', '--pretty=%s'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const status = execFileSync('git', ['-C', repo, 'status', '--short'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

    return {
      ok: commitCount > 0,
      repo,
      commitCount,
      head,
      subject,
      dirty: Boolean(status),
      status,
    };
  } catch (error) {
    return { ok: false, repo, reason: error instanceof Error ? error.message : String(error) };
  }
}

function isPathInside(parentPath, candidatePath) {
  const parent = resolve(parentPath);
  const candidate = resolve(candidatePath);
  const relativePath = relative(parent, candidate);
  if (relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))) return true;
  return isPathInsideByInode(parent, candidate);
}

function sameFsEntry(leftPath, rightPath) {
  try {
    const left = statSync(leftPath);
    const right = statSync(rightPath);
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
}

function isPathInsideByInode(parentPath, candidatePath) {
  let cursor = candidatePath;
  try {
    if (!statSync(cursor).isDirectory()) cursor = dirname(cursor);
  } catch {
    cursor = dirname(cursor);
  }

  while (true) {
    if (sameFsEntry(parentPath, cursor)) return true;
    const next = dirname(cursor);
    if (next === cursor) return false;
    cursor = next;
  }
}

function localHttpPort(value) {
  if (!isUrl(value)) return null;

  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) return null;
  if (url.port) return url.port;
  return url.protocol === 'https:' ? '443' : '80';
}

function readProcessCwd(pid) {
  try {
    const output = execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const cwdLine = output
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('n'));
    return cwdLine ? cwdLine.slice(1) : null;
  } catch {
    return null;
  }
}

function listeningCwdsForPort(port) {
  try {
    const output = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('p'))
      .map((line) => readProcessCwd(line.slice(1)))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function targetBindingInfo(target, repoInfo) {
  if (!repoInfo.ok) {
    return { ok: false, detail: repoInfo.reason ?? 'repo has no commit' };
  }
  if (repoInfo.dirty) {
    return {
      ok: false,
      detail: `repo has uncommitted changes; target cannot be bound to clean commit ${repoInfo.head}`,
    };
  }

  if (!isUrl(target)) {
    const targetPath = resolve(target);
    if (!isPathInside(repoInfo.repo, targetPath)) {
      return { ok: false, detail: `target file is outside repo: ${targetPath}` };
    }
    return { ok: true, detail: `file target is inside repo at commit ${repoInfo.head}` };
  }

  const port = localHttpPort(target);
  if (!port) {
    return { ok: false, detail: 'non-local URL cannot be bound to a local git commit' };
  }

  const cwds = listeningCwdsForPort(port);
  const boundCwd = cwds.find((cwd) => isPathInside(repoInfo.repo, cwd));
  if (!boundCwd) {
    const cwdList = cwds.length > 0 ? cwds.join(', ') : 'none';
    return { ok: false, detail: `localhost:${port} listener cwd is not inside repo; cwd=${cwdList}` };
  }

  return { ok: true, detail: `localhost:${port} listener cwd=${boundCwd}; commit=${repoInfo.head}` };
}

function includesSignal(normalizedTarget, signal) {
  return normalizedTarget.includes(normalizeText(signal));
}

function grade({ targetResult, referenceHtml, repoInfo, args }) {
  const targetNames = extractToolNames(targetResult.html);
  const referenceNames = extractToolNames(referenceHtml);
  if (referenceNames.length === 0) {
    throw new Error('Reference parsed zero tool names; check --reference input before grading clone quality.');
  }
  const normalizedTargetHtml = normalizeText(targetResult.html);
  const matchedNames = referenceNames.filter((name) => includesSignal(normalizedTargetHtml, name));
  const missingNames = referenceNames.filter((name) => !includesSignal(normalizedTargetHtml, name));
  const nameCoverage = referenceNames.length > 0 ? matchedNames.length / referenceNames.length : 0;
  const targetTotal = extractTotal(targetResult.html);
  const referenceTotal = extractTotal(referenceHtml);
  const expectedTotal = args.expectedTotal ?? referenceTotal;
  const totalOk =
    expectedTotal == null ||
    targetTotal === expectedTotal ||
    includesSignal(normalizedTargetHtml, String(expectedTotal));
  const requiredResults = args.required.map((signal) => ({
    signal,
    ok: includesSignal(normalizedTargetHtml, signal),
  }));
  const requiredOk = requiredResults.every((item) => item.ok);
  const targetBinding = targetBindingInfo(args.target, repoInfo);

  const checks = [
    { id: 'page_reachable', ok: targetResult.ok, detail: `status=${targetResult.status}, bytes=${targetResult.bytes}` },
    {
      id: 'target_bound_to_commit',
      ok: targetBinding.ok,
      detail: targetBinding.ok
        ? `${targetBinding.detail}; ${repoInfo.subject} (${repoInfo.commitCount} commits)`
        : targetBinding.detail,
    },
    {
      id: 'reference_name_coverage',
      ok: nameCoverage >= args.minNameCoverage,
      detail: `${matchedNames.length}/${referenceNames.length} = ${(nameCoverage * 100).toFixed(1)}%`,
    },
    {
      id: 'expected_total',
      ok: totalOk,
      detail: `target=${targetTotal ?? 'unknown'}, expected=${expectedTotal ?? 'not set'}`,
    },
    {
      id: 'required_signals',
      ok: requiredOk,
      detail: requiredResults.map((item) => `${item.ok ? 'hit' : 'miss'}:${item.signal}`).join(', ') || 'none',
    },
  ];

  return {
    verdict: checks.every((check) => check.ok) ? 'pass' : 'fail',
    checks,
    target: {
      input: args.target,
      status: targetResult.status,
      bytes: targetResult.bytes,
      total: targetTotal,
      extractedNameCount: targetNames.length,
    },
    reference: {
      input: args.reference,
      total: referenceTotal,
      extractedNameCount: referenceNames.length,
    },
    repo: repoInfo,
    coverage: {
      minRequired: args.minNameCoverage,
      matchedCount: matchedNames.length,
      referenceCount: referenceNames.length,
      ratio: nameCoverage,
      sampleMatched: matchedNames.slice(0, 12),
      sampleMissing: missingNames.slice(0, 12),
    },
    requiredSignals: requiredResults,
  };
}

function renderMarkdown(result) {
  const lines = [
    '# Replica State Grading Report',
    '',
    `Verdict: **${result.verdict.toUpperCase()}**`,
    '',
    '## Inputs',
    `- Target: ${result.target.input}`,
    `- Reference: ${result.reference.input}`,
    `- Repo: ${result.repo.repo}`,
    '',
    '## Checks',
    ...result.checks.map((check) => `- ${check.ok ? 'PASS' : 'FAIL'} ${check.id}: ${check.detail}`),
    '',
    '## Coverage',
    `- Matched reference names: ${result.coverage.matchedCount}/${result.coverage.referenceCount}`,
    `- Ratio: ${(result.coverage.ratio * 100).toFixed(1)}% (minimum ${(result.coverage.minRequired * 100).toFixed(1)}%)`,
    `- Target extracted names: ${result.target.extractedNameCount}`,
    `- Reference extracted names: ${result.reference.extractedNameCount}`,
    '',
    '## Sample Matched',
    ...result.coverage.sampleMatched.map((name) => `- ${name}`),
    '',
    '## Sample Missing',
    ...(result.coverage.sampleMissing.length > 0
      ? result.coverage.sampleMissing.map((name) => `- ${name}`)
      : ['- None in first sample']),
  ];

  if (result.repo.dirty) {
    lines.push('', '## Repo Dirty State', '```text', result.repo.status, '```');
  }

  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [targetResult, referenceResult] = await Promise.all([readTarget(args.target), readTarget(args.reference)]);
  const repoInfo = gitInfo(args.repo);
  const result = grade({
    targetResult,
    referenceHtml: referenceResult.html,
    repoInfo,
    args,
  });

  process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : renderMarkdown(result));
  process.exitCode = result.verdict === 'pass' ? 0 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
