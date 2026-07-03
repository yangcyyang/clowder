import type { FastifyPluginAsync } from 'fastify';
import { RunLedgerAssembler } from '../domains/cats/services/run-ledger/RunLedgerAssembler.js';
import type { IInvocationRecordStore } from '../domains/cats/services/stores/ports/InvocationRecordStore.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { LocalTraceStore } from '../infrastructure/telemetry/local-trace-store.js';

export interface RunLedgerRoutesOptions {
  invocationRecordStore: IInvocationRecordStore;
  messageStore: IMessageStore;
  taskStore?: ITaskStore;
  traceStore?: LocalTraceStore | null;
}

function parseLimit(raw: unknown, fallback: number): number {
  const value = typeof raw === 'string' ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(100, value));
}

export const runLedgerRoutes: FastifyPluginAsync<RunLedgerRoutesOptions> = async (app, opts) => {
  const assembler = new RunLedgerAssembler({
    invocationRecordStore: opts.invocationRecordStore,
    messageStore: opts.messageStore,
    taskStore: opts.taskStore,
    traceStore: opts.traceStore,
  });

  app.get<{ Querystring: { threadId?: string; limit?: string } }>('/api/run-ledger', async (request, reply) => {
    const threadId = request.query.threadId?.trim();
    if (!threadId) {
      reply.status(400);
      return { error: 'threadId is required', code: 'THREAD_ID_REQUIRED' };
    }
    if (!assembler.supportsScanAll()) {
      reply.status(501);
      return { error: 'Invocation scan is unavailable', code: 'INVOCATION_SCAN_UNAVAILABLE' };
    }

    const ledgers = await assembler.listByThread(threadId, parseLimit(request.query.limit, 20));
    return { ledgers, count: ledgers.length };
  });

  app.get<{ Params: { invocationId: string } }>('/api/run-ledger/:invocationId', async (request, reply) => {
    const invocationId = request.params.invocationId?.trim();
    if (!invocationId) {
      reply.status(400);
      return { error: 'invocationId is required', code: 'INVOCATION_ID_REQUIRED' };
    }

    const ledger = await assembler.assemble(invocationId);
    if (!ledger) {
      reply.status(404);
      return { error: 'Invocation not found', code: 'INVOCATION_NOT_FOUND' };
    }
    return ledger;
  });

  app.get<{ Params: { taskId: string }; Querystring: { limit?: string } }>(
    '/api/tasks/:taskId/run-ledgers',
    async (request, reply) => {
      if (!assembler.supportsScanAll()) {
        reply.status(501);
        return { error: 'Invocation scan is unavailable', code: 'INVOCATION_SCAN_UNAVAILABLE' };
      }

      const ledgers = await assembler.listByTask(request.params.taskId, parseLimit(request.query.limit, 20));
      if (ledgers === null) {
        reply.status(404);
        return { error: 'Task not found', code: 'TASK_NOT_FOUND' };
      }
      return { taskId: request.params.taskId, ledgers, count: ledgers.length };
    },
  );
};
