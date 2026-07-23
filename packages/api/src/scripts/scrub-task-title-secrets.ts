/**
 * B4 deploy-window helper: scrub secret-shaped substrings from task titles
 * via TaskStore.update (store API) — never raw redis hset.
 *
 * Usage (from packages/api after build):
 *   node dist/scripts/scrub-task-title-secrets.js            # dry-run (default)
 *   node dist/scripts/scrub-task-title-secrets.js --apply     # write updates
 *   REDIS_URL=redis://... node dist/scripts/scrub-task-title-secrets.js --apply
 *
 * Safe to re-run: already-redacted titles are no-ops.
 */
import { createRedisClient } from '@cat-cafe/shared/utils';
import { createTaskStore } from '../domains/cats/services/stores/factories/TaskStoreFactory.js';
import { redactSecretsInText, textContainsSecretValue } from '../utils/env-var-secret-guard.js';

const APPLY = process.argv.includes('--apply');
const KINDS = ['work', 'pr_tracking'] as const;

async function main(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  const redis = redisUrl ? createRedisClient({ url: redisUrl }) : createRedisClient();
  const taskStore = createTaskStore(redis);

  let scanned = 0;
  let wouldChange = 0;
  let changed = 0;
  const samples: Array<{ id: string; beforeLen: number; afterPreview: string }> = [];

  try {
    for (const kind of KINDS) {
      const tasks = await taskStore.listByKind(kind);
      for (const task of tasks) {
        scanned += 1;
        const title = task.title ?? '';
        if (!textContainsSecretValue(title)) continue;
        const next = redactSecretsInText(title);
        if (next === title) continue;
        wouldChange += 1;
        samples.push({
          id: task.id,
          beforeLen: title.length,
          // Never print pre-redaction secrets; only post-redact preview.
          afterPreview: next.length > 80 ? `${next.slice(0, 79)}…` : next,
        });
        if (APPLY) {
          const updated = await taskStore.update(task.id, { title: next });
          if (updated) changed += 1;
        }
      }
    }
  } finally {
    await redis.quit().catch(() => undefined);
  }

  console.log(
    JSON.stringify(
      {
        mode: APPLY ? 'apply' : 'dry-run',
        scanned,
        wouldChange,
        changed: APPLY ? changed : 0,
        samples: samples.slice(0, 20),
        note: APPLY
          ? 'titles updated via TaskStore.update'
          : 'dry-run only; re-run with --apply in deploy window',
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
