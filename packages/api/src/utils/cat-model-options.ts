import type { ClientId } from '@cat-cafe/shared';
import { getLocalCliModelsSnapshot } from './local-cli-model-cache.js';
import { LOCAL_CLI_MODELS_PROBES, type LocalCliModelSource } from './local-cli-model-probes.js';

interface CatModelOptionPreset {
  readonly defaultModel: string;
  readonly models: readonly string[];
}

export interface CatModelOptionClient {
  readonly defaultModel: string;
  readonly models: string[];
  readonly modelsSource: LocalCliModelSource;
}

const STATIC_PRESETS: Partial<Record<ClientId, CatModelOptionPreset>> = {
  anthropic: { defaultModel: 'claude-sonnet-5', models: LOCAL_CLI_MODELS_PROBES.claude.static ?? [] },
  openai: { defaultModel: 'gpt-5.6-sol', models: LOCAL_CLI_MODELS_PROBES.codex.static ?? [] },
  google: { defaultModel: 'gemini-3.1-pro-preview', models: LOCAL_CLI_MODELS_PROBES.gemini.static ?? [] },
  kimi: { defaultModel: 'kimi-code/k3', models: LOCAL_CLI_MODELS_PROBES.kimi.static ?? [] },
  grok: { defaultModel: 'grok-4.5', models: LOCAL_CLI_MODELS_PROBES.grok.static ?? [] },
  opencode: { defaultModel: 'xiaomi-mimo/mimo-v2.5-pro', models: LOCAL_CLI_MODELS_PROBES.opencode.static ?? [] },
  dare: { defaultModel: 'claude-fable-5', models: ['claude-fable-5'] },
  pi: {
    defaultModel: 'mimo/mimo-v2.5-pro',
    models: ['mimo/mimo-v2.5-pro', 'mimo/mimo-v2.5', 'xiaomi/mimo-v2.5-pro', 'openrouter/auto'],
  },
};

function uniqueModels(models: readonly string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))];
}

function staticClients(): Partial<Record<ClientId, CatModelOptionClient>> {
  return Object.fromEntries(
    Object.entries(STATIC_PRESETS).map(([clientId, preset]) => [
      clientId,
      {
        defaultModel: preset.defaultModel,
        models: uniqueModels(preset.models),
        modelsSource: 'static',
      },
    ]),
  ) as Partial<Record<ClientId, CatModelOptionClient>>;
}

export function getCatModelOptionsResponse(userId: string): {
  source: 'static-presets-v1' | 'local-cli-scan-v1';
  scannedAt?: string;
  clients: Partial<Record<ClientId, CatModelOptionClient>>;
} {
  const snapshot = getLocalCliModelsSnapshot(userId);
  const clients = staticClients();
  if (!snapshot) return { source: 'static-presets-v1', clients };

  let hasScannedModels = false;
  for (const cli of snapshot.clis) {
    if (!cli.clientId) continue;
    // 'remote' (the 4th, env-configured discovery source) is merged additively on top of
    // whichever base tier (cli/config/static) already ran — see probeLocalCliModels(). So a live
    // signal here means "any cli/config/remote entry exists", but the exposed candidate list must
    // still include every id in cli.models (static siblings included), or a small remote catalog
    // would wipe out the rest of the known-good static options instead of just extending them.
    const hasLiveSignal = cli.models.some(
      (model) => model.source === 'cli' || model.source === 'config' || model.source === 'remote',
    );
    if (!hasLiveSignal) continue;

    const models = uniqueModels(cli.models.map((model) => model.id));
    if (models.length === 0) continue;
    hasScannedModels = true;
    const staticPreset = clients[cli.clientId];
    const scannedDefault = cli.models.find((model) => model.isDefault)?.id;
    const modelsSource: LocalCliModelSource =
      cli.models.find((model) => model.source === 'cli')?.source ??
      cli.models.find((model) => model.source === 'config')?.source ??
      cli.models.find((model) => model.source === 'remote')?.source ??
      'static';
    clients[cli.clientId] = {
      defaultModel:
        scannedDefault ??
        (staticPreset && models.includes(staticPreset.defaultModel) ? staticPreset.defaultModel : (models[0] ?? '')),
      models,
      modelsSource,
    };
  }

  if (!hasScannedModels) return { source: 'static-presets-v1', clients };

  return {
    source: 'local-cli-scan-v1',
    scannedAt: snapshot.scannedAt,
    clients,
  };
}
