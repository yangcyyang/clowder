import assert from 'node:assert/strict';
import { test } from 'node:test';

test('Redis extra parser preserves Agent progress metadata', async () => {
  const { safeParseExtra, serializeExtra } = await import(
    '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
  );
  const extra = {
    agentCommunication: { kind: 'heartbeat', invocationId: 'inv-progress' },
  };

  const serialized = serializeExtra(extra);
  const parsed = safeParseExtra(serialized);
  assert.deepEqual(parsed, extra);
});
