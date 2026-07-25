/**
 * Batch 3-E: catalog-level resolution tests for permissionProfile (item 1) and
 * costBudget (item 2) — cat-config-loader.ts schema + toAllCatConfigs() resolution.
 *
 * Required per the batch brief: "映射表用例 + 缺省 trusted 现状不变用例" for
 * permissionProfile. Covers the variant/breed override precedence and the hard
 * constraint that an absent field resolves to undefined (= 'trusted' downstream),
 * not some smart default.
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');

function writeTempConfig(data) {
  const dir = mkdtempSync(join(tmpdir(), 'cat-template-permission-budget-'));
  const path = join(dir, 'cat-template.json');
  writeFileSync(path, JSON.stringify(data));
  return path;
}

/** Minimal valid single-breed/single-variant config, patchable via overrides. */
function baseConfig({ breedExtra = {}, variantExtra = {} } = {}) {
  return {
    version: 1,
    breeds: [
      {
        id: 'ragdoll',
        catId: 'opus-pb-test',
        name: '布偶猫',
        displayName: '布偶猫',
        avatar: '/avatars/opus.png',
        color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
        mentionPatterns: ['@opus-pb-test'],
        roleDescription: '主架构师',
        defaultVariantId: 'opus-default',
        ...breedExtra,
        variants: [
          {
            id: 'opus-default',
            clientId: 'anthropic',
            defaultModel: 'claude-sonnet-4-5-20250929',
            mcpSupport: true,
            cli: { command: 'claude', outputFormat: 'stream-json' },
            personality: '温柔',
            ...variantExtra,
          },
        ],
      },
    ],
  };
}

describe('permissionProfile catalog resolution', () => {
  it('HARD CONSTRAINT: field absent at both variant and breed level → resolved CatConfig has no permissionProfile (= trusted)', () => {
    const path = writeTempConfig(baseConfig());
    const config = toAllCatConfigs(loadCatConfig(path));
    assert.equal(config['opus-pb-test'].permissionProfile, undefined);
  });

  it('variant-level permissionProfile is honored', () => {
    const path = writeTempConfig(baseConfig({ variantExtra: { permissionProfile: 'strict' } }));
    const config = toAllCatConfigs(loadCatConfig(path));
    assert.equal(config['opus-pb-test'].permissionProfile, 'strict');
  });

  it('breed-level permissionProfile is honored when variant omits it', () => {
    const path = writeTempConfig(baseConfig({ breedExtra: { permissionProfile: 'standard' } }));
    const config = toAllCatConfigs(loadCatConfig(path));
    assert.equal(config['opus-pb-test'].permissionProfile, 'standard');
  });

  it('variant-level permissionProfile overrides breed-level (mapping-table precedence)', () => {
    const path = writeTempConfig(
      baseConfig({
        breedExtra: { permissionProfile: 'standard' },
        variantExtra: { permissionProfile: 'strict' },
      }),
    );
    const config = toAllCatConfigs(loadCatConfig(path));
    assert.equal(config['opus-pb-test'].permissionProfile, 'strict', 'variant must win over breed');
  });

  it('explicit trusted at variant level round-trips as trusted (not stripped to undefined)', () => {
    const path = writeTempConfig(baseConfig({ variantExtra: { permissionProfile: 'trusted' } }));
    const config = toAllCatConfigs(loadCatConfig(path));
    assert.equal(config['opus-pb-test'].permissionProfile, 'trusted');
  });

  it('rejects an invalid permissionProfile value at load time (zod enum)', () => {
    const path = writeTempConfig(baseConfig({ variantExtra: { permissionProfile: 'yolo' } }));
    assert.throws(() => loadCatConfig(path), /Invalid cat config/);
  });
});

describe('costBudget catalog resolution', () => {
  it('field absent → resolved CatConfig has no costBudget (no cap, always allowed)', () => {
    const path = writeTempConfig(baseConfig());
    const config = toAllCatConfigs(loadCatConfig(path));
    assert.equal(config['opus-pb-test'].costBudget, undefined);
  });

  it('variant-level costBudget.perCatDailyUsd round-trips exactly', () => {
    const path = writeTempConfig(baseConfig({ variantExtra: { costBudget: { perCatDailyUsd: 12.5 } } }));
    const config = toAllCatConfigs(loadCatConfig(path));
    assert.deepEqual(config['opus-pb-test'].costBudget, { perCatDailyUsd: 12.5 });
  });

  it('rejects a non-positive perCatDailyUsd at load time (zod .positive())', () => {
    const path = writeTempConfig(baseConfig({ variantExtra: { costBudget: { perCatDailyUsd: 0 } } }));
    assert.throws(() => loadCatConfig(path), /Invalid cat config/);
  });

  it('costBudget has no breed-level fallback (variant-only, same as contextBudget)', () => {
    const path = writeTempConfig(baseConfig({ breedExtra: { costBudget: { perCatDailyUsd: 5 } } }));
    // breed-level costBudget is not part of the schema — loadCatConfig should reject the
    // unrecognized key path gracefully (zod strips unknown keys by default) rather than apply it.
    const config = toAllCatConfigs(loadCatConfig(path));
    assert.equal(config['opus-pb-test'].costBudget, undefined, 'breed-level costBudget must not be honored');
  });
});
