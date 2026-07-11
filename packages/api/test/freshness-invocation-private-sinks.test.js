import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';

const SECRET_STALE_DRAFT = 'SECRET_STALE_DRAFT';

let originalCwd;
let originalGlobalConfigRoot;
let originalSharedStatePreflight;
let tempRoot;

async function collect(iterable) {
  const messages = [];
  for await (const message of iterable) messages.push(message);
  return messages;
}

async function waitForFile(path, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return existsSync(path);
}

function makeDeps({ sessionChainStore, transcriptWriter, invocationId }) {
  return {
    registry: {
      create: async () => ({ invocationId, callbackToken: `token-${invocationId}` }),
      verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
    },
    sessionManager: {
      get: async () => undefined,
      store: async () => {},
      delete: async () => {},
      resolveWorkingDirectory: () => tempRoot,
    },
    threadStore: null,
    sessionChainStore,
    transcriptWriter,
    apiUrl: 'http://127.0.0.1:3004',
  };
}

function makeService(sessionId) {
  return {
    async *invoke() {
      yield { type: 'session_init', catId: 'opus', sessionId, timestamp: Date.now() };
      yield { type: 'text', catId: 'opus', content: SECRET_STALE_DRAFT, timestamp: Date.now() };
      yield {
        type: 'tool_use',
        catId: 'opus',
        toolName: 'Write',
        toolInput: { path: '/tmp/private.txt', content: SECRET_STALE_DRAFT },
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
    },
  };
}

async function sealAndImport({ sessionChainStore, transcriptWriter, transcriptReader, messageStore }) {
  const [record] = await sessionChainStore.getChain('opus', 'thread-private-sinks');
  assert.ok(record, 'invocation should create a bound session record');
  const sealedAt = Date.now();
  await sessionChainStore.update(record.id, { status: 'sealed', sealedAt, updatedAt: sealedAt });
  await transcriptWriter.flush(
    {
      sessionId: record.id,
      threadId: record.threadId,
      catId: record.catId,
      cliSessionId: record.cliSessionId,
      seq: record.seq,
    },
    { createdAt: record.createdAt, sealedAt },
  );

  const { backfillBoundSessionHistory } = await import(
    '../dist/domains/cats/services/session/BoundSessionHistoryImporter.js'
  );
  return backfillBoundSessionHistory({
    sessionChainStore,
    transcriptReader,
    messageStore,
    threadId: record.threadId,
    catId: record.catId,
    userId: record.userId,
  });
}

describe('F193 protected invocation private sinks', () => {
  before(async () => {
    originalCwd = process.cwd();
    originalGlobalConfigRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    originalSharedStatePreflight = process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT;
    tempRoot = await mkdtemp(join(tmpdir(), 'freshness-private-sinks-'));
    await writeFile(join(tempRoot, 'pnpm-workspace.yaml'), 'packages: []\n', 'utf-8');
    process.chdir(tempRoot);
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = join(tempRoot, '.global-config');
    process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT = '1';
  });

  beforeEach(async () => {
    const { resetAgentMemoryAutoWriterForTests } = await import(
      '../dist/domains/cats/services/agents/memory/AgentMemoryAutoWriter.js'
    );
    resetAgentMemoryAutoWriterForTests();
  });

  after(async () => {
    process.chdir(originalCwd);
    if (originalGlobalConfigRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = originalGlobalConfigRoot;
    if (originalSharedStatePreflight === undefined) delete process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT;
    else process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT = originalSharedStatePreflight;
    await rm(tempRoot, { recursive: true, force: true });
  });

  test('freshness-protected output stays out of transcript and history import before verdict', async () => {
    const { invokeSingleCat } = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { TranscriptReader } = await import('../dist/domains/cats/services/session/TranscriptReader.js');
    const { TranscriptWriter } = await import('../dist/domains/cats/services/session/TranscriptWriter.js');

    const sessionChainStore = new SessionChainStore();
    const messageStore = new MessageStore();
    const transcriptWriter = new TranscriptWriter({ dataDir: join(tempRoot, 'transcripts') });
    const transcriptReader = new TranscriptReader({ dataDir: join(tempRoot, 'transcripts') });

    await collect(
      invokeSingleCat(makeDeps({ sessionChainStore, transcriptWriter, invocationId: 'inv-protected' }), {
        catId: 'opus',
        service: makeService('cli-protected'),
        prompt: 'protected invocation',
        userId: 'user-1',
        threadId: 'thread-private-sinks',
        freshnessBaseline: 'watermark-before-generation',
        isLastCat: true,
      }),
    );

    const [record] = await sessionChainStore.getChain('opus', 'thread-private-sinks');
    assert.ok(record);
    const bufferedTranscript = JSON.stringify(transcriptWriter.getBufferedEvents(record.id));
    assert.doesNotMatch(bufferedTranscript, /SECRET_STALE_DRAFT/);
    assert.doesNotMatch(bufferedTranscript, /"type":"(?:text|tool_use)"/);

    const importResult = await sealAndImport({
      sessionChainStore,
      transcriptWriter,
      transcriptReader,
      messageStore,
    });
    assert.equal(importResult.importedCount, 0);
    assert.equal((await messageStore.getByThread('thread-private-sinks', 20, 'user-1')).length, 0);
  });

  test('freshness-protected assistant text stays out of agent memory before verdict', async () => {
    const { invokeSingleCat } = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const { TranscriptWriter } = await import('../dist/domains/cats/services/session/TranscriptWriter.js');

    const memoryPath = join(tempRoot, '.cat-cafe', 'memory', 'opus.md');
    await rm(memoryPath, { force: true });
    const sessionChainStore = new SessionChainStore();
    const transcriptWriter = new TranscriptWriter({ dataDir: join(tempRoot, 'transcripts') });

    await collect(
      invokeSingleCat(makeDeps({ sessionChainStore, transcriptWriter, invocationId: 'inv-protected-memory' }), {
        catId: 'opus',
        service: makeService('cli-protected-memory'),
        prompt: 'protected invocation memory',
        userId: 'user-1',
        threadId: 'thread-private-sinks',
        freshnessBaseline: 'watermark-before-generation',
        isLastCat: true,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(existsSync(memoryPath), false, 'protected stale draft must not reach agent memory');
  });

  test('legacy invocation without a freshness baseline keeps transcript, history import, and memory behavior', async () => {
    const { invokeSingleCat } = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { TranscriptReader } = await import('../dist/domains/cats/services/session/TranscriptReader.js');
    const { TranscriptWriter } = await import('../dist/domains/cats/services/session/TranscriptWriter.js');

    const sessionChainStore = new SessionChainStore();
    const messageStore = new MessageStore();
    const transcriptWriter = new TranscriptWriter({ dataDir: join(tempRoot, 'transcripts') });
    const transcriptReader = new TranscriptReader({ dataDir: join(tempRoot, 'transcripts') });

    await collect(
      invokeSingleCat(makeDeps({ sessionChainStore, transcriptWriter, invocationId: 'inv-legacy' }), {
        catId: 'opus',
        service: makeService('cli-legacy'),
        prompt: 'legacy invocation',
        userId: 'user-1',
        threadId: 'thread-private-sinks',
        isLastCat: true,
      }),
    );

    const [record] = await sessionChainStore.getChain('opus', 'thread-private-sinks');
    assert.ok(record);
    assert.match(JSON.stringify(transcriptWriter.getBufferedEvents(record.id)), /SECRET_STALE_DRAFT/);

    const importResult = await sealAndImport({
      sessionChainStore,
      transcriptWriter,
      transcriptReader,
      messageStore,
    });
    assert.equal(importResult.importedCount, 1);
    const imported = await messageStore.getByThread('thread-private-sinks', 20, 'user-1');
    assert.equal(imported[0]?.content, SECRET_STALE_DRAFT);

    const memoryPath = join(tempRoot, '.cat-cafe', 'memory', 'opus.md');
    assert.equal(await waitForFile(memoryPath), true, 'legacy invocation should keep agent memory auto-write');
    assert.match(await readFile(memoryPath, 'utf-8'), /SECRETSTALEDRAFT/);
  });
});
