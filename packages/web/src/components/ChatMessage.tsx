'use client';

import type { TaskItem, TaskStatus } from '@cat-cafe/shared';
import { type CatData, formatCatName } from '@/hooks/useCatData';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { getMentionRe, getMentionToCat } from '@/lib/mention-highlight';
import { parseDirection } from '@/lib/parse-direction';
import { type ChatMessage as ChatMessageType, resolveBubbleExpanded, useChatStore } from '@/stores/chatStore';
import { useTaskStore } from '@/stores/taskStore';
import { CatAvatar } from './CatAvatar';
import { CollapsibleMarkdown } from './CollapsibleMarkdown';
import { ConnectorBubble } from './ConnectorBubble';
import { ContentBlocks } from './ContentBlocks';
import { DirectionPill } from './DirectionPill';
import { EvidencePanel } from './EvidencePanel';
import { GovernanceBlockedCard } from './GovernanceBlockedCard';
import { ReplyPill } from './ReplyPill';
import { BriefingCard } from './rich/BriefingCard';
import { RichBlocks } from './rich/RichBlocks';
import { SummaryCard } from './SummaryCard';
import { SystemNoticeBar } from './SystemNoticeBar';
import { ThinkingContent } from './ThinkingContent';
import { getThreadHref, pushThreadRouteWithHistory } from './ThreadSidebar/thread-navigation';
import { TimeoutDiagnosticsPanel } from './TimeoutDiagnosticsPanel';

const BREED_STYLES: Record<string, { font?: string }> = {
  ragdoll: {},
  'maine-coon': { font: 'font-mono' },
  siamese: {},
  'dragon-li': { font: 'font-mono' },
};
const DEFAULT_BREED_STYLE = {};
const SCHEDULER_ACCENT_BADGE_CLASS =
  'inline-flex w-fit items-center gap-1.5 rounded-full border border-conn-amber-text/30 bg-conn-amber-bg px-2.5 py-1 text-[11px] font-semibold text-conn-amber-text shadow-sm';
const SCHEDULER_ACCENT_BUBBLE_CLASS = 'border-l-2 border-conn-amber-text/50 pl-3';
const MODEL_SIGNATURE_LINE_RE = /^\s*\[[^\]]*(?:gpt|opus|claude|codex|gemini|kimi|模型)[^\]]*(?:🐾|📋)?\]\s*$/i;
const MODEL_METADATA_LINE_RE = /\bmodel\s*=\s*[a-z0-9._/-]+/i;
const IDENTITY_PREAMBLE_RE = /当前会话身份标注|身份标注为/i;

function sanitizeAgentVisibleContent(content: string): string {
  const lines = content.split(/\r?\n/);
  const cleaned: string[] = [];

  for (const line of lines) {
    if (MODEL_SIGNATURE_LINE_RE.test(line)) continue;
    if (MODEL_METADATA_LINE_RE.test(line)) continue;
    if (IDENTITY_PREAMBLE_RE.test(line)) continue;
    cleaned.push(line);
  }

  return cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: '待办',
  doing: '进行中',
  blocked: '阻塞',
  done: '完成',
};

const TASK_BADGE_CLASS: Record<TaskStatus, string> = {
  todo: 'bg-[var(--cafe-accent)]/15 text-[var(--cafe-accent)] ring-[var(--cafe-accent)]/25',
  doing: 'bg-cafe-crosspost/15 text-cafe-crosspost ring-cafe-crosspost/25',
  blocked: 'bg-conn-amber-bg text-conn-amber-text ring-conn-amber-text/25',
  done: 'bg-conn-emerald-bg text-conn-emerald-text ring-conn-emerald-ring',
};

