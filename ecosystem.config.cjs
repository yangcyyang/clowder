const nodeBin = '/Users/cy/.uclaw/node/bin';
const pnpmBin = '/Users/cy/.npm-global/bin/pnpm';
const stableNode = `${nodeBin}/node`;

// Keep npm lifecycle scripts on the same Node ABI as PM2. Do not append the
// caller's PATH here: `pm2 restart --update-env` may be launched from shells
// where Homebrew Node appears before the stable runtime, which breaks native
// modules such as better-sqlite3.
const stablePath = [
  nodeBin,
  '/Users/cy/.npm-global/bin',
  '/Users/cy/Library/pnpm/.tools/pnpm/9.15.4/bin',
  '/Users/cy/.local/bin',
  '/Users/cy/.opencode/bin',
  '/Users/cy/.mimocode/bin',
  '/Users/cy/.bun/bin',
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
