'use client';

import { MarkdownContent } from '@/components/MarkdownContent';
import type { RichCardBlock } from '@/stores/chat-types';

const TONE_STYLES: Record<string, string> = {
  info: 'border-l-[var(--color-cafe-accent)]/60 bg-[var(--color-cafe-accent)]/5 dark:bg-[var(--color-cafe-accent)]/10',
  success: 'border-l-conn-emerald-ring bg-conn-emerald-bg dark:bg-conn-emerald-bg',
  warning: 'border-l-conn-amber-ring bg-conn-amber-bg dark:bg-conn-amber-bg',
  danger: 'border-l-conn-red-ring bg-conn-red-bg dark:bg-conn-red-bg',
};

export function CardBlock({ block }: { block: RichCardBlock; messageId?: string }) {
  const toneStyle = TONE_STYLES[block.tone ?? 'info'] ?? TONE_STYLES['info'];

  return (
    <div className={`border-l-4 rounded-r-lg p-3 ${toneStyle}`}>
      <div className="font-medium text-sm">{block.title}</div>
      {block.bodyMarkdown && (
        <div className="mt-1 text-xs text-cafe-secondary dark:text-cafe-muted [&_.markdown-content]:text-xs [&_p]:mb-1 [&_p:last-child]:mb-0">
          <MarkdownContent content={block.bodyMarkdown} className="!text-xs" disableCommandPrefix />
        </div>
      )}
      {block.fields && block.fields.length > 0 && (
        <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-1">
          {block.fields.map((f, i) => (
            <div key={i} className="text-xs">
              <span className="text-cafe-secondary">{f.label}:</span>{' '}
              <span className="font-mono break-all">{f.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
