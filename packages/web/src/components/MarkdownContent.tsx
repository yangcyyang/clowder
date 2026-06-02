'use client';

import { Children, isValidElement, type ReactNode, useCallback, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { createWorkspaceImageComponent, createWorkspaceLinkComponent } from './workspace-md-components';

/* ── @mention highlighting ─────────────────────────────────── */
const GENERIC_MENTION_RE = /@[^\s,.:;!?()[\]{}<>，。！？、：；（）【】《》「」『』〈〉]+/g;

function highlightMentions(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;

  GENERIC_MENTION_RE.lastIndex = 0;
  while ((m = GENERIC_MENTION_RE.exec(text)) !== null) {
    if (m.index > lastIdx) parts.push(text.slice(lastIdx, m.index));
    parts.push(
      <span
        key={`m${m.index}`}
        className="rounded bg-[var(--cafe-accent)]/15 px-0.5 font-semibold text-[var(--cafe-accent)]"
      >
        {m[0]}
      </span>,
    );
    lastIdx = GENERIC_MENTION_RE.lastIndex;
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts;
}

/** Process immediate string children → highlight @mentions */
function withMentions(children: ReactNode): ReactNode {
  return Children.map(children, (child) => (typeof child === 'string' ? highlightMentions(child) : child));
}

/* ── Code block with copy button ───────────────────────────── */
function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const preRef = useRef<HTMLPreElement>(null);

  // Detect if any child <code> has a language class → real code → use monospace.
  // Plain ```text``` blocks (no language) render in sans-serif for readability.
  const hasLanguage = Children.toArray(children).some((child) => {
    if (!isValidElement(child)) return false;
    const cls = (child.props as { className?: string }).className ?? '';
    return /language-/.test(cls);
  });

  const handleCopy = useCallback(() => {
    const text = preRef.current?.textContent ?? '';
    void navigator.clipboard.writeText(text);
    setCopied(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1500);
  }, []);

  return (
    <div className="relative group my-3">
      <button
        onClick={handleCopy}
        aria-label={copied ? '已复制代码块' : '复制代码块'}
        title={copied ? '已复制' : '复制'}
        className="absolute right-2.5 top-2.5 z-10 rounded-[var(--chat-code-btn-radius)] border-[length:var(--chat-code-border-width)] border-[var(--chat-code-border)] bg-[var(--chat-code-btn-bg)] px-2 py-1 text-[10px] font-semibold text-[var(--chat-code-btn-text)] shadow-[var(--chat-code-btn-shadow)] transition-transform hover:-translate-y-px"
      >
        {copied ? (
          '已复制'
        ) : (
          <>
            <span aria-hidden="true">⧉</span>
            <span className="sr-only">复制</span>
          </>
        )}
      </button>
      <pre
        ref={preRef}
        className={`overflow-x-auto rounded-[var(--chat-code-radius)] border-[length:var(--chat-code-border-width)] border-[var(--chat-code-border)] bg-[var(--chat-code-bg)] px-4 py-3.5 pr-16 text-[var(--chat-code-text)] shadow-[var(--chat-code-shadow)] [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit ${hasLanguage ? 'font-mono text-[12px] leading-6' : 'font-mono text-[13px] leading-6'}`}
      >
        {children}
      </pre>
    </div>
  );
}

/* ── File path → VSCode link ──────────────────────────────── */
const PROJECT_ROOT = process.env.NEXT_PUBLIC_PROJECT_ROOT ?? '';
const FILE_PATH_RE = /(?:^|\s)`?((?:\/[\w.@-]+)+(?:\.[\w]+)(?::(\d+))?)(?:`?)/g;
const REL_PATH_RE = /(?:^|\s)`?((?:packages|src|docs|tests?)\/[\w./@-]+(?:\.[\w]+)(?::(\d+))?)(?:`?)/g;
const WT_TAG_RE = /^\s*\[wt:([a-zA-Z0-9_/-]+)\]/;
const LOCAL_FILE_NAME_RE =
  /(?:^|[\s（(「『【\[])(`?)([^`"'<>/\\|:：\s]+(?:[\s-][^`"'<>/\\|:：\s]+)*\.(?:html?|mdx?|pdf|pptx?|docx?|xlsx?|txt|json|png|jpe?g|svg|webp))(`?)(?=$|[\s，。；;、）)」』】\].,!?！？])/giu;

function linkifyFilePaths(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let lastIdx = 0;
  const combined = new RegExp(`${FILE_PATH_RE.source}|${REL_PATH_RE.source}`, 'g');
  let m: RegExpExecArray | null;

  combined.lastIndex = 0;
  while ((m = combined.exec(text)) !== null) {
    const fullMatch = m[0];
    const leading = fullMatch.match(/^\s/)?.[0] ?? '';
    const path = m[1] ?? m[3];
    const line = m[2] ?? m[4];
    if (!path) continue;

    const start = m.index + leading.length;
    if (start > lastIdx) parts.push(text.slice(lastIdx, start));

    // Check for [wt:ID] tag immediately after the match
    const afterMatch = text.slice(m.index + fullMatch.length);
    const wtMatch = afterMatch.match(WT_TAG_RE);
    const worktreeId = wtMatch?.[1] ?? undefined;

    // Strip backticks from display
    const display = path;
    const isAbsolute = path.startsWith('/');
    const filePath = path.split(':')[0];
    const absPath = isAbsolute ? filePath : PROJECT_ROOT ? `${PROJECT_ROOT}/${filePath}` : null;
    const href = absPath ? `vscode://file${absPath}${line ? `:${line}` : ''}` : null;

    parts.push(
      href ? (
        <FilePathLink
          key={`fp${m.index}`}
          display={display}
          href={href}
          filePath={filePath!}
          line={line ? parseInt(line, 10) : undefined}
          worktreeId={worktreeId}
        />
      ) : (
        <span key={`fp${m.index}`} className="text-[var(--color-cafe-accent)] font-mono text-[0.85em]">
          {display}
        </span>
      ),
    );
    // Skip past the [wt:ID] tag so it's not rendered as visible text
    if (wtMatch) {
      lastIdx = m.index + fullMatch.length + wtMatch[0].length;
      combined.lastIndex = lastIdx;
    } else {
      lastIdx = m.index + fullMatch.length;
    }
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts.length > 0 ? parts : [text];
}

/** F063: File path link — click opens in workspace panel, Cmd/Ctrl+click opens in VSCode */
function FilePathLink({
  display,
  href,
  filePath,
  line,
  worktreeId,
}: {
  display: string;
  href: string;
  filePath: string;
  line?: number;
  worktreeId?: string;
}) {
  const setOpenFile = useChatStore((s) => s.setWorkspaceOpenFile);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      // Cmd/Ctrl+click → VSCode (default link behavior)
      if (e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      // Regular click → open in workspace panel (with optional worktree switch)
      setOpenFile(filePath, line ?? null, worktreeId ?? null);
    },
    [setOpenFile, filePath, line, worktreeId],
  );

  return (
    <a
      href={href}
      onClick={handleClick}
      className="text-[var(--color-cafe-accent)] hover:opacity-80 hover:underline font-mono text-[0.85em] cursor-pointer"
      title={`点击在工作区中查看 · Cmd+Click 打开 VSCode\n${display}`}
    >
      {display}
    </a>
  );
}

interface ResolvedLocalFile {
  worktreeId: string;
  path: string;
  root: string;
}

function linkifyLocalFileNames(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;

  LOCAL_FILE_NAME_RE.lastIndex = 0;
  while ((m = LOCAL_FILE_NAME_RE.exec(text)) !== null) {
    const fullMatch = m[0];
    const leading = fullMatch.match(/^[\s（(「『【\[]/)?.[0] ?? '';
    const fileName = m[2];
    if (!fileName) continue;

    const start = m.index + leading.length;
    if (start > lastIdx) parts.push(text.slice(lastIdx, start));
    parts.push(<LocalFileNameLink key={`lf${m.index}`} fileName={fileName} />);
    lastIdx = m.index + fullMatch.length;
  }

  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts.length > 0 ? parts : [text];
}

function LocalFileNameLink({ fileName }: { fileName: string }) {
  const setOpenFile = useChatStore((s) => s.setWorkspaceOpenFile);
  const addToast = useToastStore((s) => s.addToast);

  const handleClick = useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      try {
        const res = await apiFetch('/api/workspace/resolve-local-file', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fileName }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = (await res.json()) as { results?: ResolvedLocalFile[] };
        const matches = data.results ?? [];
        const first = matches[0];
        if (!first) {
          addToast({
            type: 'error',
            title: '未找到本地文件',
            message: `没有在已注册 workspace / linked root 中找到 ${fileName}`,
            duration: 5000,
          });
          return;
        }

        setOpenFile(first.path, null, first.worktreeId);
        if (matches.length > 1) {
          addToast({
            type: 'info',
            title: '找到多个同名文件',
            message: `已打开最近修改的 ${fileName}`,
            duration: 3500,
          });
        }
      } catch {
        addToast({
          type: 'error',
          title: '打开本地文件失败',
          message: `无法解析 ${fileName}，请确认文件所在目录已加入 workspace / linked root`,
          duration: 5000,
        });
      }
    },
    [addToast, fileName, setOpenFile],
  );

  return (
    <button
      type="button"
      data-local-file-link
      onClick={handleClick}
      className="inline rounded border border-[var(--clowder-markdown-chip-border)] bg-[var(--clowder-markdown-chip-bg)] px-1 py-0.5 font-mono text-[0.85em] font-semibold text-[var(--clowder-markdown-chip-text)] hover:underline"
      title={`点击在工作区中查找并打开本地文件\n${fileName}`}
    >
      {fileName}
    </button>
  );
}

/** Process string children → @mentions + file path links */
function withMentionsAndLinks(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child !== 'string') return child;
    // First pass: file paths → ReactNode[]
    const linked = linkifyFilePaths(child);
    // Second pass: highlight @mentions in remaining text nodes
    return (
      <>
        {linked.map((node, i) => {
          if (typeof node !== 'string') return node;
          const localLinked = linkifyLocalFileNames(node);
          return (
            <span key={i}>
              {localLinked.map((localNode, j) =>
                typeof localNode === 'string' ? <span key={j}>{highlightMentions(localNode)}</span> : localNode,
              )}
            </span>
          );
        })}
      </>
    );
  });
}

