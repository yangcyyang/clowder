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

module.exports = {
  apps: [
    {
      name: 'clowder-api',
      cwd: `${__dirname}/packages/api`,
      script: pnpmBin,
      args: 'run start:pm2',
      interpreter: stableNode,
      env: stableEnv,
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
