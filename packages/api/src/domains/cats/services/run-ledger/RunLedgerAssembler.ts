import type { CatId, TaskEvent, TaskItem } from '@cat-cafe/shared';
import type { TokenUsage } from '../types.js';
import type {
  IInvocationRecordStore,
  InvocationPhase,
  InvocationRecord,
  InvocationStatus,
} from '../stores/ports/InvocationRecordStore.js';
import type { IMessageStore, StoredMessage, StoredToolEvent } from '../stores/ports/MessageStore.js';
import type { ITaskStore } from '../stores/ports/TaskStore.js';

type TaskFailureClass = NonNullable<TaskItem['failureClass']>;

export type RunLedgerEventType =
  | 'created'
  | 'running'
  | 'queued'
  | 'context_started'
  | 'context_ready'
  | 'runtime_starting'
  | 'runtime_ready'
  | 'first_token'
  | 'tool_started'
  | 'tool_completed'
  | 'tool_failed'
  | 'tool_usage'
  | 'artifact_delta'
  | 'usage_recorded'
  | 'message_persisted'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'recovered'
  | 'task_event';

export interface RunLedgerEvent {
  id: string;
  invocationId: string;
  ts: number;
  seq: number;
  type: RunLedgerEventType;
  actor: 'system' | 'user' | string;
  severity: 'info' | 'warning' | 'error';
  data: Record<string, unknown>;
}

export interface RunLedgerUsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
  costUsd?: number;
  durationMs?: number;
}

export interface RunLedgerSummary {
  invocationId: string;
  threadId: string;
  userMessageId: string | null;
  assistantMessageId?: string;
  taskId?: string;
  targetCats: CatId[];
  status: InvocationStatus;
  phase: InvocationPhase;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  failureClass?: TaskFailureClass | 'process_restart' | 'runtime_hung';
  errorSummary?: string;
  usage?: RunLedgerUsageSummary;
  artifactCount?: number;
  toolCallCount?: number;
  traceId?: string;
}

export interface RunLedgerResponse {
  summary: RunLedgerSummary;
  events: RunLedgerEvent[];
  sources: {
    invocationRecord: boolean;
    messages: number;
    taskEvents: number;
    trace: boolean;
  };
  degraded?: {
    reason: string;
    missingSources: string[];
  };
}

export interface RunLedgerAssemblerDeps {
  invocationRecordStore: Pick<IInvocationRecordStore, 'get'>;
  messageStore: Pick<IMessageStore, 'getById' | 'getByThread'>;
  taskStore?: Pick<ITaskStore, 'listByThread' | 'listByKind'>;
}

interface DraftRunLedgerEvent {
  ts: number;
  type: RunLedgerEventType;
  actor: 'system' | 'user' | string;
  severity: 'info' | 'warning' | 'error';
  data: Record<string, unknown>;
}

interface MatchedTaskEvent {
  task: TaskItem;
  event: TaskEvent;
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi,
  /\b[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)\b\s*[:=]\s*[^\s,;]+/gi,
  /\bAuthorization\b\s*:\s*[^\n,;]+/gi,
];