/* ── Slock-like visual emphasis ────────────────────────────── */
const SECTION_TITLE_RE = /^[\s]*[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳✅✔⓪🔎📋⚠💡🛠]/u;

function getTextPrefix(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => (typeof child === 'string' ? child : ''))
    .join('')
    .trimStart();
}

function getPlainText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => {
      if (typeof child === 'string' || typeof child === 'number') return String(child);
      if (isValidElement(child)) {
        const props = child.props as { children?: ReactNode };
        return getPlainText(props.children);
      }
      return '';
    })
    .join('')
    .trimStart();
}

function isSectionTitle(children: ReactNode): boolean {
  return SECTION_TITLE_RE.test(getTextPrefix(children));
}

function renderOrderedListItemContent(children: ReactNode): ReactNode {
  const nodes = Children.toArray(children);
  if (nodes.length === 0) return null;

  const [first, ...rest] = nodes;
  if (isValidElement(first) && first.type === 'p') {
    const firstProps = first.props as { children?: ReactNode };
    return (
      <>
        {withMentionsAndLinks(firstProps.children)}
        {rest}
      </>
    );
  }

  return withMentions(children);
}

/* ── Markdown component overrides ──────────────────────────── */
const mdComponents: Components = {
  p: ({ children }) => {
    const sectionTitle = isSectionTitle(children);
    return (
      <p
        className={
          sectionTitle
            ? 'mb-2 last:mb-0 leading-relaxed rounded bg-[var(--clowder-section-title-bg)] px-1.5 py-0.5'
            : 'mb-2 last:mb-0 leading-relaxed'
        }
      >
        {withMentionsAndLinks(children)}
      </p>
    );
  },
  strong: ({ children }) => <strong className="font-semibold">{withMentions(children)}</strong>,
  em: ({ children }) => <em>{withMentions(children)}</em>,
  del: ({ children }) => <del className="opacity-60">{withMentions(children)}</del>,

  h1: ({ children }) => <h1 className="text-lg font-bold mb-2 mt-3 first:mt-0">{withMentions(children)}</h1>,
  h2: ({ children }) => <h2 className="text-base font-bold mb-2 mt-3 first:mt-0">{withMentions(children)}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-bold mb-1 mt-2 first:mt-0">{withMentions(children)}</h3>,
  h4: ({ children }) => <h4 className="text-sm font-semibold mb-1 mt-2 first:mt-0">{withMentions(children)}</h4>,
  h5: ({ children }) => (
    <h5 className="text-xs font-semibold mb-1 mt-1.5 first:mt-0 uppercase tracking-wide">{withMentions(children)}</h5>
  ),
  h6: ({ children }) => (
    <h6 className="text-xs font-medium mb-1 mt-1.5 first:mt-0 text-cafe-secondary">{withMentions(children)}</h6>
  ),

  ul: ({ children }) => <ul className="list-disc pl-5 mb-2 space-y-0.5">{children}</ul>,
  ol: ({ children, start }) => {
    const items = Children.toArray(children);
    let counter = typeof start === 'number' ? start - 1 : 0;

    return (
      <ol className="mb-2 space-y-0.5 pl-0" style={{ listStyle: 'none' }}>
        {items.map((item, index) => {
          if (!isValidElement(item)) return item;
          counter += 1;
          const liProps = item.props as { children?: ReactNode; className?: string };
          const isTaskListItem = liProps.className === 'task-list-item';

          if (isTaskListItem) {
            return item;
          }

          return (
            <li key={item.key ?? index} style={{ listStyle: 'none' }}>
              {counter}.&nbsp;{renderOrderedListItemContent(liProps.children)}
            </li>
          );
        })}
      </ol>
    );
  },
  li: ({ children, className }) => (
    <li className={className === 'task-list-item' ? 'list-none -ml-5 flex items-start gap-1.5' : undefined}>
      {withMentions(children)}
    </li>
  ),
  input: ({ type, checked }) =>
    type === 'checkbox' ? (
      <input
        type="checkbox"
        checked={checked}
        readOnly
        className="mt-1 h-3.5 w-3.5 rounded border-[var(--console-border-soft)] text-[var(--color-cafe-accent)] pointer-events-none"
      />
    ) : (
      <input type={type} />
    ),

  blockquote: ({ children }) => {
    const text = getPlainText(children);
    const tone = /^[\s>]*(✅|✔|✓|done|完成|已完成|通过)/i.test(text)
      ? 'success'
      : /^[\s>]*(⚠|注意|风险|warning|warn|blocked|阻塞)/i.test(text)
        ? 'warning'
        : /^[\s>]*(❌|✗|失败|错误|error|failed)/i.test(text)
          ? 'danger'
          : 'neutral';

    const toneClass =
      tone === 'success'
        ? 'border-l-conn-emerald-text bg-conn-emerald-bg'
        : tone === 'warning'
          ? 'border-l-conn-amber-text bg-conn-amber-bg'
          : tone === 'danger'
            ? 'border-l-conn-red-text bg-conn-red-bg'
            : 'border-l-[var(--cafe-accent)] bg-[var(--console-card-soft-bg)]';

    return (
      <blockquote
        className={`my-2 rounded-md border border-[var(--console-border-soft)] border-l-4 px-3 py-2 text-[13px] leading-6 text-cafe-secondary ${toneClass} [&_p]:mb-1 [&_p:last-child]:mb-0`}
      >
        {children}
      </blockquote>
    );
  },
  a: ({ href, children }) => {
    // Only render as a real link for external URLs (http/https) or vscode:// deep links.
    // Relative paths (e.g. agent-generated file references) would 404 in Next.js — render
    // as styled text instead.
    const isExternal = href?.startsWith('http://') || href?.startsWith('https://') || href?.startsWith('vscode://');
    if (!isExternal) {
      return (
        <span className="text-[var(--color-cafe-accent)] break-all">{withMentions(children)}</span>
      );
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--color-cafe-accent)] hover:underline break-all"
      >
        {withMentions(children)}
      </a>
    );
  },
  hr: () => <hr className="my-3 border-[var(--console-border-soft)]" />,

  /* Code blocks with copy button */
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  code: ({ className, children }) => {
    const isCodeBlock = /language-/.test(className ?? '');
    if (isCodeBlock) return <code className={className}>{children}</code>;

    return (
      <code
        className={`${className ?? ''} rounded border border-[var(--clowder-markdown-chip-border)] bg-[var(--clowder-markdown-chip-bg)] px-1.5 py-0.5 font-mono text-[0.85em] text-[var(--clowder-markdown-chip-text)]`}
      >
        {children}
      </code>
    );
  },

  /* Tables (GFM) */
  table: ({ children }) => (
    <div className="overflow-x-auto my-2">
      <table className="min-w-full text-sm border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-cafe-surface-elevated">{children}</thead>,
  th: ({ children }) => (
    <th className="border border-[var(--console-border-soft)] px-2 py-1 text-left font-semibold text-xs">
      {withMentions(children)}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-[var(--console-border-soft)] px-2 py-1">{withMentions(children)}</td>
  ),
};

