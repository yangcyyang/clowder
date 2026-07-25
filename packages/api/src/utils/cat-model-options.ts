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
    // 'remote' (4th source) and 'catalog' (5th source) are both merged additively on top of
    // whichever base tier (cli/config/static) already ran — see probeLocalCliModels(). So a live
    // signal here means "any cli/config/remote entry exists", but the exposed candidate list must
    // still include every id in cli.models (static siblings included), or a small remote/catalog
    // addition would wipe out the rest of the known-good static options instead of just extending them.
    const hasNonCatalogLiveSignal = cli.models.some(
      (model) => model.source === 'cli' || model.source === 'config' || model.source === 'remote',
    );
    // 'catalog' is a generic, machine-independent cloud model list (models.dev + LiteLLM) — unlike
    // 'remote' (an operator explicitly pointed at a gateway that reported these models), its mere
    // presence says nothing about *this* machine. Counting it alone as a live signal would flip
    // every user to local-cli-scan-v1 as soon as the cloud fetch succeeds, even with zero CLIs
    // installed — misrepresenting "we detected your machine". So it only counts when paired with
    // the CLI actually being installed; otherwise this cli entry is skipped entirely this round
    // (its catalog ids are silently dropped, static preset stays as-is) rather than surfaced with
    // an unclear half-live state.
    const hasCatalogSignal = cli.installed && cli.models.some((model) => model.source === 'catalog');
    if (!hasNonCatalogLiveSignal && !hasCatalogSignal) continue;

    const models = uniqueModels(cli.models.map((model) => model.id));
    if (models.length === 0) continue;
    hasScannedModels = true;
    const staticPreset = clients[cli.clientId];
    const scannedDefault = cli.models.find((model) => model.isDefault)?.id;
    const modelsSource: LocalCliModelSource =
      cli.models.find((model) => model.source === 'cli')?.source ??
      cli.models.find((model) => model.source === 'config')?.source ??
      cli.models.find((model) => model.source === 'remote')?.source ??
      cli.models.find((model) => model.source === 'catalog')?.source ??
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