function redactString(value: string): string {
  return SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern, '[redacted-secret]'), value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function parseTaskEventTime(ts: string, fallback: number): number {
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function eventHasInvocationPointer(event: TaskEvent): boolean {
  if (event.invocationId) return true;
  return isRecord(event.data) && typeof event.data.invocationId === 'string';
}

function taskEventMatchesInvocation(task: TaskItem, event: TaskEvent, record: InvocationRecord): boolean {
  if (event.invocationId === record.id) return true;
  if (isRecord(event.data)) {
    if (event.data.invocationId === record.id) return true;
    if (record.userMessageId && event.data.sourceMessageId === record.userMessageId) return true;
  }
  if (eventHasInvocationPointer(event)) return false;
  return Boolean(record.userMessageId && task.sourceMessageId === record.userMessageId);
}

function addUsage(summary: RunLedgerUsageSummary, usage: TokenUsage | Record<string, unknown> | undefined): void {
  if (!usage) return;
  const inputTokens = finiteNumber(usage.inputTokens);
  const outputTokens = finiteNumber(usage.outputTokens);
  const cacheReadTokens = finiteNumber(usage.cacheReadTokens);
  const usageRecord = usage as Record<string, unknown>;
  const cacheCreateTokens = finiteNumber(usageRecord.cacheCreationTokens ?? usageRecord.cacheCreateTokens);
  const costUsd = finiteNumber(usage.costUsd);
  const durationMs = finiteNumber(usage.durationMs);

  if (inputTokens != null) summary.inputTokens = (summary.inputTokens ?? 0) + inputTokens;
  if (outputTokens != null) summary.outputTokens = (summary.outputTokens ?? 0) + outputTokens;
  if (cacheReadTokens != null) summary.cacheReadTokens = (summary.cacheReadTokens ?? 0) + cacheReadTokens;
  if (cacheCreateTokens != null) summary.cacheCreateTokens = (summary.cacheCreateTokens ?? 0) + cacheCreateTokens;
  if (costUsd != null) summary.costUsd = (summary.costUsd ?? 0) + costUsd;
  if (durationMs != null) summary.durationMs = (summary.durationMs ?? 0) + durationMs;
}

function usageHasValues(summary: RunLedgerUsageSummary): boolean {
  return Object.values(summary).some((value) => typeof value === 'number' && Number.isFinite(value));
}

function sanitizeFileEntry(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const path = typeof value.path === 'string' ? redactString(value.path) : undefined;
  return compactRecord({
    path,
    added: finiteNumber(value.added),
    removed: finiteNumber(value.removed),
  });
}

function sanitizeTaskEventData(event: TaskEvent): Record<string, unknown> {
  const data = isRecord(event.data) ? event.data : {};
  if (event.type === 'usage') {
    return compactRecord({
      provider: typeof data.provider === 'string' ? redactString(data.provider) : undefined,
      model: typeof data.model === 'string' ? redactString(data.model) : undefined,
      inputTokens: finiteNumber(data.inputTokens),
      outputTokens: finiteNumber(data.outputTokens),
      totalTokens: finiteNumber(data.totalTokens),
      cacheReadTokens: finiteNumber(data.cacheReadTokens),
      cacheCreationTokens: finiteNumber(data.cacheCreationTokens),
      costUsd: finiteNumber(data.costUsd),
      durationMs: finiteNumber(data.durationMs),
      durationApiMs: finiteNumber(data.durationApiMs),
      historyMode: data.historyMode === 'observe' ? 'observe' : undefined,
      historyFullTokens: finiteNumber(data.historyFullTokens),
      historyBudgetRatio: finiteNumber(data.historyBudgetRatio),
      historyGovernanceDegraded:
        typeof data.historyGovernanceDegraded === 'boolean' ? data.historyGovernanceDegraded : undefined,
    });
  }
  if (event.type === 'artifact') {
    const files = Array.isArray(data.files) ? data.files.map(sanitizeFileEntry).filter(Boolean) : undefined;
    return compactRecord({
      files,
      totalAdded: finiteNumber(data.totalAdded),
      totalRemoved: finiteNumber(data.totalRemoved),
    });
  }
  if (event.type === 'tool_usage') {
    return compactRecord({
      provider: typeof data.provider === 'string' ? redactString(data.provider) : undefined,
      serverId: typeof data.serverId === 'string' ? redactString(data.serverId) : undefined,
      toolName: typeof data.toolName === 'string' ? redactString(data.toolName) : undefined,
      toolId: typeof data.toolId === 'string' ? redactString(data.toolId) : undefined,
      status: typeof data.status === 'string' ? redactString(data.status) : undefined,
      title: typeof data.title === 'string' ? redactString(data.title) : undefined,
      target: typeof data.target === 'string' ? redactString(data.target) : undefined,
      toolInput: typeof data.toolInput === 'string' ? redactString(data.toolInput) : undefined,
      durationMs: finiteNumber(data.durationMs),
    });
  }
  if (event.type === 'failed') {
    return compactRecord({
      failureClass: typeof data.failureClass === 'string' ? redactString(data.failureClass) : undefined,
      failureReason: typeof data.failureReason === 'string' ? redactString(data.failureReason) : undefined,
    });
  }
  if (event.type === 'handoff') {
    return compactRecord({
      fromCatId: typeof data.fromCatId === 'string' ? redactString(data.fromCatId) : undefined,
      toCatId: typeof data.toCatId === 'string' ? redactString(data.toCatId) : undefined,
      triggerMessageId: typeof data.triggerMessageId === 'string' ? redactString(data.triggerMessageId) : undefined,
      queueEntryId: typeof data.queueEntryId === 'string' ? redactString(data.queueEntryId) : undefined,
    });
  }
  if (event.type.startsWith('fast_lane_')) {
    return compactRecord({
      workflowId: typeof data.workflowId === 'string' ? redactString(data.workflowId) : undefined,
      workflowVersion: typeof data.workflowVersion === 'string' ? redactString(data.workflowVersion) : undefined,
      durationMs: finiteNumber(data.durationMs),
      fallbackReason: typeof data.fallbackReason === 'string' ? redactString(data.fallbackReason) : undefined,
      exitCode: finiteNumber(data.exitCode),
      signal: typeof data.signal === 'string' ? redactString(data.signal) : undefined,
      artifactCount: finiteNumber(data.artifactCount),
      routeExecutionBypassed:
        typeof data.routeExecutionBypassed === 'boolean' ? data.routeExecutionBypassed : undefined,
    });
  }
  return compactRecord({
    from: typeof data.from === 'string' ? redactString(data.from) : undefined,
    to: typeof data.to === 'string' ? redactString(data.to) : undefined,
  });
}

function mapTaskEventType(type: TaskEvent['type']): RunLedgerEventType {
  if (type === 'usage') return 'usage_recorded';
  if (type === 'artifact') return 'artifact_delta';
  if (type === 'tool_usage') return 'tool_usage';
  if (type === 'handoff') return 'recovered';
  if (type === 'failed' || type === 'fast_lane_failed') return 'failed';
  return 'task_event';
}

function mapToolEventType(event: StoredToolEvent): RunLedgerEventType {
  if (event.type === 'tool_use') return 'tool_started';
  return 'tool_completed';
}

function getMessageRole(message: StoredMessage): 'user' | 'assistant' {
  return message.catId ? 'assistant' : 'user';
}

function getMessageTraceId(message: StoredMessage): string | undefined {
  return message.extra?.tracing?.traceId;
}

function createMessageEvent(invocationId: string, message: StoredMessage): DraftRunLedgerEvent {
  return {
    ts: message.timestamp,
    type: 'message_persisted',
    actor: message.catId ?? 'user',
    severity: 'info',
    data: compactRecord({
      messageId: message.id,
      role: getMessageRole(message),
      catId: message.catId ?? undefined,
      toolEventCount: message.toolEvents?.length ?? 0,
      traceId: getMessageTraceId(message),
      invocationId,
    }),
  };
}

function createToolEvents(message: StoredMessage): DraftRunLedgerEvent[] {
  return (message.toolEvents ?? []).map((event) => ({
    ts: event.timestamp,
    type: mapToolEventType(event),
    actor: message.catId ?? 'system',
    severity: 'info' as const,
    data: compactRecord({
      messageId: message.id,
      toolEventId: event.id,
      toolEventType: event.type,
      label: redactString(event.label),
    }),
  }));
}

function terminalEventType(status: InvocationStatus): RunLedgerEventType | null {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'failed') return 'failed';
  if (status === 'canceled') return 'canceled';
  return null;
}