function MessageTaskBadge({ task, seq }: { task: TaskItem; seq: number }) {
  const status = task.status;
  return (
    <div className="mt-1.5">
      <span
        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold leading-none ring-1 ${TASK_BADGE_CLASS[status] ?? TASK_BADGE_CLASS.todo}`}
        title={`${TASK_STATUS_LABELS[status] ?? status}: ${task.title}`}
      >
        #{seq}
      </span>
    </div>
  );
}

function ThreadReplyBadge({ count, onOpen }: { count: number; onOpen: () => void }) {
  if (count <= 0) return null;

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpen();
        }}
        className="inline-flex items-center rounded-full border border-[var(--cafe-accent)]/30 bg-[var(--cafe-accent)]/10 px-2 py-0.5 text-[11px] font-semibold leading-none text-[var(--cafe-accent)] transition-colors hover:bg-[var(--cafe-accent)]/15"
      >
        {count} {count === 1 ? 'reply' : 'replies'}
      </button>
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const DELIVERED_AT_GAP_THRESHOLD = 5000;
function formatDualTime(timestamp: number, deliveredAt?: number): string {
  if (!deliveredAt || deliveredAt - timestamp <= DELIVERED_AT_GAP_THRESHOLD) {
    return formatTime(timestamp);
  }
  return `发送 ${formatTime(timestamp)} · 收到 ${formatTime(deliveredAt)}`;
}

function isSchedulerReplyPreview(replyPreview?: ChatMessageType['replyPreview']): boolean {
  return replyPreview?.senderCatId === 'system' && replyPreview.kind === 'scheduler_trigger';
}

function isConnectorSystemNotice(message: ChatMessageType): boolean {
  if (message.type !== 'connector' || !message.source?.meta) return false;
  return (message.source.meta as Record<string, unknown>).presentation === 'system_notice';
}

interface ChatMessageProps {
  message: ChatMessageType;
  getCatById: (id: string) => CatData | undefined;
  isGrouped?: boolean;
  threadReplyInfo?: { branchThreadId: string; replyCount: number };
  onOpenThread?: (messageId: string) => void;
  isEditing?: boolean;
  editDraft?: string;
  isSavingEdit?: boolean;
  onChangeEditDraft?: (value: string) => void;
  onSaveEdit?: () => void;
  onCancelEdit?: () => void;
}

export function ChatMessage({
  message,
  getCatById,
  isGrouped = false,
  threadReplyInfo,
  onOpenThread,
  isEditing = false,
  editDraft = '',
  isSavingEdit = false,
  onChangeEditDraft,
  onSaveEdit,
  onCancelEdit,
}: ChatMessageProps) {
  const coCreator = useCoCreatorConfig();
  const currentThreadId = useChatStore((s) => s.currentThreadId);
  const isLoadingThreads = useChatStore((s) => s.isLoadingThreads);
  const threads = useChatStore((s) => s.threads);
  const threadMessages = useChatStore((s) => s.messages);
  const globalBubbleDefaults = useChatStore((s) => s.globalBubbleDefaults);
  const tasks = useTaskStore((s) => s.tasks);
  const isUser = message.type === 'user' && !message.catId;
  const isSystem = message.type === 'system';
  const isSummary = message.type === 'summary';
  const isConnector = message.type === 'connector';

  const catData = message.catId ? getCatById(message.catId) : undefined;
  const catStyle = catData
    ? (() => {
        const breed = BREED_STYLES[catData.breedId ?? ''] ?? DEFAULT_BREED_STYLE;
        const label = formatCatName(catData);
        return {
          label,
          font: breed.font,
          color: catData.color.primary,
        };
      })()
    : null;
  const currentThread = useChatStore((s) => s.threads.find((t) => t.id === s.currentThreadId));
  const bubbleRestorePending = isLoadingThreads && !!currentThreadId && !currentThread;
  const hasBlocks = message.contentBlocks && message.contentBlocks.length > 0;
  const visibleContent = sanitizeAgentVisibleContent(message.content);
  const hasTextContent = visibleContent.trim().length > 0;
  const taskEntry = tasks
    .map((task, index) => ({ task, seq: index + 1 }))
    .find(({ task }) => task.kind !== 'pr_tracking' && task.sourceMessageId === message.id);
  const isWhisper = message.visibility === 'whisper';
  const isRevealed = isWhisper && !!message.revealedAt;
  const isSchedulerReply = isSchedulerReplyPreview(message.replyPreview);
  const showSchedulerAccent =
    isSchedulerReply &&
    !threadMessages.some((candidate) => {
      if (candidate.id === message.id) return false;
      if (candidate.replyTo !== message.replyTo) return false;
      if (candidate.catId !== message.catId) return false;
      if (!isSchedulerReplyPreview(candidate.replyPreview)) return false;
      if (candidate.timestamp !== message.timestamp) {
        return candidate.timestamp < message.timestamp;
      }
      return candidate.id < message.id;
    });

  const direction = catData ? parseDirection(message, () => ({ toCat: getMentionToCat(), re: getMentionRe() })) : null;
  const isAssistantContinuation = isGrouped;

  if (isSummary && message.summary) {
    return (
      <div data-message-id={message.id}>
        <SummaryCard
          topic={message.summary.topic}
          conclusions={message.summary.conclusions}
          openQuestions={message.summary.openQuestions}
          createdBy={message.summary.createdBy}
          timestamp={message.timestamp}
        />
      </div>
    );
  }

  if (isSystem) {
    // F148 Phase E + VG-2: Briefing card — collapsible with source label
    if (message.origin === 'briefing' && message.extra?.rich?.blocks?.length) {
      return (
        <div data-message-id={message.id} className="flex justify-center mb-3">
          <div className="max-w-[85%] w-full opacity-80">
            <BriefingCard block={message.extra.rich.blocks[0]} messageId={message.id} />
          </div>
        </div>
      );
    }

    if (message.variant === 'evidence' && message.evidence) {
      return <EvidencePanel data={message.evidence} />;
    }

    if (message.variant === 'governance_blocked' && message.extra?.governanceBlocked) {
      const { projectPath, reasonKind, invocationId } = message.extra.governanceBlocked;
      return <GovernanceBlockedCard projectPath={projectPath} reasonKind={reasonKind} invocationId={invocationId} />;
    }

    // F045: variant='thinking' is deprecated — thinking is now embedded in assistant bubbles.

    const isLegacyError = !message.variant && message.content.trim().startsWith('Error:');
    const isError = message.variant === 'error' || isLegacyError;
    const isTool = message.variant === 'tool';
    const isFollowup = message.variant === 'a2a_followup';

    // F118 AC-C3: Enhanced timeout diagnostics panel
    if (isError && message.extra?.timeoutDiagnostics) {
      return (
        <div data-message-id={message.id} className="flex justify-center mb-3">
          <div className="max-w-[85%] w-full">
            <TimeoutDiagnosticsPanel errorMessage={message.content} diagnostics={message.extra.timeoutDiagnostics} />
          </div>
        </div>
      );
    }

    const toneClass = isTool
      ? 'text-cafe-muted bg-cafe-surface-elevated/50 font-mono text-xs py-1'
      : isFollowup
        ? 'text-conn-purple-text bg-conn-purple-bg border border-conn-purple-ring'
        : isError
          ? 'text-conn-red-text bg-conn-red-bg rounded-full'
          : 'text-[var(--color-cafe-accent)] bg-[var(--color-cafe-accent)]/5';
    return (
      <div data-message-id={message.id} className={`flex justify-center ${isTool ? 'mb-1' : 'mb-3'}`}>
        <div className={`text-sm px-4 py-2 rounded-lg whitespace-pre-wrap text-left max-w-[85%] ${toneClass}`}>
          {isFollowup && <span className="mr-1">🔗</span>}
          {message.content}
          {isFollowup && (
            <span className="block mt-1 text-xs text-conn-purple-text">输入 @猫名 跟进 来发起 follow-up</span>
          )}
        </div>
      </div>
    );
  }

  if (isConnector && message.source) {
    if (isConnectorSystemNotice(message)) {
      return <SystemNoticeBar message={message} />;
    }
    return <ConnectorBubble message={message} />;
  }

  if (isUser) {
    const coCreatorPrimary = coCreator.color?.primary ?? '#815b5b';
    const coCreatorSecondary = coCreator.color?.secondary ?? '#FFDDD2';
    return (
      <div
        data-message-id={message.id}
        className="group flex justify-start gap-2 mb-4 items-start hover:bg-[rgba(255,255,255,0.03)] hover:ring-1 hover:ring-black/10 rounded-lg px-2 -mx-2 transition-colors"
      >
        <button
          type="button"
          onClick={() => useChatStore.getState().openCoCreatorEditor()}
          className="w-8 h-8 rounded-md overflow-hidden flex-shrink-0 ring-2 flex items-center justify-center text-[11px] font-bold text-[var(--cafe-surface)] cursor-pointer hover:opacity-80 transition-opacity"
          style={{ backgroundColor: coCreatorPrimary, boxShadow: `0 0 0 2px ${coCreatorSecondary}` }}
          title={coCreator.name}
        >
          {coCreator.avatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={coCreator.avatar}
              alt={coCreator.name}
              width={32}
              height={32}
              className="object-cover w-full h-full"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
              }}
            />
          ) : (
            'ME'
          )}
        </button>
        <div className="max-w-[75%]">
          <div className="flex justify-start items-center gap-2 mb-1">
            {isWhisper && (
              <span
                className={`text-xs px-1.5 py-0.5 rounded ${isRevealed ? 'bg-cafe-surface-elevated text-cafe-secondary' : 'bg-conn-amber-bg text-conn-amber-text'}`}
              >
                {isRevealed ? '已揭秘' : `悄悄话 → ${message.whisperTo?.join(', ') ?? ''}`}
              </span>
            )}
            {message.replyTo && message.replyPreview && !isSchedulerReply && (
              <ReplyPill replyPreview={message.replyPreview} replyToId={message.replyTo} getCatById={getCatById} />
            )}
            <span className="text-xs text-cafe-muted">{formatDualTime(message.timestamp, message.deliveredAt)}</span>
            {message.editedAt && <span className="text-xs text-cafe-muted">（已编辑）</span>}
            <span className="text-xs font-semibold" style={{ color: coCreatorPrimary }}>
              {coCreator.name}
            </span>
          </div>
          <div
            className={
              isWhisper && !isRevealed
                ? 'rounded-2xl rounded-br-sm border border-dashed border-conn-amber-text/30 bg-conn-amber-bg px-4 py-3 text-conn-amber-text transition-transform hover:-translate-y-0.5'
                : ''
            }
          >
            {isEditing ? (
              <div className="space-y-2">
                <textarea
                  value={editDraft}
                  onChange={(event) => onChangeEditDraft?.(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      onCancelEdit?.();
                    }
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      onSaveEdit?.();
                    }
                  }}
                  autoFocus
                  disabled={isSavingEdit}
                  className="min-h-[88px] w-full resize-y rounded-lg border border-[var(--slock-border-color)] bg-[var(--cafe-surface-elevated)] px-3 py-2 text-sm text-cafe outline-none transition-colors focus:border-[var(--cafe-accent)]"
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={onCancelEdit}
                    disabled={isSavingEdit}
                    className="rounded-md px-2 py-1 text-xs text-cafe-muted transition-colors hover:bg-cafe-surface-elevated hover:text-cafe disabled:opacity-50"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={onSaveEdit}
                    disabled={isSavingEdit || !editDraft.trim()}
                    className="rounded-md bg-[var(--cafe-accent)] px-2 py-1 text-xs font-semibold text-[var(--cafe-accent-foreground)] transition-opacity disabled:opacity-50"
                  >
                    {isSavingEdit ? '保存中...' : '保存'}
                  </button>
                </div>
              </div>
            ) : hasBlocks ? (
              <ContentBlocks blocks={message.contentBlocks!} />
            ) : (
              <CollapsibleMarkdown content={message.content} />
            )}
          </div>
          {taskEntry && <MessageTaskBadge task={taskEntry.task} seq={taskEntry.seq} />}
          {threadReplyInfo && threadReplyInfo.replyCount > 0 && onOpenThread && (
            <ThreadReplyBadge count={threadReplyInfo.replyCount} onOpen={() => onOpenThread(message.id)} />
          )}
        </div>
      </div>
    );
  }

  // Don't render completely empty non-streaming assistant messages.
  // This can happen when a cat responds with only internal tool/CLI events and no text output.
  // Slock-like mode keeps execution process out of the main chat surface.
  // Keep messages that have thinking content — they should still show as collapsible bubbles.
  if (
    !message.isStreaming &&
    !hasTextContent &&
    !hasBlocks &&
    !message.extra?.rich?.blocks?.length &&
    !message.extra?.crossPost &&
    !message.thinking
  ) {
    return null;
  }

  return (
    <div
      data-message-id={message.id}
      className={`group flex gap-2 items-start hover:bg-[rgba(255,255,255,0.03)] hover:ring-1 hover:ring-black/10 rounded-lg px-2 -mx-2 transition-colors ${isAssistantContinuation ? 'mb-1' : 'mb-4'}`}
    >
      {catData && !isAssistantContinuation && (
        <button
          type="button"
          onClick={() => useChatStore.getState().openMemberEditor(message.catId!)}
          className="cursor-pointer flex-shrink-0"
          title={`查看${formatCatName(catData)}详情`}
        >
          <CatAvatar catId={message.catId!} size={32} status={message.isStreaming ? 'streaming' : undefined} />
        </button>
      )}
      {catData && isAssistantContinuation && <div className="w-8 flex-shrink-0" aria-hidden="true" />}
      <div className="max-w-[85%] md:max-w-[720px] min-w-0">
        {catStyle && !isAssistantContinuation && (
          <div className="mb-1 flex flex-col gap-1 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-xs font-semibold" style={{ color: catStyle.color }}>
                {catStyle.label}
              </span>
              <span className="text-xs text-cafe-muted">{formatTime(message.timestamp)}</span>
              {message.editedAt && <span className="text-xs text-cafe-muted">（已编辑）</span>}
              {isWhisper && (
                <span
                  className={`text-xs px-1.5 py-0.5 rounded ${isRevealed ? 'bg-cafe-surface-elevated text-cafe-secondary' : 'bg-conn-amber-bg text-conn-amber-text'}`}
                >
                  {isRevealed
                    ? '已揭秘'
                    : `悄悄话 → ${
                        message.whisperTo
                          ?.map((id) => {
                            const cat = getCatById(id);
                            return cat ? cat.displayName : id;
                          })
                          .join(', ') ?? ''
                      }`}
                </span>
              )}
              {!isWhisper && direction && <DirectionPill direction={direction} getCatById={getCatById} />}
              {message.replyTo && message.replyPreview && !isSchedulerReply && (
                <ReplyPill replyPreview={message.replyPreview} replyToId={message.replyTo} getCatById={getCatById} />
              )}
            </div>
            {showSchedulerAccent && (
              <div className={SCHEDULER_ACCENT_BADGE_CLASS}>
                <span aria-hidden>⏰</span>
                <span>定时提醒</span>
              </div>
            )}
            {message.extra?.crossPost &&
              (() => {
                const sourceId = message.extra.crossPost?.sourceThreadId;
                const sourceName = threads.find((t) => t.id === sourceId)?.title ?? '未命名对话';
                const shortId = sourceId.replace(/^thread_/, '').slice(0, 8);
                const senderLabel = catStyle?.label;
                return (
                  <a
                    href={getThreadHref(sourceId)}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      pushThreadRouteWithHistory(sourceId, typeof window !== 'undefined' ? window : undefined);
                    }}
                    className="inline-flex items-center gap-1.5 border px-3 py-1 rounded-full bg-[var(--console-card-soft-bg)] border-[var(--console-border-soft)] text-cafe-secondary hover:bg-[var(--console-hover-bg)] transition-colors cursor-pointer w-fit max-w-full"
                    title={sourceId}
                    aria-label={`跳转到来源 thread ${sourceId}`}
                  >
                    <span className="text-[10px] font-semibold" aria-hidden>
                      📮
                    </span>
                    <span className="min-w-0 truncate">
                      {senderLabel && <span className="font-medium">{senderLabel} · </span>}
                      {shortId} · {sourceName}
                    </span>
                  </a>
                );
              })()}
          </div>
        )}
        <div
          className={`overflow-visible ${
            catStyle ? (catStyle.font ?? '') : ''
          } ${showSchedulerAccent ? SCHEDULER_ACCENT_BUBBLE_CLASS : ''}`}
        >
          {hasBlocks ? (
            <ContentBlocks blocks={message.contentBlocks!} />
          ) : hasTextContent ? (
            <CollapsibleMarkdown content={visibleContent} className={catStyle?.font} />
          ) : message.isStreaming ? (
            <span className="text-xs text-cafe-secondary">Thinking...</span>
          ) : null}
          {message.thinking && (
            <ThinkingContent
              content={message.thinking}
              className={catStyle?.font}
              label="Thinking"
              defaultExpanded={
                bubbleRestorePending
                  ? false
                  : resolveBubbleExpanded(currentThread?.bubbleThinking, globalBubbleDefaults.thinking)
              }
              expandInExport={false}
              breedColor={catData?.color.primary}
            />
          )}
          {message.extra?.rich?.blocks && message.extra.rich.blocks.length > 0 && (
            <RichBlocks
              blocks={message.extra.rich.blocks}
              catId={message.catId}
              messageId={message.id}
              messageSource={message.source}
            />
          )}
          {message.isStreaming && (
            <span className="inline-block w-1.5 h-4 bg-current animate-pulse ml-0.5 rounded-full opacity-50" />
          )}
        </div>
        {taskEntry && <MessageTaskBadge task={taskEntry.task} seq={taskEntry.seq} />}
        {threadReplyInfo && threadReplyInfo.replyCount > 0 && onOpenThread && (
          <ThreadReplyBadge count={threadReplyInfo.replyCount} onOpen={() => onOpenThread(message.id)} />
        )}
      </div>
    </div>
  );
}
