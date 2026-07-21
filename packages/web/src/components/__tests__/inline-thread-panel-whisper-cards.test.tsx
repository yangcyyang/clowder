/**
 * #404 whisper 钉：任务卡 / 父消息卡都从消息内容派生展示字段，必须过
 * canViewerSeeThreadMessage() 才渲染实际内容——viewer.type==='user'（当前唯一
 * 的 web 场景）恒可见是既有设计（owner 看见一切），viewer.type==='cat' 时才
 * 真过滤，这条测试专门覆盖后者，证明防御性代码路径真的挡得住。
 */

import type { TaskItem } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InlineThreadParentMessageCard, InlineThreadTaskStatusCard } from '@/components/InlineThreadPanel';
import type { ChatMessage } from '@/stores/chatStore';

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    type: 'user',
    content: '悄悄改一下密钥轮换脚本',
    timestamp: 1,
    ...overrides,
  } as ChatMessage;
}

function makeTask(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: 'task-1',
    kind: 'work',
    threadId: 'thread-1',
    subjectKey: null,
    title: '轮换密钥',
    ownerCatId: 'opus',
    status: 'doing',
    why: '定期轮换',
    createdBy: 'user',
    createdAt: 1,
    updatedAt: 1,
    evidence: {},
    ...overrides,
  } as TaskItem;
}

describe('InlineThreadPanel whisper sentinels', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // ── Task card ──

  it('task card: normal (non-whisper) source message → viewer=cat can see all fields', async () => {
    const message = makeMessage({ content: '轮换密钥的具体步骤' });
    const task = makeTask();
    await act(async () => {
      root.render(
        React.createElement(InlineThreadTaskStatusCard, {
          task,
          sourceMessage: message,
          threadId: 'thread-1',
          viewer: { type: 'cat', catId: 'codex' },
        }),
      );
    });
    expect(container.textContent).toContain('轮换密钥');
    expect(container.textContent).not.toContain('私密任务');
  });

  it('task card WHISPER SENTINEL: whisper source message + non-recipient cat viewer → fields hidden, private placeholder shown', async () => {
    const message = makeMessage({
      content: '轮换密钥的具体步骤',
      visibility: 'whisper',
      whisperTo: ['opus'],
    });
    const task = makeTask({ title: '轮换密钥（敏感）' });
    await act(async () => {
      root.render(
        React.createElement(InlineThreadTaskStatusCard, {
          task,
          sourceMessage: message,
          threadId: 'thread-1',
          viewer: { type: 'cat', catId: 'codex' }, // NOT a whisper recipient
        }),
      );
    });
    expect(container.textContent).toContain('私密任务');
    expect(container.textContent).not.toContain('轮换密钥');
  });

  it('task card WHISPER SENTINEL (damaged form): whisperTo missing/malformed → fail closed, still hidden from a non-user viewer', async () => {
    const message = makeMessage({
      content: '轮换密钥的具体步骤',
      visibility: 'whisper',
      whisperTo: undefined, // damaged: no recipients recorded at all
    });
    const task = makeTask();
    await act(async () => {
      root.render(
        React.createElement(InlineThreadTaskStatusCard, {
          task,
          sourceMessage: message,
          threadId: 'thread-1',
          viewer: { type: 'cat', catId: 'codex' },
        }),
      );
    });
    expect(container.textContent).toContain('私密任务');
    expect(container.textContent).not.toContain('轮换密钥');
  });

  it('task card: whisper source message but the recipient cat viewer CAN see it', async () => {
    const message = makeMessage({
      content: '轮换密钥的具体步骤',
      visibility: 'whisper',
      whisperTo: ['opus'],
    });
    const task = makeTask();
    await act(async () => {
      root.render(
        React.createElement(InlineThreadTaskStatusCard, {
          task,
          sourceMessage: message,
          threadId: 'thread-1',
          viewer: { type: 'cat', catId: 'opus' }, // IS a whisper recipient
        }),
      );
    });
    expect(container.textContent).toContain('轮换密钥');
    expect(container.textContent).not.toContain('私密任务');
  });

  it('task card: web owner viewer (type=user, the only current live case) always sees everything — by design, not a leak', async () => {
    const message = makeMessage({ visibility: 'whisper', whisperTo: ['opus'] });
    const task = makeTask({ title: '轮换密钥（owner 可见）' });
    await act(async () => {
      root.render(React.createElement(InlineThreadTaskStatusCard, { task, sourceMessage: message }));
    });
    expect(container.textContent).toContain('轮换密钥（owner 可见）');
  });

  // ── Parent-message card ──

  it('parent-message card WHISPER SENTINEL: whisper message + non-recipient cat viewer → content hidden', async () => {
    const message = makeMessage({
      content: '这句话不该被看到',
      visibility: 'whisper',
      whisperTo: ['opus'],
    });
    await act(async () => {
      root.render(
        React.createElement(InlineThreadParentMessageCard, {
          message,
          getCatById: () => undefined,
          viewer: { type: 'cat', catId: 'codex' },
        }),
      );
    });
    expect(container.textContent).toContain('私密消息');
    expect(container.textContent).not.toContain('这句话不该被看到');
  });

  it('parent-message card: public message + cat viewer → content visible', async () => {
    const message = makeMessage({ content: '普通回复内容' });
    await act(async () => {
      root.render(
        React.createElement(InlineThreadParentMessageCard, {
          message,
          getCatById: () => undefined,
          viewer: { type: 'cat', catId: 'codex' },
        }),
      );
    });
    expect(container.textContent).toContain('普通回复内容');
  });
});
