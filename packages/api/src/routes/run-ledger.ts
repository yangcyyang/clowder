import type { FastifyPluginAsync } from 'fastify';
import type { IInvocationRecordStore } from '../domains/cats/services/stores/ports/InvocationRecordStore.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import { RunLedgerAssembler } from '../domains/cats/services/run-ledger/RunLedgerAssembler.js';

export interface RunLedgerRoutesOptions {
  invocationRecordStore: IInvocationRecordStore;
  messageStore: IMessageStore;
  taskStore?: ITaskStore;
}

export const runLedgerRoutes: FastifyPluginAsync<RunLedgerRoutesOptions> = async (app, opts) => {
  const assembler = new RunLedgerAssembler({
    invocationRecordStore: opts.invocationRecordStore,
    messageStore: opts.messageStore,
    ...(opts.taskStore ? { taskStore: opts.taskStore } : {}),
  });

  app.get<{ Params: { invocationId: string } }>('/api/run-ledger/:invocationId', async (request, reply) => {
    const ledger = await assembler.assemble(request.params.invocationId);
    if (!ledger) {
      reply.status(404);
      return { error: 'Run ledger not found', code: 'RUN_LEDGER_NOT_FOUND' };
    }
    return ledger;
  });
};
