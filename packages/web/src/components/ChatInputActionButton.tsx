'use client';

import { useEffect } from 'react';
import { useVoiceInput } from '@/hooks/useVoiceInput';
import { LoadingIcon } from './icons/LoadingIcon';
import { MicIcon } from './icons/MicIcon';
import { SendIcon } from './icons/SendIcon';
import { StopRecordingIcon } from './icons/StopRecordingIcon';

interface ChatInputActionButtonProps {
  onTranscript: (text: string) => void;
  onSend: () => void;
  onStop?: () => void;
  disabled?: boolean;
  sendDisabled?: boolean;
  /** Whether the thread has an active invocation (broader than disabled/isLoading) */
  hasActiveInvocation?: boolean;
  hasText: boolean;
}

/** Renders the action button states:
 *  1. Stop generation (disabled + active invocation)
 *  2. Stop recording
 *  3. Transcribing
 *  4. Normal send (has text, including while an agent is active)
 *  5. Mic (default)
 *
 *  Plus voice recording status overlays (REC badge, error).
 *  Keyboard shortcut: Option+V toggles recording. */
export function ChatInputActionButton({
  onTranscript,
  onSend,
  onStop,
  disabled,
  sendDisabled,
  hasActiveInvocation,
  hasText,
}: ChatInputActionButtonProps) {
  const voice = useVoiceInput();
  const isSendDisabled = Boolean(disabled || sendDisabled);

  useEffect(() => {
    if (voice.transcript) onTranscript(voice.transcript);
  }, [voice.transcript, onTranscript]);

  // Global keyboard shortcut: Option+V (Alt+V) toggles voice recording
  const { state: voiceState, startRecording, stopRecording } = voice;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.altKey && e.code === 'KeyV') {
        e.preventDefault();
        if (voiceState === 'recording') {
          stopRecording();
        } else if (voiceState === 'idle' && !disabled) {
          startRecording();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [voiceState, startRecording, stopRecording, disabled]);

  return (
    <>
      {/* Voice recording status (absolute, attaches to ancestor .relative) */}
      {voice.state === 'recording' && (
        <div className="absolute top-0 right-4 -mt-6 flex items-center gap-2">
          {voice.partialTranscript && (
            <div className="px-2 py-0.5 bg-cafe-surface-sunken text-[var(--cafe-surface)] text-xs rounded-lg max-w-[240px] truncate opacity-80">
              {voice.partialTranscript}
            </div>
          )}
          <div className="px-2 py-0.5 bg-conn-red-bg text-conn-red-text text-xs rounded-full animate-pulse whitespace-nowrap">
            REC {Math.floor(voice.duration / 60)}:{String(voice.duration % 60).padStart(2, '0')}
          </div>
        </div>
      )}
      {voice.error && (
        <div className="absolute top-0 left-4 -mt-6 px-3 py-1 bg-conn-red-bg text-conn-red-text text-xs rounded-lg">
          {voice.error}
        </div>
      )}

      {/* Stop button: visible alongside normal send during active invocation (not when disabled — primary stop covers it) */}
      {hasActiveInvocation && !disabled && onStop && (
        <button
          onClick={() => onStop()}
          className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-[var(--console-stop)] text-[var(--cafe-surface)] hover:opacity-80 transition-colors"
          title="停止生成"
          aria-label="Stop generation"
        >
          <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
            <rect x="4" y="4" width="12" height="12" rx="2" />
          </svg>
        </button>
      )}

      {/* Primary action button priority chain:
         State 1: idle-empty → mic
         State 2: has-text → send (bg input-stroke)
         State 3: agent-replying, no text → mic (stop is separate)
         State 4: agent-replying + text → normal send (backend may serialize internally) */}
      {disabled && onStop && hasActiveInvocation ? (
        <button
          onClick={() => onStop()}
          className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-[var(--console-stop)] text-[var(--cafe-surface)] hover:opacity-80 transition-colors"
          title="停止生成"
          aria-label="Stop generation"
        >
          <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
            <rect x="4" y="4" width="12" height="12" rx="2" />
          </svg>
        </button>
      ) : voice.state === 'recording' ? (
        <button
          onClick={voice.stopRecording}
          className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-[var(--console-stop)] text-[var(--cafe-surface)] hover:opacity-80 transition-colors animate-pulse"
          title="停止录音"
          aria-label="Stop recording"
        >
          <StopRecordingIcon className="w-5 h-5" />
        </button>
      ) : voice.state === 'transcribing' ? (
        <button
          disabled
          className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-cafe-surface-sunken text-[var(--cafe-surface)] cursor-wait"
          title="转写中"
          aria-label="Transcribing"
        >
          <LoadingIcon className="w-5 h-5" />
        </button>
      ) : hasText ? (
        <button
          onClick={onSend}
          disabled={isSendDisabled}
          className="flex h-10 w-[42px] items-center justify-center rounded-[12px] bg-[var(--console-input-stroke)] text-[var(--cafe-surface)] hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="发送消息"
          aria-label="Send message"
        >
          <SendIcon className="w-5 h-5" />
        </button>
      ) : (
        <button
          onClick={voice.startRecording}
          disabled={disabled}
          className="flex h-10 w-10 items-center justify-center rounded-[12px] text-cafe-muted hover:text-cafe-accent hover:bg-[var(--console-hover-bg)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          aria-label="Start voice input (⌥V)"
          title="语音输入 (⌥V)"
        >
          <MicIcon className="w-5 h-5" />
        </button>
      )}
    </>
  );
}
