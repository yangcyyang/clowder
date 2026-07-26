'use client';

import { useState } from 'react';
import { MarkdownContent } from './MarkdownContent';

/** First line of formatSanityHandoffMarkdown() is `## 理智线自动交接包（🔴 红区）` or `（🟡 黄区）`. */
const RED_ZONE_RE = /🔴|红区/;

/**
 * 理智线自动交接包折叠卡片（cy 2026-07-26）。
 *
 * 铲屎官原话："理智线交接的这种内容属于系统消息，可以折叠起来，我有需要再自己点击展开"。
 * 默认折叠为一行摘要，点击展开/再点收起。只改渲染呈现——`content` 就是消息原文
 * （HandoffCapsuleGenerator.formatSanityHandoffMarkdown 的输出，见
 * packages/api/.../session/HandoffCapsuleGenerator.ts），这里不对内容本身做任何改写。
 *
 * 折叠结构抄 F097 CliOutputBlock 的 header-button + chevron/hint + 条件 body 模式
 * （见 ./cli-output/CliOutputBlock.tsx），但去掉了它的 streaming/tool-row 复杂度——
 * 交接包是一次性落地的完整文本，不是流式内容，不需要那套状态机。
 */
export function SanityHandoffCard({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const firstLine = content.split('\n')[0] ?? '';
  const emoji = RED_ZONE_RE.test(firstLine) ? '🔴' : '🟡';

  return (
    <div
      data-testid="sanity-handoff-card"
      className="w-full rounded-lg border border-[var(--console-border-soft)] bg-[var(--console-card-soft-bg)] overflow-hidden"
    >
      <button
        type="button"
        data-testid="sanity-handoff-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-1.5 px-3 py-2 text-left [font-size:var(--clowder-type-meta)] text-cafe-secondary hover:text-cafe-primary transition-colors"
      >
        <span aria-hidden="true">{emoji}</span>
        <span className="font-medium">理智线交接包</span>
        <span className="text-cafe-muted">· {expanded ? '点击收起' : '点击展开'}</span>
      </button>
      {expanded && (
        <div
          data-testid="sanity-handoff-body"
          className="px-3 pb-3 pt-1 border-t border-[var(--console-border-soft)] [font-size:var(--clowder-type-meta)]"
        >
          <MarkdownContent content={content} className="!text-xs" />
        </div>
      )}
    </div>
  );
}