function getTaskFailureClass(matches: readonly MatchedTaskEvent[]): TaskFailureClass | undefined {
  for (const { task, event } of matches) {
    if (task.failureClass) return task.failureClass;
    if (event.type === 'failed' && isRecord(event.data) && typeof event.data.failureClass === 'string') {
      return event.data.failureClass as TaskFailureClass;
    }
  }
  return undefined;
}

function getAssistantMessages(messages: readonly StoredMessage[], invocationId: string): StoredMessage[] {
  return messages.filter((message) => message.extra?.stream?.invocationId === invocationId);
}

const EVENT_TYPE_ORDER: Partial<Record<RunLedgerEventType, number>> = {
  created: 0,
  queued: 1,
  running: 2,
  context_started: 3,
  context_ready: 4,
  runtime_starting: 5,
  runtime_ready: 6,
  first_token: 7,
  tool_started: 8,
  tool_completed: 9,
  tool_failed: 10,
  tool_usage: 11,
  usage_recorded: 12,
  artifact_delta: 13,
  message_persisted: 14,
  task_event: 15,
  recovered: 16,
  succeeded: 17,
  failed: 17,
  canceled: 17,
};

export class RunLedgerAssembler {
  constructor(private readonly deps: RunLedgerAssemblerDeps) {}

