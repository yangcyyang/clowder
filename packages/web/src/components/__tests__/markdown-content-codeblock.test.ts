import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownContent } from '@/components/MarkdownContent';

Object.assign(globalThis as Record<string, unknown>, { React });

function render(content: string): string {
  return renderToStaticMarkup(React.createElement(MarkdownContent, { content }));
}

describe('MarkdownContent code block copy button', () => {
  it('renders copy button outside <pre> so textContent is clean', () => {
    const html = render('```js\nconsole.log("hello")\n```');
    // Button should be in a wrapper div, not inside <pre>
    // Structure: <div class="relative group ..."><button>复制</button><pre>...</pre></div>
    expect(html).toContain('<button');
    expect(html).toContain('复制');
    // The <pre> should NOT contain the button text
    const preMatch = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/);
    expect(preMatch).toBeTruthy();
    expect(preMatch?.[1]).not.toContain('复制');
  });

  it('does not apply inline code chip classes inside fenced code without language', () => {
    const html = render('```\npnpm --dir packages/web build\n```');
    const preMatch = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/);

    expect(preMatch).toBeTruthy();
    expect(preMatch?.[1]).toContain('markdown-code-block-code');
    expect(preMatch?.[1]).not.toContain('clowder-markdown-chip');
  });

  it('keeps inline code chip styling for prose code', () => {
    const html = render('运行 `pnpm build` 后再验收。');

    expect(html).toContain('clowder-markdown-chip');
    expect(html).not.toContain('markdown-code-block-code');
  });
});

describe('MarkdownContent file path linking', () => {
  it('converts absolute paths to vscode:// links', () => {
    // Bare path (not in backticks) — linkified by withMentionsAndLinks in <p>
    const html = render('See /packages/api/src/routes/messages.ts:42 for details');
    expect(html).toContain('vscode://file/packages/api/src/routes/messages.ts:42');
    expect(html).toContain('text-[var(--color-cafe-accent)]');
  });

  it('renders relative paths as workspace links when PROJECT_ROOT is not set', () => {
    // Bare path (not in backticks) for linkifyFilePaths to detect
    const html = render('Check packages/web/src/app/page.tsx:10 for the fix');
    // A missing VSCode root must not prevent regular workspace opening.
    expect(html).toContain('packages/web/src/app/page.tsx:10');
    expect(html).not.toContain('vscode://file');
    expect(html).toContain('markdown-file-link');
    expect(html).toContain('href="#"');
  });

  it('renders plain generated filenames as local file shortcuts', () => {
    const html = render('已生成 AI设计工程化与可控生成-综合分析.html，请查看');
    expect(html).toContain('data-local-file-link');
    expect(html).toContain('AI设计工程化与可控生成-综合分析.html');
  });
});
