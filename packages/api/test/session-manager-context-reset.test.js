import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { SessionManager } = await import('../dist/domains/cats/services/session/SessionManager.js');

describe('SessionManager reset-aware pointers', () => {
  it('rejects legacy pointers after a reset epoch', async () => {
    const sessionStore = {
      async getSessionId() {
        return 'legacy-provider-session';
      },
    };
    const manager = new SessionManager(sessionStore);
    assert.equal(await manager.get('user-1', 'codex', 'thread-1'), 'legacy-provider-session');
    assert.equal(await manager.get('user-1', 'codex', 'thread-1', Date.now()), undefined);
  });

  it('persists pointer creation time so post-reset sessions can resume normally', async () => {
    let persisted;
    const sessionStore = {
      async setSessionId(_userId, _catId, _threadId, value) {
        persisted = value;
      },
      async getSessionId() {
        return persisted;
      },
    };
    const manager = new SessionManager(sessionStore);
    await manager.store('user-1', 'codex', 'thread-1', 'fresh-provider-session');
    const storedAt = Number(/^cc-session-v1:(\d+):/.exec(persisted)?.[1]);

    assert.equal(await manager.get('user-1', 'codex', 'thread-1', storedAt), 'fresh-provider-session');
    assert.equal(await manager.get('user-1', 'codex', 'thread-1', storedAt + 1), undefined);
  });
});
