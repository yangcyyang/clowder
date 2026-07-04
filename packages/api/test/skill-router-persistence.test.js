import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function createMockService(catId, text) {
  return {
    async *invoke() {
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createMockDeps(services) {
  let invocationSeq = 0;
  let messageSeq = 0;
  const storedById = new Map();

  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++invocationSeq}`, callbackToken: `tok-${invocationSeq}` }),
        verify: () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => null,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (msg) => {
        const stored = {
          id: `msg-${++messageSeq}`,
          ...msg,
          threadId: msg.threadId ?? 'default',
        };
        storedById.set(stored.id, stored);
        return stored;
      },
      getById: async (id) => storedById.get(id) ?? null,
      getByThreadAfter: () => [],
      getRecent: () => [],
      getMentionsFor: () => [],
      getRecentMentionsFor: () => [],
    },
    socketManager: {
      broadcastToRoom: () => {},
    },
    draftStore: {
      delete: () => Promise.resolve(),
      touch: () => Promise.resolve(),
      upsert: () => Promise.resolve(),
    },
    voiceMode: false,
  };
}

describe('A4 SkillRouter match persistence', () => {
  it('flag helper defaults off and accepts enabled values', async () => {
    const { isSkillRouterMatchPersistenceEnabled } = await import(
      '../dist/domains/cats/services/agents/routing/route-helpers.js'
    );

    const previous = process.env.CAT_CAFE_PERSIST_SKILL_ROUTER_MATCHES;
    try {
      delete process.env.CAT_CAFE_PERSIST_SKILL_ROUTER_MATCHES;
      assert.equal(isSkillRouterMatchPersistenceEnabled(), false);

      process.env.CAT_CAFE_PERSIST_SKILL_ROUTER_MATCHES = '1';
      assert.equal(isSkillRouterMatchPersistenceEnabled(), true);

      process.env.CAT_CAFE_PERSIST_SKILL_ROUTER_MATCHES = 'on';
      assert.equal(isSkillRouterMatchPersistenceEnabled(), true);
    } finally {
      if (previous === undefined) delete process.env.CAT_CAFE_PERSIST_SKILL_ROUTER_MATCHES;
      else process.env.CAT_CAFE_PERSIST_SKILL_ROUTER_MATCHES = previous;
    }
  });

  it('routeSerial persists actual SkillRouter matches through the route hook', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const calls = [];
    const deps = createMockDeps({ opus: createMockService('opus', 'done') });

    for await (const _msg of routeSerial(deps, ['opus'], '页面报错了，请排查根因并修复', 'user1', 'thread1', {
      parentInvocationId: 'parent-inv-serial',
      persistSkillRouterMatches: (input) => calls.push(input),
    })) {
      // consume stream
    }

    assert.equal(calls.length, 1);
    assert.equal(calls[0].parentInvocationId, 'parent-inv-serial');
    assert.equal(calls[0].source, 'route-serial');
    assert.deepEqual(calls[0].matchedSkillNames, ['debugging']);
  });

  it('routeParallel persists actual SkillRouter matches through the route hook', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const calls = [];
    const deps = createMockDeps({ opus: createMockService('opus', 'done') });

    for await (const _msg of routeParallel(deps, ['opus'], '页面报错了，请排查根因并修复', 'user1', 'thread1', {
      parentInvocationId: 'parent-inv-parallel',
      persistSkillRouterMatches: (input) => calls.push(input),
    })) {
      // consume stream
    }

    assert.equal(calls.length, 1);
    assert.equal(calls[0].parentInvocationId, 'parent-inv-parallel');
    assert.equal(calls[0].source, 'route-parallel');
    assert.deepEqual(calls[0].matchedSkillNames, ['debugging']);
  });

  it('does not persist when SkillRouter has no concrete skill match', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const calls = [];
    const deps = createMockDeps({ opus: createMockService('opus', 'done') });

    for await (const _msg of routeParallel(
      deps,
      ['opus'],
      '实现一个从未沉淀过的水晶球排班玩法',
      'user1',
      'thread1',
      {
        parentInvocationId: 'parent-inv-no-match',
        persistSkillRouterMatches: (input) => calls.push(input),
      },
    )) {
      // consume stream
    }

    assert.equal(calls.length, 0);
  });
});
