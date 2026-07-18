import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatThreadAddressToken, parseThreadAddressToken } from '../../shared/dist/thread-address.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { isThreadAddressRoutingEnabled, resolveThreadAddress } from '../dist/routes/thread-address.js';

const ROOT_ID = '0001784400000000-000001-ab12cd34';

describe('F194 thread address token', () => {
  test('formats a stable full-id token and normalizes the human label only', () => {
    assert.equal(formatThreadAddressToken('  clowder AI：研发  ', ROOT_ID), `#clowder-AI-研发:${ROOT_ID}`);
  });

  test('parses exactly one plaintext token while ignoring code and quotes', () => {
    assert.deepEqual(parseThreadAddressToken(`请处理 #大厅:${ROOT_ID}`), {
      kind: 'valid',
      token: `#大厅:${ROOT_ID}`,
      label: '大厅',
      rootMessageId: ROOT_ID,
    });
    assert.deepEqual(parseThreadAddressToken(`\`#大厅:${ROOT_ID}\``), { kind: 'none' });
    assert.deepEqual(parseThreadAddressToken(`\`\`#大厅:${ROOT_ID}\`\``), { kind: 'none' });
    assert.deepEqual(parseThreadAddressToken(`> #大厅:${ROOT_ID}`), { kind: 'none' });
    assert.deepEqual(parseThreadAddressToken(`    #大厅:${ROOT_ID}`), { kind: 'none' });
    assert.deepEqual(parseThreadAddressToken(`\t#大厅:${ROOT_ID}`), { kind: 'none' });
    assert.deepEqual(parseThreadAddressToken(`\`\`\`text\n#大厅:${ROOT_ID}\n\`\`\``), { kind: 'none' });
    assert.equal(parseThreadAddressToken(`请处理“#大厅:${ROOT_ID}”`).kind, 'valid');
  });

  test('fails closed for malformed or multiple address candidates', () => {
    assert.equal(parseThreadAddressToken('#大厅:not-a-full-id').kind, 'invalid');
    assert.equal(parseThreadAddressToken('#大厅:').kind, 'invalid');
    assert.equal(parseThreadAddressToken('请处理：#大厅:not-a-full-id').kind, 'invalid');
    assert.equal(parseThreadAddressToken('请处理:#大厅:not-a-full-id').kind, 'invalid');
    assert.equal(parseThreadAddressToken('请处理“#大厅:not-a-full-id”').kind, 'invalid');
    assert.equal(parseThreadAddressToken('请处理"#大厅:not-a-full-id"').kind, 'invalid');
    assert.equal(parseThreadAddressToken('请处理—#大厅:not-a-full-id').kind, 'invalid');
    assert.equal(parseThreadAddressToken(`#大厅:${ROOT_ID} #研发:${ROOT_ID}`).kind, 'invalid');
  });

  test('does not execute address-shaped content in Markdown destinations', () => {
    assert.deepEqual(parseThreadAddressToken(`[说明](#大厅:${ROOT_ID})`), { kind: 'none' });
    assert.deepEqual(parseThreadAddressToken(`[外层 [内层]](#大厅:${ROOT_ID})`), { kind: 'none' });
    assert.deepEqual(parseThreadAddressToken(`![说明](#大厅:${ROOT_ID})`), { kind: 'none' });
    assert.deepEqual(parseThreadAddressToken(`<#大厅:${ROOT_ID}>`), { kind: 'none' });
    assert.deepEqual(parseThreadAddressToken(`https://example.test/#大厅:${ROOT_ID}`), { kind: 'none' });
    assert.deepEqual(parseThreadAddressToken(`[说明]: #大厅:${ROOT_ID}`), { kind: 'none' });
    assert.deepEqual(parseThreadAddressToken(`[外层 [内层]]: #大厅:${ROOT_ID}`), { kind: 'none' });
  });

  test('does not execute address-shaped content inside raw HTML elements', () => {
    assert.deepEqual(parseThreadAddressToken(`<code>#大厅:${ROOT_ID}</code>`), { kind: 'none' });
    assert.deepEqual(parseThreadAddressToken(`<span>#大厅:${ROOT_ID}</span>`), { kind: 'none' });
    assert.deepEqual(parseThreadAddressToken(`<div>\n#大厅:${ROOT_ID}\n</div>`), { kind: 'none' });
    assert.deepEqual(parseThreadAddressToken(`<div\n class="note">\n#大厅:${ROOT_ID}\n</div>`), { kind: 'none' });
  });

  test('does not execute a Markdown-escaped address marker', () => {
    assert.deepEqual(parseThreadAddressToken(`\\#大厅:${ROOT_ID}`), { kind: 'none' });
  });

  test('address rollout is off by default and supports a source-thread canary', () => {
    assert.equal(isThreadAddressRoutingEnabled('thread-a', {}), false);
    assert.equal(
      isThreadAddressRoutingEnabled('thread-a', { CLOWDER_THREAD_ADDRESS_THREADS: 'thread-b,thread-a' }),
      true,
    );
  });
});

describe('F194 thread address resolver', () => {
  test('resolves root to its durable branch for the owning user without trusting the label', async () => {
    const messageStore = new MessageStore();
    const threadStore = new ThreadStore();
    const source = await threadStore.create('alice', '大厅');
    const branch = await threadStore.create('alice', '登录超时 (分支)');
    const root = await messageStore.append({
      userId: 'alice',
      catId: null,
      content: '修复登录超时',
      mentions: [],
      timestamp: Date.now(),
      threadId: source.id,
      extra: { slockThread: { branchThreadId: branch.id, replyCount: 1 } },
    });

    const result = await resolveThreadAddress(
      { kind: 'valid', token: `#错误标签:${ROOT_ID}`, label: '错误标签', rootMessageId: root.id },
      { sourceThreadId: source.id, userId: 'alice', messageStore, threadStore },
    );
    assert.deepEqual(result, {
      ok: true,
      sourceThreadId: source.id,
      rootMessageId: root.id,
      replyTargetThreadId: branch.id,
    });
  });

  test('returns one non-enumerating denial for missing, deleted, stale, cross-user and private roots', async () => {
    const cases = ['missing', 'deleted', 'stale', 'cross-user', 'private'];
    for (const scenario of cases) {
      const messageStore = new MessageStore();
      const threadStore = new ThreadStore();
      const requestThread = await threadStore.create('alice', '当前频道');
      const source = await threadStore.create(scenario === 'cross-user' ? 'bob' : 'alice', '大厅');
      const branch = await threadStore.create(scenario === 'stale' ? 'alice' : source.createdBy, '分支');
      if (scenario === 'stale') await threadStore.delete(branch.id);
      let rootMessageId = ROOT_ID;
      if (scenario !== 'missing') {
        const root = await messageStore.append({
          userId: source.createdBy,
          catId: null,
          content: 'secret',
          mentions: [],
          timestamp: Date.now(),
          threadId: source.id,
          extra: { slockThread: { branchThreadId: branch.id, replyCount: 1 } },
          ...(scenario === 'private' ? { visibility: 'whisper', whisperTo: ['opus'] } : {}),
        });
        rootMessageId = root.id;
        if (scenario === 'deleted') await messageStore.softDelete(root.id, 'alice');
      }

      const result = await resolveThreadAddress(
        { kind: 'valid', token: `#大厅:${rootMessageId}`, label: '大厅', rootMessageId },
        {
          sourceThreadId: requestThread.id,
          userId: 'alice',
          messageStore,
          threadStore,
        },
      );
      assert.deepEqual(result, { ok: false, code: 'THREAD_ADDRESS_INVALID' }, scenario);
    }
  });
});
