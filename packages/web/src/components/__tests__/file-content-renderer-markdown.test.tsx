import React, { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FileContentRenderer } from '@/components/workspace/FileContentRenderer';

Object.assign(globalThis as Record<string, unknown>, { React });

describe('FileContentRenderer Markdown preview', () => {
  it('renders Markdown files with the existing readable heading and list styles', () => {
    const html = renderToStaticMarkup(
      React.createElement(FileContentRenderer, {
        file: {
          path: 'docs/个人内容资产操作系统-落地执行方案-v1.md',
          content: '# 落地执行方案\n\n- 明确目标\n- 推进执行',
          sha256: 'sha',
          size: 42,
          mime: 'text/markdown',
          truncated: false,
        },
        openFilePath: 'docs/个人内容资产操作系统-落地执行方案-v1.md',
        isMarkdown: true,
        isHtml: false,
        isJsx: false,
        markdownRendered: true,
        htmlPreview: false,
        jsxPreview: false,
        editMode: false,
        scrollToLine: null,
        worktreeId: 'notes',
        mdContainerRef: createRef<HTMLDivElement>(),
        mdHasSelection: false,
        onMdAddToChat: vi.fn(),
        onSave: async () => {},
        rawUrl: vi.fn(),
        revealInFinder: vi.fn(),
      }),
    );

    expect(html).toContain('<h1');
    expect(html).toContain('font-bold');
    expect(html).toContain('落地执行方案');
    expect(html).toContain('<ul');
    expect(html).toContain('list-disc');
    expect(html).toContain('明确目标');
  });
});
