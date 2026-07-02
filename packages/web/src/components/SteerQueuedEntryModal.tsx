'use client';

import { useEffect, useRef } from 'react';

export type SteerMode = 'immediate' | 'promote';

export function SteerQueuedEntryModal({
  mode,
  onCancel,
  onConfirm,
  onModeChange,
}: {
  mode: SteerMode;
  onCancel: () => void;
  onConfirm: () => void;
  onModeChange: (mode: SteerMode) => void;
}) {
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onCancel]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop click-to-close, keyboard Escape handled via useEffect
    <div
      role="presentation"
      className="fixed inset-0 bg-[var(--console-overlay-backdrop)] flex items-center justify-center z-50"
      onClick={(e) => {
        if (modalRef.current && !modalRef.current.contains(e.target as Node)) onCancel();
      }}
    >
      <div ref={modalRef} className="bg-cafe-surface rounded-2xl shadow-2xl w-full max-w-[520px] mx-4 overflow-hidden">
        <div className="px-6 pt-6 pb-4">
          <h2 className="text-lg font-semibold text-cafe-black">Steer 这条排队消息</h2>
          <p className="text-sm text-cafe-secondary mt-1">选择你希望如何处理这条 queued 消息：</p>
        </div>

        <div className="px-6 pb-5 space-y-3">
          <button
            type="button"
            data-testid="steer-mode-immediate"
            onClick={() => onModeChange('immediate')}
            className={`w-full text-left p-4 rounded-xl border transition-colors ${
              mode === 'immediate'
                ? 'border-[var(--color-opus-primary)] bg-[var(--color-opus-primary)]/5'
                : 'border-[var(--console-border-soft)] hover:border-[var(--console-border-soft)] bg-cafe-surface'
            }`}
          >
            <div className="text-sm font-medium text-cafe">引导当前回合 / 立即执行</div>
            <div className="text-xs text-cafe-secondary mt-1">
              若目标 Claude 正在执行且 steer v2 已开启，会直接注入当前回合；否则回落为立即执行。
            </div>
          </button>

          <button
            type="button"
            data-testid="steer-mode-promote"
            onClick={() => onModeChange('promote')}
            className={`w-full text-left p-4 rounded-xl border transition-colors ${
              mode === 'promote'
                ? 'border-[var(--color-opus-primary)] bg-[var(--color-opus-primary)]/5'
                : 'border-[var(--console-border-soft)] hover:border-[var(--console-border-soft)] bg-cafe-surface'
            }`}
          >
            <div className="text-sm font-medium text-cafe">提到队首（不取消）</div>
            <div className="text-xs text-cafe-secondary mt-1">只调整顺序；当前猫跑完后优先执行这条消息。</div>
          </button>
        </div>

        <div className="px-6 pb-6 flex items-center justify-between">
          <button
            type="button"
            onClick={onCancel}
            className="text-sm text-cafe-secondary hover:text-cafe-secondary transition-colors"
          >
            取消
          </button>
          <button
            type="button"
            data-testid="steer-confirm"
            onClick={onConfirm}
            className="text-sm px-4 py-2 rounded-full bg-[var(--color-opus-primary)] text-[var(--cafe-surface)] hover:bg-[var(--color-opus-dark)] transition-colors"
          >
            确认
          </button>
        </div>
      </div>
    </div>
  );
}
