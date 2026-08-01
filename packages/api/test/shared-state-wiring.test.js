// @ci-tier local-os reason="checks repository hook files and POSIX executable modes"
/**
 * Test 3: Wiring smoke test
 *
 * Asserts:
 * - .claude/settings.json SessionStart has preflight-shared-state.sh
 * - .claude/hooks/shared-doc-push-guard.sh is executable
 * - .githooks/pre-commit is executable
 * - scripts/preflight-shared-state.sh is executable
 */
import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

// Find project root (this test file is in packages/api/test/)
const projectRoot = resolve(import.meta.dirname, '..', '..', '..');
const settingsPath = resolve(projectRoot, '.claude/settings.json');
const gitHookPath = resolve(projectRoot, '.githooks/pre-commit');
const sharedDocHookPath = resolve(projectRoot, '.claude/hooks/shared-doc-push-guard.sh');
const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
const hasPrivateSharedStateWiring = Boolean(settings.hooks) || existsSync(gitHookPath) || existsSync(sharedDocHookPath);

describe('shared-state defense wiring', () => {
  it('scripts/preflight-shared-state.sh is executable', () => {
    const scriptPath = resolve(projectRoot, 'scripts/preflight-shared-state.sh');
    assert.doesNotThrow(
      () => accessSync(scriptPath, constants.X_OK),
      `scripts/preflight-shared-state.sh should be executable`,
    );
  });

  it(
    '.claude/settings.json SessionStart hooks include preflight-shared-state.sh',
    {
      skip: !hasPrivateSharedStateWiring && 'private shared-state hooks are not shipped in the open-source profile',
    },
    () => {
      const sessionStartHooks = settings.hooks?.SessionStart;
      assert.ok(Array.isArray(sessionStartHooks), 'SessionStart hooks should be an array');

      // Find a SessionStart entry that matches new|compact|resume and runs preflight
      const preflightEntry = sessionStartHooks.find((entry) =>
        entry.hooks?.some((h) => h.command?.includes('preflight-shared-state.sh')),
      );
      assert.ok(preflightEntry, 'SessionStart should include preflight-shared-state.sh');
      assert.ok(preflightEntry.matcher.includes('new'), 'preflight should run on new sessions');
    },
  );

  it(
    '.claude/settings.json PostToolUse hooks include shared-doc-push-guard.sh',
    {
      skip: !hasPrivateSharedStateWiring && 'private shared-state hooks are not shipped in the open-source profile',
    },
    () => {
      const postToolUseHooks = settings.hooks?.PostToolUse;
      assert.ok(Array.isArray(postToolUseHooks), 'PostToolUse hooks should be an array');

      const editWriteEntry = postToolUseHooks.find(
        (entry) =>
          entry.matcher === 'Edit|Write' && entry.hooks?.some((h) => h.command?.includes('shared-doc-push-guard.sh')),
      );
      assert.ok(editWriteEntry, 'PostToolUse Edit|Write should include shared-doc-push-guard.sh');
    },
  );

  it(
    '.githooks/pre-commit is executable',
    {
      skip: !hasPrivateSharedStateWiring && 'private shared-state hooks are not shipped in the open-source profile',
    },
    () => {
      assert.doesNotThrow(() => accessSync(gitHookPath, constants.X_OK), `.githooks/pre-commit should be executable`);
    },
  );

  // 砚砚 钉子 4: also verify Claude hook is executable
  it(
    '.claude/hooks/shared-doc-push-guard.sh is executable',
    {
      skip: !hasPrivateSharedStateWiring && 'private shared-state hooks are not shipped in the open-source profile',
    },
    () => {
      assert.doesNotThrow(
        () => accessSync(sharedDocHookPath, constants.X_OK),
        `.claude/hooks/shared-doc-push-guard.sh should be executable`,
      );
    },
  );
});
