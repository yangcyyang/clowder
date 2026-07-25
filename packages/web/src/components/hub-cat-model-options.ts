import type { HubCatEditorFormState } from './hub-cat-editor.model';

export type ModelCandidateSource = 'cli' | 'config' | 'static' | 'remote' | 'catalog';
export type ModelOptionsByClient = Partial<Record<HubCatEditorFormState['clientId'], string[]>>;
export type ModelSourcesByClient = Partial<Record<HubCatEditorFormState['clientId'], ModelCandidateSource>>;

export interface CatModelOptionsResponse {
  scannedAt?: string;
  clients?: Partial<
    Record<HubCatEditorFormState['clientId'], string[] | { models?: string[]; modelsSource?: ModelCandidateSource }>
  >;
}

export const MODEL_SOURCE_LABELS: Record<ModelCandidateSource, string> = {
  cli: '实测',
  config: '配置',
  remote: '远程清单',
  catalog: '云目录',
  static: '内置(可能过期)',
};

export function isScannedModelSource(source: ModelCandidateSource | undefined): boolean {
  return source === 'cli' || source === 'config' || source === 'remote' || source === 'catalog';
}

function uniqueModels(models: readonly string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))];
}

export function parseModelOptionsResponse(body: CatModelOptionsResponse): {
  options: ModelOptionsByClient;
  sources: ModelSourcesByClient;
  scannedAt?: string;
} {
  const options: ModelOptionsByClient = {};
  const sources: ModelSourcesByClient = {};
  for (const [clientId, preset] of Object.entries(body.clients ?? {})) {
    const models = Array.isArray(preset) ? preset : preset?.models;
    if (!Array.isArray(models)) continue;
    const typedClientId = clientId as HubCatEditorFormState['clientId'];
    options[typedClientId] = uniqueModels(models);
    if (!Array.isArray(preset) && preset.modelsSource) sources[typedClientId] = preset.modelsSource;
  }
  return {
    options,
    sources,
    ...(body.scannedAt ? { scannedAt: body.scannedAt } : {}),
  };
}
