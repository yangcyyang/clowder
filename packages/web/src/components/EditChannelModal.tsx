'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CatData } from '@/hooks/useCatData';
import { formatCatName } from '@/hooks/useCatData';

interface SaveChannelPayload {
  title: string;
  participatingCats: string[];
}

interface EditChannelModalProps {
  open: boolean;
  title: string;
  availableCats: CatData[];
  selectedCatIds: string[];
  isDefaultThread: boolean;
  isSaving: boolean;
  isDeleting: boolean;
  error?: string | null;
  onClose: () => void;
  onSave: (payload: SaveChannelPayload) => void;
  onDelete: () => void;
}

export function EditChannelModal({
  open,
  title,
  availableCats,
  selectedCatIds,
  isDefaultThread,
  isSaving,
  isDeleting,
  error,
  onClose,
  onSave,
  onDelete,
}: EditChannelModalProps) {
  const [nameDraft, setNameDraft] = useState(title);
  const [descriptionDraft, setDescriptionDraft] = useState('');
  const [memberDraft, setMemberDraft] = useState<string[]>(selectedCatIds);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!open) return;
    setNameDraft(title);
    setDescriptionDraft('');
    setMemberDraft([...new Set(selectedCatIds)]);
    setConfirmDelete(false);
  }, [open, selectedCatIds, title]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSaving && !isDeleting) onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isDeleting, isSaving, onClose, open]);

  const normalizedName = nameDraft.trim();
  const canSubmit = normalizedName.length > 0 && !isSaving && !isDeleting;
  const catsById = useMemo(() => new Map(availableCats.map((cat) => [cat.id, cat])), [availableCats]);
  const memberSet = useMemo(() => new Set(memberDraft), [memberDraft]);
  const selectedMembers = memberDraft.map((id) => catsById.get(id)).filter((cat): cat is CatData => Boolean(cat));
  const addableCats = availableCats.filter((cat) => !memberSet.has(cat.id));

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-[var(--console-overlay-backdrop)] px-4"
      role="presentation"
    >
      <div className="absolute inset-0" aria-hidden="true" onClick={isSaving || isDeleting ? undefined : onClose} />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-channel-title"
        className="relative w-full max-w-[420px] rounded-2xl border border-[var(--slock-border-color)] bg-[var(--console-card-bg)] p-5 shadow-[var(--console-shadow)]"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="edit-channel-title" className="text-xs font-bold tracking-[0.18em] text-[var(--cafe-text)]">
              EDIT CHANNEL
            </h2>
            <p className="mt-1 text-xs text-[var(--cafe-text-secondary)]">更新频道名称，或删除当前对话。</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving || isDeleting}
            className="rounded-lg px-2 py-1 text-sm text-[var(--cafe-text-muted)] transition-colors hover:bg-[var(--console-hover-bg)] hover:text-[var(--cafe-text)] disabled:opacity-50"
            aria-label="关闭频道设置"
          >
            ×
          </button>
        </div>

        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) onSave({ title: normalizedName, participatingCats: memberDraft });
          }}
        >
          <label className="block">
            <span className="text-[11px] font-semibold tracking-[0.14em] text-[var(--cafe-text-secondary)]">
              NAME *
            </span>
            <input
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              maxLength={200}
              className="mt-1 w-full rounded-lg border border-[var(--slock-border-color)] bg-[var(--console-shell-bg)] px-3 py-2 text-sm text-[var(--cafe-text)] outline-none transition-colors focus:border-[var(--cafe-accent)]"
              autoFocus
            />
          </label>

          <label className="block">
            <span className="text-[11px] font-semibold tracking-[0.14em] text-[var(--cafe-text-secondary)]">
              DESCRIPTION
            </span>
            <textarea
              value={descriptionDraft}
              onChange={(event) => setDescriptionDraft(event.target.value)}
              placeholder="描述功能后续接入；当前仅作为界面占位"
              className="mt-1 min-h-20 w-full resize-none rounded-lg border border-[var(--slock-border-color)] bg-[var(--console-shell-bg)] px-3 py-2 text-sm text-[var(--cafe-text)] outline-none transition-colors placeholder:text-[var(--cafe-text-muted)] focus:border-[var(--cafe-accent)]"
            />
          </label>

          <div className="rounded-xl border border-[var(--slock-border-color)] bg-[var(--console-shell-bg)] p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold tracking-[0.14em] text-[var(--cafe-text-secondary)]">
                  MEMBERS
                </div>
                <p className="mt-1 text-xs leading-[1.5] text-[var(--cafe-text-muted)]">
                  成员决定这个频道里可被 @ 的 Agent；不会自动广播给所有成员。
                </p>
              </div>
              <select
                value=""
                disabled={isSaving || isDeleting || addableCats.length === 0}
                onChange={(event) => {
                  const catId = event.target.value;
                  if (!catId) return;
                  setMemberDraft((prev) => [...new Set([...prev, catId])]);
                }}
                className="max-w-[150px] rounded-lg border border-[var(--slock-border-color)] bg-[var(--console-card-bg)] px-2 py-1.5 text-xs text-[var(--cafe-text)] outline-none focus:border-[var(--cafe-accent)] disabled:opacity-50"
                aria-label="添加 Agent 成员"
              >
                <option value="">+ Add Agent</option>
                {addableCats.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {formatCatName(cat)}
                  </option>
                ))}
              </select>
            </div>

            <div className="mt-3 space-y-2">
              {selectedMembers.map((cat) => (
                <div
                  key={cat.id}
                  className="flex items-center gap-2 rounded-lg bg-[var(--console-card-bg)] px-2 py-1.5 ring-1 ring-[var(--slock-border-color)]"
                >
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[11px] font-bold text-white"
                    style={{ backgroundColor: cat.color.primary }}
                  >
                    {formatCatName(cat).slice(0, 1)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-[var(--cafe-text)]">
                      {formatCatName(cat)}
                    </span>
                    <span className="block truncate text-[11px] leading-[1.4] text-[var(--cafe-text-muted)]">
                      {cat.id}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setMemberDraft((prev) => prev.filter((id) => id !== cat.id))}
                    disabled={isSaving || isDeleting}
                    className="rounded-md px-2 py-1 text-xs font-semibold text-[var(--cafe-text-muted)] transition-colors hover:bg-[var(--console-hover-bg)] hover:text-[var(--cafe-text)] disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              ))}
              {selectedMembers.length === 0 && (
                <div className="rounded-lg border border-dashed border-[var(--slock-border-color)] px-3 py-3 text-xs leading-[1.5] text-[var(--cafe-text-muted)]">
                  暂未配置成员。未配置时 @ 选择器会临时回退为全部可用 Agent，避免旧频道不可用。
                </div>
              )}
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-conn-crimson-ring bg-conn-crimson-bg px-3 py-2 text-xs text-conn-crimson-text">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={isSaving || isDeleting}
              className="rounded-lg px-3 py-2 text-sm font-medium text-[var(--cafe-text-secondary)] transition-colors hover:bg-[var(--console-hover-bg)] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="rounded-lg bg-[var(--cafe-accent)] px-3 py-2 text-sm font-semibold text-[var(--cafe-accent-foreground)] transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSaving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>

        {!isDefaultThread && (
          <div className="mt-5 border-t border-[var(--slock-border-color)] pt-4">
            <div className="rounded-xl bg-conn-crimson-bg p-3">
              <div className="text-sm font-semibold text-conn-crimson-text">Delete Channel</div>
              <p className="mt-1 text-xs text-conn-crimson-text/80">删除后会进入回收站，可从侧边栏回收站恢复。</p>
              <button
                type="button"
                onClick={() => {
                  if (!confirmDelete) {
                    setConfirmDelete(true);
                    return;
                  }
                  onDelete();
                }}
                disabled={isSaving || isDeleting}
                className="mt-3 rounded-lg bg-conn-crimson-bg px-3 py-2 text-sm font-semibold text-conn-crimson-text ring-1 ring-conn-crimson-ring transition-colors hover:bg-conn-crimson-bg/80 disabled:opacity-50"
              >
                {isDeleting ? 'Deleting...' : confirmDelete ? 'Confirm Delete' : 'Delete Channel'}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
