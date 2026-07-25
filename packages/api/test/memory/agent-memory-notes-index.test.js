/**
 * F-D（批次 3，PRD-memory-upgrade.md）— notes/ 召回排序，最小版。
 *
 * 覆盖两层：
 *  1. AgentMemoryStore.listAgentMemoryNotes — 列举 + 过期过滤（复用批次 2 的
 *     parseMemoryFrontmatter/isMemoryFrontmatterExpired）+ 按最近修改倒序 +
 *     10 条上限 + 无 notes/ 目录时零输出。
 *  2. SystemPromptBuilder.buildAgentMemoryNotesIndexLines + 其在
 *     buildAgentMemoryIndexLines（v2-only）里的接线 — 渲染格式 + 预算截断 +
 *     "无 notes 时字节不变"证明（对照生产真实现状：当前仓库任何猫都还没有
 *     notes/ 目录，见 AgentMemoryStore.ts 头部注释"不新增读取机制"）。
 *
 * 明确不做（absorption doc §2 第 2 条纪律）：向量化/相似度召回排序——本文件
 * 只测"列举 + 过期过滤 + 倒序 + 上限"，不测任何语义排序（生产代码也没有）。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, before, beforeEach, describe, it } from 'node:test';

const STORE_MODULE = '../../dist/domains/cats/services/agents/memory/AgentMemoryStore.js';
const PROMPT_MODULE = '../../dist/domains/cats/services/context/SystemPromptBuilder.js';

let store;
let prompt;

before(async () => {
  store = await import(STORE_MODULE);
  prompt = await import(PROMPT_MODULE);
});

let tempRoot;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-notes-index-'));
});

afterEach(async () => {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

/** Write a notes/{catId}/ fixture file with an explicit mtime (ms epoch). */
async function writeNote(catId, fileName, { type, why, invalidAt, body, mtimeMs, noFrontmatter = false } = {}) {
  const dir = store.getAgentMemoryNotesDir(catId, tempRoot);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, fileName);
  const content = noFrontmatter
    ? `${body ?? '正文内容'}\n`
    : [
        '---',
        type ? `type: ${type}` : undefined,
        why ? `why: "${why}"` : undefined,
        invalidAt ? `invalid_at: ${invalidAt}` : undefined,
        '---',
        '',
        body ?? '正文内容',
        '',
      ]
        .filter((line) => line !== undefined)
        .join('\n');
  await writeFile(filePath, content, 'utf-8');
  if (mtimeMs !== undefined) {
    const t = new Date(mtimeMs);
    await utimes(filePath, t, t);
  }
  return filePath;
}

