const { homedir } = require('node:os');
const { join } = require('node:path');

const homeDir = homedir();
const nodeBin = process.env.CAT_CAFE_NODE_BIN || join(homeDir, '.uclaw/node/bin');
const pnpmBin = process.env.CAT_CAFE_PNPM_BIN || join(homeDir, '.npm-global/bin/pnpm');
const stableNode = process.env.CAT_CAFE_STABLE_NODE || join(nodeBin, 'node');

// Keep npm lifecycle scripts on the same Node ABI as PM2. Do not append the
// caller's PATH here: `pm2 restart --update-env` may be launched from shells
// where Homebrew Node appears before the stable runtime, which breaks native
// modules such as better-sqlite3.
const stablePath = [
  nodeBin,
  join(homeDir, '.npm-global/bin'),
  join(homeDir, 'Library/pnpm/.tools/pnpm/9.15.4/bin'),
  join(homeDir, '.local/bin'),
  join(homeDir, '.opencode/bin'),
  join(homeDir, '.mimocode/bin'),
  join(homeDir, '.bun/bin'),
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
].join(':');

const stableEnv = {
  NODE: stableNode,
  PATH: stablePath,
  npm_node_execpath: stableNode,
};

// Security-critical behavior flags (task: pm2-env persistence prep, 2026-07-21).
// These previously existed ONLY in the pm2 daemon's in-memory process env — a
// daemon/machine restart would silently reset them to code defaults, which for
// several of these (capability receipt enforcement, auto-approve) is a real
// security regression, not just a feature-flag drift. Captured from live
// `pm2 env 1` and committed here as the durable source of truth.
// NOT a secrets store: no API keys/tokens belong here (this file is git-tracked —
// see the credential-persistence follow-up flagged separately, keychain-bound).
// Applying these values does NOT change live behavior until the process actually
// restarts picking up this file — that restart is a separate, deliberately gated
// step (must happen with yangcyyang present + rollback ready).
const apiSecurityEnv = {
  // F401: capability receipt enforcement — must stay 'enforce', never fall back
  // to a permissive default (this is the exact backdoor #401 closed).
  CLOWDER_CAPABILITY_RECEIPT_MODE: 'enforce',
  CLOWDER_CAPABILITY_RECEIPT_EXECUTOR_ALLOWLIST: 'antigravity.native.run_command',
  CLOWDER_CAPABILITY_RECEIPT_CAT_ALLOWLIST: 'antigravity',
  CLOWDER_CAPABILITY_RECEIPT_THREAD_ALLOWLIST: 'thread_mrqr35sjajks9qlg',
  // Must stay 'false' — auto-approving antigravity capability requests without
  // human confirmation is exactly the risk the capability receipt gate exists to prevent.
  ANTIGRAVITY_AUTO_APPROVE: 'false',
  // 票C: memory promotion review gate mode (off|shadow|enforce).
  CAT_CAFE_MEMORY_PROMOTION_MODE: 'shadow',
  // F194: auto task+thread creation on admitted work messages (live on all channels).
  CLOWDER_AUTO_TASK_THREAD_ROUTING: 'true',
  CLOWDER_AUTO_TASK_THREAD_THREADS: 'thread_mrqr35sjajks9qlg,thread_mrrmu5i66vxj55ia',
  CLOWDER_THREAD_ADDRESS_ROUTING: 'false',
  CLOWDER_THREAD_ADDRESS_THREADS: 'thread_mrqr35sjajks9qlg',
};

module.exports = {
  apps: [
    {
      name: 'clowder-api',
      cwd: `${__dirname}/packages/api`,
      script: pnpmBin,
      args: 'run start:pm2',
      interpreter: stableNode,
      env: { ...stableEnv, ...apiSecurityEnv },
      watch: false,
    },
    {
      name: 'clowder-web',
      cwd: `${__dirname}/packages/web`,
      script: pnpmBin,
      args: 'run start:pm2',
      interpreter: stableNode,
      env: stableEnv,
      watch: false,
    },
  ],
};
