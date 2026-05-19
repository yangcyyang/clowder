'use client';

import { useState } from 'react';
import type { MessageContent } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import { Lightbox } from './Lightbox';
import { MarkdownContent } from './MarkdownContent';

function formatFileSize(bytes?: number) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ContentBlocks({ blocks }: { blocks: MessageContent[] }) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  return (
    <>
      {blocks.map((block, i) => {
        if (block.type === 'text') {
          return <MarkdownContent key={i} content={block.text} />;
        }
        if (block.type === 'image') {
          const src = block.url.startsWith('/uploads/') ? `${API_URL}${block.url}` : block.url;
          return (
            // biome-ignore lint/performance/noImgElement: uploaded images cannot use next/image
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={i}
              src={src}
              alt="attached image"
              className="max-w-full sm:max-w-sm rounded-lg mt-2 border border-[var(--console-border-soft)] cursor-pointer hover:opacity-90 transition-opacity"
              onClick={() => setLightboxSrc(src)}
            />
          );
        }
        if (block.type === 'file') {
          const href = block.url.startsWith('/uploads/') ? `${API_URL}${block.url}` : block.url;
          const size = formatFileSize(block.size);
          const downloadName = block.filename || 'attachment';
          return (
            <a
              key={i}
              href={href}
              download={downloadName}
              target="_blank"
              rel="noreferrer"
              className="mt-2 flex max-w-sm items-center gap-3 rounded-lg border border-[var(--console-border-soft)] bg-[var(--console-hover-bg)] px-3 py-2 text-sm text-cafe-primary transition-colors hover:border-cafe-accent"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-cafe-surface text-cafe-muted">
                FILE
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{downloadName}</span>
                <span className="block text-xs text-cafe-muted">
                  {block.mimeType ?? 'file'}
                  {size ? ` · ${size}` : ''}
                </span>
              </span>
              <span className="text-xs text-cafe-accent">下载</span>
            </a>
          );
        }
        return null;
      })}
      {lightboxSrc && <Lightbox url={lightboxSrc} alt="attached image" onClose={() => setLightboxSrc(null)} />}
    </>
  );
}
