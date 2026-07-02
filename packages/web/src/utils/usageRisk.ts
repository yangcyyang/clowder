export interface UsageRiskInput {
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
}

export interface UsageRisk {
  level: 'high';
  label: string;
  reason: string;
}

const HIGH_INPUT_TOKENS = 500_000;
const HIGH_CACHE_READ_TOKENS = 500_000;
const HIGH_CACHE_CREATION_TOKENS = 250_000;
const HIGH_COST_USD = 5;

export function getUsageRisk(usage: UsageRiskInput): UsageRisk | null {
  if ((usage.costUsd ?? 0) >= HIGH_COST_USD) {
    return { level: 'high', label: '高消耗', reason: `cost >= $${HIGH_COST_USD}` };
  }
  if ((usage.cacheCreationTokens ?? 0) >= HIGH_CACHE_CREATION_TOKENS) {
    return { level: 'high', label: '高消耗', reason: `cacheCreate >= ${HIGH_CACHE_CREATION_TOKENS.toLocaleString()}` };
  }
  if ((usage.cacheReadTokens ?? 0) >= HIGH_CACHE_READ_TOKENS) {
    return { level: 'high', label: '高消耗', reason: `cacheRead >= ${HIGH_CACHE_READ_TOKENS.toLocaleString()}` };
  }
  if ((usage.inputTokens ?? 0) >= HIGH_INPUT_TOKENS) {
    return { level: 'high', label: '高消耗', reason: `input >= ${HIGH_INPUT_TOKENS.toLocaleString()}` };
  }
  return null;
}