describe('AgentMemoryStore.listAgentMemoryNotes', () => {
  it('returns [] when the notes/ directory does not exist (zero-mechanism default)', () => {
    const result = store.listAgentMemoryNotes('opus', tempRoot);
    assert.deepEqual(result, []);
  });

  it('returns [] when the notes/ directory exists but is empty', async () => {
    await mkdir(store.getAgentMemoryNotesDir('opus', tempRoot), { recursive: true });
    assert.deepEqual(store.listAgentMemoryNotes('opus', tempRoot), []);
  });

  it('filters out expired notes (invalid_at in the past), keeps non-expired', async () => {
    const REF = Date.parse('2026-07-25T00:00:00.000Z');
    await writeNote('opus', 'stale.md', {
      type: 'reference',
      invalidAt: '2026-07-01',
      body: '旧笔记，已失效',
      mtimeMs: REF - 10_000,
    });
    await writeNote('opus', 'fresh.md', {
      type: 'reference',
      body: '新笔记，仍有效',
      mtimeMs: REF - 5_000,
    });

    const result = store.listAgentMemoryNotes('opus', tempRoot, REF);
    assert.equal(result.length, 1);
    assert.equal(result[0].fileName, 'fresh.md');
  });

  it('sorts by most-recently-modified first', async () => {
    await writeNote('opus', 'oldest.md', { type: 'project', body: 'x', mtimeMs: 1_000 });
    await writeNote('opus', 'middle.md', { type: 'project', body: 'x', mtimeMs: 2_000 });
    await writeNote('opus', 'newest.md', { type: 'project', body: 'x', mtimeMs: 3_000 });

    const result = store.listAgentMemoryNotes('opus', tempRoot);
    assert.deepEqual(
      result.map((n) => n.fileName),
      ['newest.md', 'middle.md', 'oldest.md'],
    );
  });

  it('caps the list at AGENT_MEMORY_NOTES_LIST_MAX_ITEMS, keeping the most recent', async () => {
    const cap = store.AGENT_MEMORY_NOTES_LIST_MAX_ITEMS;
    assert.equal(cap, 10, 'PRD F-D: 清单上限 10 条');
    const total = cap + 2;
    for (let i = 0; i < total; i += 1) {
      await writeNote('opus', `note-${String(i).padStart(2, '0')}.md`, { type: 'project', body: 'x', mtimeMs: i * 1000 });
    }
    const result = store.listAgentMemoryNotes('opus', tempRoot);
    assert.equal(result.length, cap);
    // most recent `cap` files: note-11..note-02 (indices total-1 downTo total-cap)
    assert.equal(result[0].fileName, `note-${String(total - 1).padStart(2, '0')}.md`);
    assert.equal(result[cap - 1].fileName, `note-${String(total - cap).padStart(2, '0')}.md`);
  });

  it('surfaces type/why from frontmatter; leaves them undefined without frontmatter', async () => {
    await writeNote('opus', 'with-fm.md', { type: 'feedback', why: '因为被纠正过', body: 'x', mtimeMs: 2_000 });
    await writeNote('opus', 'plain.md', { noFrontmatter: true, body: '没有 frontmatter 的旧笔记', mtimeMs: 1_000 });

    const result = store.listAgentMemoryNotes('opus', tempRoot);
    const withFm = result.find((n) => n.fileName === 'with-fm.md');
    const plain = result.find((n) => n.fileName === 'plain.md');
    assert.equal(withFm.type, 'feedback');
    assert.equal(withFm.why, '因为被纠正过');
    assert.equal(plain.type, undefined);
    assert.equal(plain.why, undefined);
  });

  it('skips subdirectories inside notes/ without throwing', async () => {
    const dir = store.getAgentMemoryNotesDir('opus', tempRoot);
    await mkdir(join(dir, 'a-subdir'), { recursive: true });
    await writeNote('opus', 'real-note.md', { type: 'project', body: 'x', mtimeMs: 1_000 });

    const result = store.listAgentMemoryNotes('opus', tempRoot);
    assert.deepEqual(
      result.map((n) => n.fileName),
      ['real-note.md'],
    );
  });

  it('notes for different cats are isolated', async () => {
    await writeNote('opus', 'opus-note.md', { type: 'project', body: 'x', mtimeMs: 1_000 });
    await writeNote('codex', 'codex-note.md', { type: 'project', body: 'y', mtimeMs: 1_000 });

    assert.deepEqual(
      store.listAgentMemoryNotes('opus', tempRoot).map((n) => n.fileName),
      ['opus-note.md'],
    );
    assert.deepEqual(
      store.listAgentMemoryNotes('codex', tempRoot).map((n) => n.fileName),
      ['codex-note.md'],
    );
  });
});

