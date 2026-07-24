'use client';

interface MessageContextMenuProps {
  x: number;
  y: number;
  messageId: string;
  content: string;
  onClose: () => void;
  onSave?: () => void;
  onConvertToTask?: () => void;
  onShare?: () => void;
  onPin?: () => void;
  onEdit?: () => void;
  onSoftDelete?: () => void;
  onHardDelete?: () => void;
}

export function MessageContextMenu({
  x,
  y,
  messageId,
  content,
  onClose,
  onSave,
  onConvertToTask,
  onShare,
  onPin,
  onEdit,
  onSoftDelete,
  onHardDelete,
}: MessageContextMenuProps) {
  const items = [
    {
      label: 'Copy link',
      onClick: () => {
        void navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}#${messageId}`);
        onClose();
      },
    },
    {
      label: 'Copy markdown',
      onClick: () => {
        void navigator.clipboard.writeText(content);
        onClose();
      },
    },
    {
      label: 'Save message',
      onClick: () => {
        onSave?.();
        onClose();
      },
    },
    ...(onConvertToTask
      ? [
          {
            label: 'Convert to Task',
            onClick: () => {
              onConvertToTask();
              onClose();
            },
          },
        ]
      : []),
    ...(onPin
      ? [
          {
            label: 'Pin message',
            onClick: () => {
              onPin();
              onClose();
            },
          },
        ]
      : []),
    ...(onEdit
      ? [
          {
            label: 'Edit message',
            onClick: () => {
              onEdit();
              onClose();
            },
          },
        ]
      : []),
    {
      label: 'Share messages...',
      onClick: () => {
        onShare?.();
        onClose();
      },
    },
    ...(onSoftDelete
      ? [
          {
            label: 'Delete message',
            onClick: () => {
              onSoftDelete();
              onClose();
            },
          },
        ]
      : []),
    ...(onHardDelete
      ? [
          {
            label: 'Delete permanently',
            onClick: () => {
              onHardDelete();
              onClose();
            },
          },
        ]
      : []),
  ];

  return (
    <>
      <div className="fixed inset-0 z-[9998]" onClick={onClose} aria-hidden="true" />
      <div
        className="fixed z-[9999] min-w-[160px] rounded-lg border border-[var(--slock-border-color)] bg-[var(--cafe-surface)] py-1 shadow-lg"
        style={{ top: y, left: x }}
        role="menu"
      >
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={item.onClick}
            className="w-full px-3 py-1.5 text-left text-sm text-[var(--cafe-text)] transition-colors hover:bg-[var(--cafe-surface-elevated)]"
            role="menuitem"
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}
