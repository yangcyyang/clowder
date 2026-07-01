const nodeBin = '/Users/cy/.uclaw/node/bin';
const pnpmBin = '/Users/cy/.npm-global/bin/pnpm';
const stablePath = `${nodeBin}:/Users/cy/.npm-global/bin:${process.env.PATH ?? ''}`;

const stableEnv = {
  NODE: `${nodeBin}/node`,
  PATH: stablePath,
};

module.exports = {
  apps: [
    {
      name: 'clowder-api',
      cwd: `${__dirname}/packages/api`,
      script: pnpmBin,
      args: 'run dev',
      interpreter: `${nodeBin}/node`,
      env: stableEnv,
      watch: false,
    },
    {
      name: 'clowder-web',
      cwd: `${__dirname}/packages/web`,
      script: pnpmBin,
      args: 'exec next start -p 3003 -H 0.0.0.0',
      interpreter: `${nodeBin}/node`,
      env: stableEnv,
      watch: false,
    },
  ],
};
