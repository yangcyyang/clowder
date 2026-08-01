import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';

describe('TaskRunnerV2 bootstrap integration', () => {
  let db;

  beforeEach(async () => {
    db = new Database(':memory:');
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    applyMigrations(db);
  });

  async function createSummarySpec() {
    const { createSummaryCompactionTaskSpec } = await import('../../dist/domains/memory/SummaryCompactionTaskSpec.js');
    return createSummaryCompactionTaskSpec({
      db,
      enabled: () => true,
      getThreadLastActivity: async () => null,
      getMessagesAfterWatermark: async () => ({
        messages: [],
        scannedThroughMessageId: null,
        excludedPrivateCount: 0,
      }),
      generateAbstractive: async () => null,
      logger: { info: () => {}, error: () => {} },
    });
  }

  it('registers the shipped summary TaskSpec and lists it', async () => {
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    const { RunLedger } = await import('../../dist/infrastructure/scheduler/RunLedger.js');

    const ledger = new RunLedger(db);
    const runner = new TaskRunnerV2({
      logger: { info: () => {}, error: () => {} },
      ledger,
    });

    runner.register(await createSummarySpec());

    const ids = runner.getRegisteredTasks();
    assert.deepEqual(ids, ['summary-compact']);
  });

  it('rejects duplicate task id', async () => {
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    const { RunLedger } = await import('../../dist/infrastructure/scheduler/RunLedger.js');

    const ledger = new RunLedger(db);
    const runner = new TaskRunnerV2({
      logger: { info: () => {}, error: () => {} },
      ledger,
    });

    const spec = await createSummarySpec();

    runner.register(spec);
    assert.throws(() => runner.register(spec), /duplicate task id/);
  });
});