/* ── Exported component ────────────────────────────────────── */
interface Props {
  content: string;
  className?: string;
  /** Skip slash-command prefix detection (e.g. for rich block bodyMarkdown) */
  disableCommandPrefix?: boolean;
  /** Base directory path for resolving relative links (e.g. "docs/features") */
  basePath?: string;
  /** Worktree ID for resolving workspace-relative image paths */
  worktreeId?: string;
}

/** Check if href is a relative markdown link (not absolute, not external) */
export function isRelativeMdLink(href: string | undefined): href is string {
  if (!href) return false;
  if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('/')) return false;
  return /\.mdx?(?:#|$)/.test(href);
}

/** Resolve a relative path against a base directory */
export function resolveRelativePath(base: string, relative: string): string {
  // Strip fragment/hash
  const clean = relative.split('#')[0];
  // base is the directory of the current file (e.g. "docs/features")
  const parts = base ? base.split('/') : [];
  for (const seg of clean.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

export function MarkdownContent({ content, className, disableCommandPrefix, basePath, worktreeId }: Props) {
  const cmdMatch = disableCommandPrefix ? null : /^(\/\w+)/.exec(content);
  const md = cmdMatch ? content.slice(cmdMatch[1].length) : content;

  let components = mdComponents;
  if (basePath != null) {
    components = { ...components, a: createWorkspaceLinkComponent(basePath, withMentions) };
    if (worktreeId) {
      components = { ...components, img: createWorkspaceImageComponent(basePath, worktreeId) };
    }
  }

  return (
    <div className={`markdown-content text-sm break-words ${className ?? ''}`}>
      {cmdMatch && <span className="font-semibold text-cocreator-primary">{cmdMatch[1]}</span>}
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
        {md}
      </ReactMarkdown>
    </div>
  );
}