  async assemble(invocationId: string): Promise<RunLedgerResponse | null> {
    const record = await this.deps.invocationRecordStore.get(invocationId);
    if (!record) return null;

    const threadMessages = await this.deps.messageStore.getByThread(record.threadId, 10000, record.userId);
    const userMessage = record.userMessageId ? await this.deps.messageStore.getById(record.userMessageId) : null;
    const assistantMessages = getAssistantMessages(threadMessages, invocationId);
    const relatedMessages = [
      ...(userMessage ? [userMessage] : []),
      ...assistantMessages.filter((message) => message.id !== userMessage?.id),
    ].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));

    const taskEvents = await this.collectTaskEvents(record);
    const traceId = relatedMessages.map(getMessageTraceId).find((value): value is string => Boolean(value));
    const usage = this.summarizeUsage(record, taskEvents);
    const artifactCount = taskEvents.filter(({ event }) => event.type === 'artifact').length;
    const toolCallCount = assistantMessages.reduce((count, message) => count + (message.toolEvents?.length ?? 0), 0);
    const terminalType = terminalEventType(record.status);
    const taskFailureClass = getTaskFailureClass(taskEvents);

    const events: DraftRunLedgerEvent[] = [
      {
        ts: record.createdAt,
        type: 'created',
        actor: 'system',
        severity: 'info',
        data: { status: 'queued', phase: 'queued' },
      },
    ];

    if (record.status !== 'queued' || record.phase !== 'queued') {
      events.push({
        ts: this.estimateRunningTimestamp(record, assistantMessages, taskEvents),
        type: 'running',
        actor: 'system',
        severity: 'info',
        data: { status: 'running', phase: record.phase },
      });
    }

    for (const message of assistantMessages) {
      events.push(...createToolEvents(message));
      events.push(createMessageEvent(invocationId, message));
    }

    for (const match of taskEvents) {
      events.push(this.createTaskEvent(record, match));
    }

    if (terminalType) {
      events.push({
        ts: record.updatedAt,
        type: terminalType,
        actor: 'system',
        severity: terminalType === 'failed' ? 'error' : 'info',
        data: compactRecord({
          status: record.status,
          phase: record.phase,
          failureClass: taskFailureClass,
          errorSummary: record.error ? redactString(record.error) : undefined,
        }),
      });
    }

    const missingSources = this.computeMissingSources({
      relatedMessages,
      traceId,
    });
    const firstTask = taskEvents[0]?.task;
    const endedAt = terminalType ? record.updatedAt : undefined;
    const summary: RunLedgerSummary = {
      invocationId: record.id,
      threadId: record.threadId,
      userMessageId: record.userMessageId,
      targetCats: record.targetCats,
      status: record.status,
      phase: record.phase,
      startedAt: record.createdAt,
      artifactCount,
      toolCallCount,
      ...(assistantMessages[assistantMessages.length - 1]?.id
        ? { assistantMessageId: assistantMessages[assistantMessages.length - 1]!.id }
        : {}),
      ...(firstTask?.id ? { taskId: firstTask.id } : {}),
      ...(endedAt != null ? { endedAt, durationMs: Math.max(0, endedAt - record.createdAt) } : {}),
      ...(taskFailureClass ? { failureClass: taskFailureClass } : {}),
      ...(record.error ? { errorSummary: redactString(record.error) } : {}),
      ...(usageHasValues(usage) ? { usage } : {}),
      ...(traceId ? { traceId } : {}),
    };

    const response: RunLedgerResponse = {
      summary,
      events: this.finalizeEvents(invocationId, events),
      sources: {
        invocationRecord: true,
        messages: relatedMessages.length,
        taskEvents: taskEvents.length,
        trace: Boolean(traceId),
      },
    };
    if (missingSources.length > 0) {
      response.degraded = {
        reason: `Missing optional run ledger source(s): ${missingSources.join(', ')}`,
        missingSources,
      };
    }
    return response;
  }

  private async collectTaskEvents(record: InvocationRecord): Promise<MatchedTaskEvent[]> {
    const taskStore = this.deps.taskStore;
    if (!taskStore) return [];
    const scopedTasks = await taskStore.listByThread(record.threadId);
    const extraTasks =
      typeof taskStore.listByKind === 'function'
        ? (await taskStore.listByKind('work')).filter((task) => task.taskThreadId === record.threadId)
        : [];
    const tasks = [...scopedTasks, ...extraTasks.filter((task) => !scopedTasks.some((item) => item.id === task.id))];
    const matches: MatchedTaskEvent[] = [];
    for (const task of tasks) {
      for (const event of task.events ?? []) {
        if (taskEventMatchesInvocation(task, event, record)) {
          matches.push({ task, event });
        }
      }
    }
    matches.sort(
      (a, b) =>
        parseTaskEventTime(a.event.ts, a.task.updatedAt) - parseTaskEventTime(b.event.ts, b.task.updatedAt) ||
        a.task.id.localeCompare(b.task.id),
    );
    return matches;
  }

  private summarizeUsage(record: InvocationRecord, taskEvents: readonly MatchedTaskEvent[]): RunLedgerUsageSummary {
    const summary: RunLedgerUsageSummary = {};
    for (const usage of Object.values(record.usageByCat ?? {})) {
      addUsage(summary, usage);
    }
    if (usageHasValues(summary)) return summary;
    for (const { event } of taskEvents) {
      if (event.type === 'usage' && isRecord(event.data)) {
        addUsage(summary, event.data);
      }
    }
    return summary;
  }

  private createTaskEvent(record: InvocationRecord, match: MatchedTaskEvent): DraftRunLedgerEvent {
    const { task, event } = match;
    return {
      ts: parseTaskEventTime(event.ts, task.updatedAt),
      type: mapTaskEventType(event.type),
      actor: event.catId,
      severity: event.type === 'failed' || event.type === 'fast_lane_failed' ? 'error' : 'info',
      data: compactRecord({
        invocationId: record.id,
        taskId: task.id,
        taskEventType: event.type,
        ...sanitizeTaskEventData(event),
      }),
    };
  }

  private computeMissingSources(input: {
    relatedMessages: readonly StoredMessage[];
    traceId?: string;
  }): string[] {
    const missing: string[] = [];
    if (input.relatedMessages.length === 0) missing.push('messages');
    if (!input.traceId) missing.push('trace');
    return missing;
  }

  private estimateRunningTimestamp(
    record: InvocationRecord,
    assistantMessages: readonly StoredMessage[],
    taskEvents: readonly MatchedTaskEvent[],
  ): number {
    const activityTimestamps = [
      ...assistantMessages.flatMap((message) => [
        message.timestamp,
        ...(message.toolEvents ?? []).map((event) => event.timestamp),
      ]),
      ...taskEvents.map(({ event, task }) => parseTaskEventTime(event.ts, task.updatedAt)),
    ]
      .filter((ts) => Number.isFinite(ts) && ts > record.createdAt)
      .sort((a, b) => a - b);
    const firstActivityTs = activityTimestamps[0];
    if (firstActivityTs == null) return record.createdAt;
    if (firstActivityTs - record.createdAt <= 1) return record.createdAt;
    return record.createdAt + Math.floor((firstActivityTs - record.createdAt) / 2);
  }

  private finalizeEvents(invocationId: string, draftEvents: readonly DraftRunLedgerEvent[]): RunLedgerEvent[] {
    return [...draftEvents]
      .sort(
        (a, b) =>
          a.ts - b.ts ||
          (EVENT_TYPE_ORDER[a.type] ?? Number.MAX_SAFE_INTEGER) -
            (EVENT_TYPE_ORDER[b.type] ?? Number.MAX_SAFE_INTEGER) ||
          a.type.localeCompare(b.type),
      )
      .map((event, index) => ({
        id: `${invocationId}:${index + 1}:${event.type}`,
        invocationId,
        seq: index + 1,
        ...event,
      }));
  }
}
