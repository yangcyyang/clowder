/**
 * Task lifecycle tools tests (batch 2-C)
 * 测试 cat_cafe_task_* / cat_cafe_reply_in_thread / cat_cafe_search_messages
 * 的 HTTP 调用逻辑 — 与 callback-tools.test.js 相同的 fetch mock 套路。
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('Task lifecycle MCP tools', () => {
  let originalEnv;
  let originalFetch;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:3004';
    process.env.CAT_CAFE_INVOCATION_ID = 'test-invocation';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'test-token';
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    globalThis.fetch = originalFetch;
  });

  test('handleTaskClaim forwards taskId form', async () => {
    const { handleTaskClaim } = await import('../dist/tools/task-lifecycle-tools.js');
    let capturedUrl, capturedOptions;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return { ok: true, json: async () => ({ status: 'ok', task: { id: 't1', status: 'doing' } }) };
    };

    const result = await handleTaskClaim({ taskId: 't1', why: 'taking this' });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl.includes('/api/callbacks/task-claim'));
    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.taskId, 't1');
    assert.equal(body.why, 'taking this');
    assert.equal(body.messageId, undefined);
  });

  test('handleTaskClaim forwards messageId form', async () => {
    const { handleTaskClaim } = await import('../dist/tools/task-lifecycle-tools.js');
    let capturedOptions;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return { ok: true, json: async () => ({ status: 'ok', task: { id: 't2' }, created: true }) };
    };

    const result = await handleTaskClaim({ messageId: 'msg-1' });

    assert.equal(result.isError, undefined);
    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.messageId, 'msg-1');
    assert.equal(body.taskId, undefined);
    assert.equal(body.title, undefined);
  });

  // 批次4-B5 票面卫生 B5.4: title is forwarded when provided, and the server's
  // rejection (missing/too-long title, thread-hierarchy, cat-author) surfaces as a
  // normal tool error with the Chinese hint intact for the cat to read.
  test('handleTaskClaim forwards title alongside messageId (B5.4)', async () => {
    const { handleTaskClaim } = await import('../dist/tools/task-lifecycle-tools.js');
    let capturedOptions;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return { ok: true, json: async () => ({ status: 'ok', task: { id: 't2', title: '修复登录问题' }, created: true }) };
    };

    const result = await handleTaskClaim({ messageId: 'msg-1', title: '修复登录问题' });

    assert.equal(result.isError, undefined);
    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.messageId, 'msg-1');
    assert.equal(body.title, '修复登录问题');
  });

  test('handleTaskClaim surfaces the B5 ticket-hygiene rejection hint from the server', async () => {
    const { handleTaskClaim } = await import('../dist/tools/task-lifecycle-tools.js');
    globalThis.fetch = async () => ({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({
          error: 'title is required (1-60 chars, trimmed) when claiming by messageId',
          code: 'TASK_CLAIM_TITLE_REQUIRED',
          hint: '请自拟一个 1-60 字的标题（不要留空）；原文会自动整理进票的讨论 thread 首条，标题不用照抄原文',
        }),
    });

    const result = await handleTaskClaim({ messageId: 'msg-1' });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /TASK_CLAIM_TITLE_REQUIRED/);
    assert.match(result.content[0].text, /请自拟一个 1-60 字的标题/);
  });

  test('handleTaskCreate forwards subjectKey for dedup', async () => {
    const { handleTaskCreate } = await import('../dist/tools/task-lifecycle-tools.js');
    let capturedUrl, capturedOptions;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return {
        ok: true,
        json: async () => ({ status: 'existing_task', task: { id: 't3' }, hint: 'use task_claim instead' }),
      };
    };

    const result = await handleTaskCreate({ title: 'Fix bug', subjectKey: 'pr:owner/repo#1' });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl.includes('/api/callbacks/task-create'));
    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.title, 'Fix bug');
    assert.equal(body.subjectKey, 'pr:owner/repo#1');
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.status, 'existing_task');
  });

  test('handleTaskUpdate forwards status', async () => {
    const { handleTaskUpdate } = await import('../dist/tools/task-lifecycle-tools.js');
    let capturedUrl, capturedOptions;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return { ok: true, json: async () => ({ status: 'ok', task: { id: 't1', status: 'in_review' } }) };
    };

    const result = await handleTaskUpdate({ taskId: 't1', status: 'in_review', why: 'ready for review' });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl.includes('/api/callbacks/task-update'));
    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.taskId, 't1');
    assert.equal(body.status, 'in_review');
  });

  test('handleTaskUpdate surfaces illegal-transition errors from the server', async () => {
    const { handleTaskUpdate } = await import('../dist/tools/task-lifecycle-tools.js');
    globalThis.fetch = async () => ({
      ok: false,
      status: 409,
      text: async () =>
        JSON.stringify({ error: "Cannot move directly from 'todo' to 'done'.", code: 'ILLEGAL_STATUS_TRANSITION' }),
    });

    const result = await handleTaskUpdate({ taskId: 't1', status: 'done' });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /ILLEGAL_STATUS_TRANSITION/);
  });

  test('handleTaskUnclaim forwards taskId', async () => {
    const { handleTaskUnclaim } = await import('../dist/tools/task-lifecycle-tools.js');
    let capturedUrl, capturedOptions;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return { ok: true, json: async () => ({ status: 'ok', task: { id: 't1', ownerCatId: null, status: 'todo' } }) };
    };

    const result = await handleTaskUnclaim({ taskId: 't1', why: 'blocked on external dep' });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl.includes('/api/callbacks/task-unclaim'));
    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.taskId, 't1');
    assert.equal(body.why, 'blocked on external dep');
  });

  test('handleTaskList forwards threadId/status/kind filters as query params', async () => {
    const { handleTaskList } = await import('../dist/tools/task-lifecycle-tools.js');
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return { ok: true, json: async () => ({ tasks: [] }) };
    };

    const result = await handleTaskList({ threadId: 'thread-1', status: 'blocked', kind: 'work' });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl.includes('/api/callbacks/task-list'));
    assert.ok(capturedUrl.includes('threadId=thread-1'));
    assert.ok(capturedUrl.includes('status=blocked'));
    assert.ok(capturedUrl.includes('kind=work'));
  });

  test('handleSearchMessages forwards q/limit/threadId/catId as query params', async () => {
    const { handleSearchMessages } = await import('../dist/tools/task-lifecycle-tools.js');
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return { ok: true, json: async () => ({ query: 'foo', messages: [] }) };
    };

    const result = await handleSearchMessages({ q: 'foo bar', limit: 5, threadId: 'thread-1', catId: 'opus' });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl.includes('/api/callbacks/message-search'));
    assert.ok(capturedUrl.includes('limit=5'));
    assert.ok(capturedUrl.includes('threadId=thread-1'));
    assert.ok(capturedUrl.includes('catId=opus'));
  });

  test('handleReplyInThread resolves the anchored thread then posts via handlePostMessage', async () => {
    const { handleReplyInThread } = await import('../dist/tools/task-lifecycle-tools.js');
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      if (url.includes('/api/callbacks/resolve-message-thread')) {
        return { ok: true, json: async () => ({ threadId: 'task-thread-1', taskId: 't1' }) };
      }
      if (url.includes('/api/callbacks/post-message')) {
        return { ok: true, json: async () => ({ status: 'ok', threadId: 'task-thread-1', messageId: 'm2' }) };
      }
      throw new Error(`unexpected fetch to ${url}`);
    };

    const result = await handleReplyInThread({ messageId: 'msg-1', content: 'progress update' });

    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].url.includes('messageId=msg-1'));
    const postBody = JSON.parse(calls[1].options.body);
    assert.equal(postBody.threadId, 'task-thread-1');
    assert.equal(postBody.content, 'progress update');
  });

  test('handleReplyInThread surfaces NO_ANCHORED_THREAD as a clear error without calling post-message', async () => {
    const { handleReplyInThread } = await import('../dist/tools/task-lifecycle-tools.js');
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(url);
      return {
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ error: 'No thread is anchored to this message.', code: 'NO_ANCHORED_THREAD' }),
      };
    };

    const result = await handleReplyInThread({ messageId: 'msg-orphan', content: 'hello' });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /NO_ANCHORED_THREAD/);
    assert.equal(calls.length, 1, 'must not call post-message when the resolve hop fails');
  });

  test('task lifecycle tools registry exposes all 7 expected tool names', async () => {
    const { taskLifecycleTools } = await import('../dist/tools/task-lifecycle-tools.js');
    const names = taskLifecycleTools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'cat_cafe_reply_in_thread',
      'cat_cafe_search_messages',
      'cat_cafe_task_claim',
      'cat_cafe_task_create',
      'cat_cafe_task_list',
      'cat_cafe_task_unclaim',
      'cat_cafe_task_update',
    ]);
  });
});
