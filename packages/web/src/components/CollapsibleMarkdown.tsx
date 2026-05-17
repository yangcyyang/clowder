'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { getTextFoldReason, shouldFoldText, TEXT_FOLD_THRESHOLD } from '@/utils/textFold';
import { MarkdownContent } from './MarkdownContent';

const COLLAPSED_MAX_HEIGHT = 320;

function foldLabel(content: string, lineCount: number): string {
  const reason = getTextFoldReason(content);
  if (reason === 'structured-agent') return '查看派工详情 ▾';
  return `查看完整内容 ▾ (+${lineCount - TEXT_FOLD_THRESHOLD} 行)`;
}

export function CollapsibleMarkdown({ content, className }: { content: string; className?: string }) {
  const fold = shouldFoldText(content);
  const foldReason = getTextFoldReason(content);
  const [expanded, setExpanded] = useState(false);
  const collapsed = fold && !expanded;
  const lineCount = content.split('\n').length;
  const hasMounted = useRef(false);

  useLayoutEffect(() => {
    if (!hasMounted.current) {
      hasMounted.current = true;
      return;
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('catcafe:chat-layout-changed'));
    }
  }, [expanded]);

  const toggle = useCallback(() => setExpanded((v) => !v), []);

  if (!fold) {
    return <MarkdownContent content={content} className={className} />;
  }

  if (foldReason === 'structured-agent') {
    return (
      <div className="rounded-xl border border-cafe-border/60 bg-cafe-surface/45 px-3 py-2">
        <button
          type="button"
          onClick={toggle}
          className="flex w-full items-center justify-between gap-3 text-left text-xs text-cafe-secondary hover:text-cafe-primary transition-colors"
        >
          <span className="font-medium">📋 Agent 派工详情</span>
          <span className="text-cafe-muted">{expanded ? '收起' : '展开'}</span>
        </button>
        {expanded && (
          <div className="mt-2 border-t border-cafe-border/60 pt-2">
            <MarkdownContent content={content} className={className} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div
        className="overflow-hidden transition-[max-height] duration-200"
        style={collapsed ? { maxHeight: COLLAPSED_MAX_HEIGHT } : undefined}
      >
        <MarkdownContent content={content} className={className} />
      </div>
      <button
        type="button"
        onClick={toggle}
        className="mt-1 text-xs text-cafe-muted hover:text-cafe-primary transition-colors"
      >
        {collapsed ? foldLabel(content, lineCount) : '收起 ▴'}
      </button>
    </div>
  );
}
