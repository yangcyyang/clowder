/** Shared image-upload glyph — used by ChatInput (main channel composer) and
 *  InlineThreadPanel (thread composer) so both stay visually identical. */
export function ImageUploadIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="4" width="14" height="12" rx="2.5" />
      <circle cx="7.5" cy="8" r="1.3" fill="currentColor" stroke="none" />
      <path d="M5.5 14l3.2-3.3 2.2 2.1 1.6-1.7L16 14" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