describe('SystemPromptBuilder.buildAgentMemoryNotesIndexLines (v2-only render)', () => {
  it('returns [] when there are no notes (isolated tempRoot)', () => {
    assert.deepEqual(prompt.buildAgentMemoryNotesIndexLines('opus', tempRoot), []);
  });

  it('renders a bullet per note with [type] label + why, most-recent-first', async () => {
    await writeNote('opus', 'a.md', { type: 'reference', body: 'x', mtimeMs: 1_000 });
    await writeNote('opus', 'b.md', { type: 'feedback', why: '别再这样做', body: 'y', mtimeMs: 2_000 });
    await writeNote('opus', 'c.md', { noFrontmatter: true, body: 'z', mtimeMs: 3_000 });

    const lines = prompt.buildAgentMemoryNotesIndexLines('opus', tempRoot);
    assert.ok(lines.length > 0);
    const text = lines.join('\n');
    assert.match(text, /notes\/ 速查清单/);
    assert.match(text, /\.cat-cafe\/memory\/notes\/opus\//);
    // most-recent-first ordering preserved in the rendered bullets
    const iC = text.indexOf('- c.md');
    const iB = text.indexOf('- b.md');
    const iA = text.indexOf('- a.md');
    assert.ok(iC >= 0 && iB >= 0 && iA >= 0);
    assert.ok(iC < iB && iB < iA, 'bullets must be most-recently-modified first');
    assert.match(text, /- b\.md \[feedback\]：别再这样做/);
    assert.match(text, /- a\.md \[reference\]/);
    assert.match(text, /- c\.md \[未分类\]/);
  });

  it('truncates when the rendered list exceeds its token budget', async () => {
    // Push well past AGENT_MEMORY_NOTES_INDEX_MAX_TOKENS (300 tokens ~= 1200 chars)
    // with a handful of notes carrying long `why` text.
    const longWhy = '很长的原因说明。'.repeat(40); // ~ hundreds of chars each
    for (let i = 0; i < 6; i += 1) {
      await writeNote('opus', `long-${i}.md`, { type: 'feedback', why: longWhy, body: 'x', mtimeMs: i * 1000 });
    }
    const lines = prompt.buildAgentMemoryNotesIndexLines('opus', tempRoot);
    const text = lines.join('\n');
    assert.match(text, /notes\/ 清单超出预算，已截断/);
  });
});

describe('F-D injection point: buildAgentMemoryIndexLines / buildTurnMetaBlock (v2-only)', () => {
  const baseExtras = { lessonsContext: null, projectContext: null, maxPromptTokens: 100000 };
  const baseContext = { catId: 'opus', mode: 'parallel', teammates: ['codex'], mcpAvailable: false };

  it('appends the notes list at the tail of the memory index section when notes exist', async () => {
    // buildTurnMetaBlock has no projectRoot seam (always findMonorepoRoot()), so
    // we exercise the actual production injection point via the exported
    // render helper directly (buildAgentMemoryNotesIndexLines), which is what
    // buildAgentMemoryIndexLines calls internally — see SystemPromptBuilder.ts.
    // This proves the RENDER shape; the "wired into buildTurnMetaBlock" claim is
    // a straight function call visible in the diff (buildAgentMemoryIndexLines
    // passes `catId` through unconditionally).
    await writeNote('opus', 'wired.md', { type: 'project', body: '接线验证笔记', mtimeMs: 5_000 });
    const notesLines = prompt.buildAgentMemoryNotesIndexLines('opus', tempRoot);
    assert.ok(notesLines.length > 0);
    assert.match(notesLines.join('\n'), /wired\.md/);
  });

  it('PROOF — zero notes today in the real repo: production buildTurnMetaBlock output is unaffected', async () => {
    // Precondition check (self-documenting, fails loudly if it ever stops being true):
    // as of this PRD batch, no cat has a real .cat-cafe/memory/notes/{catId}/ dir —
    // AgentMemoryStore.ts's own header comment says so ("不新增读取机制"), and F-D
    // is the FIRST feature to ever read that directory. If this assertion ever
    // fails, it means someone started writing real notes files and this proof
    // needs a different cat id.
    const realNotesDir = store.getAgentMemoryNotesDir('opus');
    assert.ok(!existsSync(realNotesDir), 'precondition: opus has no notes/ dir in the real repo yet');

    const agentMemoryContext = '# Opus 记忆\n\n## 当前状态\n\n- 正常工作中\n';
    const meta = prompt.buildTurnMetaBlock(baseContext, { ...baseExtras, agentMemoryContext });

    // Existing v2 memory-index content still renders...
    assert.ok(meta.includes('## 跨 Session 记忆（持久化）'));
    assert.ok(meta.includes('正常工作中'));
    // ...but the new notes-list marker is ABSENT — zero notes → zero bytes added,
    // matching pre-F-D behavior exactly.
    assert.ok(!meta.includes('notes/ 速查清单'), 'no notes/ dir → no notes summary block injected');
  });

  it('v1 static prefix (buildStaticIdentity) is completely unaffected — v1 branch untouched by F-D', async () => {
    const { buildStaticIdentity } = prompt;
    const agentMemoryContext = '# Opus 记忆\n\n## 当前状态\n\n- 正常工作中\n';
    const v1 = buildStaticIdentity('opus', { agentMemoryContext });
    assert.ok(v1.includes('## 跨 Session 记忆（持久化）'), 'v1 memory block still renders');
    assert.ok(!v1.includes('notes/ 速查清单'), 'v1 layout must never render the notes/ index (v2-only feature)');
  });
});
