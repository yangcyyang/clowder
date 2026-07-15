const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const configPath = path.resolve(__dirname, '../next.config.js');
const packageJsonPath = path.resolve(__dirname, '../package.json');
const escapedBuildIdRoutePath = path.resolve(__dirname, '../src/app/%5Fclowder/build-id/route.ts');
const privateBuildIdRoutePath = path.resolve(__dirname, '../src/app/_clowder/build-id/route.ts');
const nextPwaPath = require.resolve('@ducanh2912/next-pwa');
const ENV_KEYS = [
  'NEXT_PUBLIC_API_URL',
  'API_SERVER_PORT',
  'FRONTEND_PORT',
  'NODE_ENV',
  'NEXT_DIST_DIR',
  'CLOWDER_API_BEARER_TOKEN',
  'CLOWDER_WEB_BUILD_ID',
];

function withEnv(overrides, run) {
  const snapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, overrides);
    delete require.cache[configPath];
    return run(require(configPath));
  } finally {
    delete require.cache[configPath];
    for (const key of ENV_KEYS) {
      const value = snapshot[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function withCapturedPwaOptions(overrides, run) {
  const previousPwaModule = require.cache[nextPwaPath];
  require.cache[nextPwaPath] = {
    id: nextPwaPath,
    filename: nextPwaPath,
    loaded: true,
    exports: {
      default: (options) => (config) => ({ ...config, __pwaOptions: options }),
    },
  };

  return Promise.resolve()
    .then(() => withEnv(overrides, run))
    .finally(() => {
      delete require.cache[configPath];
      if (previousPwaModule) {
        require.cache[nextPwaPath] = previousPwaModule;
      } else {
        delete require.cache[nextPwaPath];
      }
    });
}

describe('next.config rewrites', () => {
  it('proxies /api, /socket.io, and /uploads to default API port', async () => {
    await withEnv({}, async (config) => {
      const rewrites = await config.rewrites();
      assert.deepEqual(rewrites, [
        { source: '/api/:path*', destination: 'http://127.0.0.1:3004/api/:path*' },
        { source: '/socket.io/:path*', destination: 'http://127.0.0.1:3004/socket.io/:path*' },
        { source: '/uploads/:path*', destination: 'http://127.0.0.1:3004/uploads/:path*' },
      ]);
    });
  });

  it('respects NEXT_PUBLIC_API_URL', async () => {
    await withEnv({ NEXT_PUBLIC_API_URL: 'http://myhost:9000' }, async (config) => {
      const rewrites = await config.rewrites();
      assert.equal(rewrites[0].destination, 'http://myhost:9000/api/:path*');
      assert.equal(rewrites[1].destination, 'http://myhost:9000/socket.io/:path*');
      assert.equal(rewrites[2].destination, 'http://myhost:9000/uploads/:path*');
    });
  });

  it('respects API_SERVER_PORT', async () => {
    await withEnv({ API_SERVER_PORT: '4000' }, async (config) => {
      const rewrites = await config.rewrites();
      assert.equal(rewrites[0].destination, 'http://127.0.0.1:4000/api/:path*');
    });
  });

  it('respects FRONTEND_PORT (API = frontend + 1)', async () => {
    await withEnv({ FRONTEND_PORT: '5000' }, async (config) => {
      const rewrites = await config.rewrites();
      assert.equal(rewrites[0].destination, 'http://127.0.0.1:5001/api/:path*');
    });
  });

  it('keeps next-pwa in dependencies because next.config requires it at build time', () => {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    assert.equal(
      packageJson.dependencies?.['@ducanh2912/next-pwa'],
      '^10.2.9',
      'next.config.js requires @ducanh2912/next-pwa during next build, so it cannot live in devDependencies',
    );
    assert.equal(packageJson.devDependencies?.['@ducanh2912/next-pwa'], undefined);
  });

  it('uses an isolated distDir for local dev so next build cannot overwrite running dev assets', async () => {
    await withEnv({ NODE_ENV: 'development' }, async (config) => {
      assert.equal(config.distDir, '.next-dev');
    });
  });

  it('uses the standard .next distDir for production build output', async () => {
    await withEnv({ NODE_ENV: 'production' }, async (config) => {
      assert.equal(config.distDir, '.next');
    });
  });

  it('allows explicit distDir override for one-off diagnostics', async () => {
    await withEnv({ NODE_ENV: 'development', NEXT_DIST_DIR: '.next-debug' }, async (config) => {
      assert.equal(config.distDir, '.next-debug');
    });
  });

  it('exposes only a safe auth-proxy boolean and never the bearer token', async () => {
    await withEnv({ CLOWDER_API_BEARER_TOKEN: 'DO_NOT_BUNDLE_THIS_SENTINEL' }, async (config) => {
      assert.equal(config.env?.NEXT_PUBLIC_API_AUTH_PROXY_ENABLED, '1');
      assert.ok(!JSON.stringify(config).includes('DO_NOT_BUNDLE_THIS_SENTINEL'));
    });
    await withEnv({}, async (config) => {
      assert.equal(config.env?.NEXT_PUBLIC_API_AUTH_PROXY_ENABLED, '0');
    });
  });

  it('uses the explicit stable build id for both server and browser contracts', async () => {
    await withEnv({ NODE_ENV: 'development', CLOWDER_WEB_BUILD_ID: 'build-a' }, async (config) => {
      assert.equal(await config.generateBuildId(), 'build-a');
      assert.equal(config.env?.NEXT_PUBLIC_CLOWDER_WEB_BUILD_ID, 'build-a');
    });
  });

  it('escapes the private folder prefix so /_clowder/build-id is a public App Router route', () => {
    assert.deepEqual(
      {
        decodedRouteSegment: decodeURIComponent(path.basename(path.dirname(path.dirname(escapedBuildIdRoutePath)))),
        escapedRouteExists: fs.existsSync(escapedBuildIdRoutePath),
        privateRouteExists: fs.existsSync(privateBuildIdRoutePath),
      },
      {
        decodedRouteSegment: '_clowder',
        escapedRouteExists: true,
        privateRouteExists: false,
      },
      'Next treats app/_clowder as a private folder; app/%5Fclowder must own the public /_clowder URL',
    );
  });

  it('keeps the build-id probe NetworkOnly before generic PWA runtime caching rules', async () => {
    await withCapturedPwaOptions({ NODE_ENV: 'production' }, async (config) => {
      const runtimeCaching = config.__pwaOptions?.workboxOptions?.runtimeCaching;
      assert.ok(Array.isArray(runtimeCaching));
      assert.equal(runtimeCaching[0]?.urlPattern, '/_clowder/build-id');
      assert.equal(runtimeCaching[0]?.handler, 'NetworkOnly');
    });
  });
});
