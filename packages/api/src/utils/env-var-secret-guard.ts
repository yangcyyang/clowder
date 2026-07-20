/**
 * 票B B1 — envVars keychain bypass guard.
 *
 * Account-level `envVars` (F171) live in accounts.json (0644) and are injected
 * LAST into the agent subprocess env. Secrets placed there bypass the 0600
 * credentials.json keychain. This module detects secret-like env var entries
 * so they can be rejected at write time (accounts routes), dropped at
 * injection time (invoke-single-cat), and scanned at startup (account-startup).
 *
 * Name matching is suffix-based (last `_` segment), NOT substring, so benign
 * numeric config like TOKEN_EXPIRY=3600 or MAX_TOKENS=8192 passes while
 * OPENAI_API_KEY / GITHUB_TOKEN / DB_PASSWORD are flagged.
 */

/** Sensitive final segments (compared case-insensitively). */
const SECRET_NAME_SUFFIXES = new Set([
  'KEY',
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'PRIVATE',
  'CREDENTIAL',
  'CREDENTIALS',
]);

/** Chinese secret markers — defense for pre-schema accounts with non-POSIX keys. */
const SECRET_NAME_CN = /凭证|密码|密钥/;

const SECRET_VALUE_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /^sk-[A-Za-z0-9]/, label: 'OpenAI/Anthropic-style API key (sk-…)' },
  { pattern: /^ghp_[A-Za-z0-9]/, label: 'GitHub personal access token (ghp_…)' },
  { pattern: /^gho_[A-Za-z0-9]/, label: 'GitHub OAuth token (gho_…)' },
  { pattern: /^github_pat_/, label: 'GitHub fine-grained PAT (github_pat_…)' },
  { pattern: /^Bearer\s+\S/, label: 'Bearer token' },
  { pattern: /^AKIA[0-9A-Z]{16}/, label: 'AWS access key id (AKIA…)' },
  { pattern: /^xox[baprs]-/, label: 'Slack token (xox…)' },
  { pattern: /^-----BEGIN/, label: 'PEM private material (-----BEGIN …)' },
  { pattern: /hooks\.slack\.com\/services\//, label: 'Slack webhook URL with secret path' },
  { pattern: /discord(?:app)?\.com\/api\/webhooks\//, label: 'Discord webhook URL with secret path' },
];

export const ENV_VAR_SECRET_MESSAGE = 'store secrets in credentials, not envVars';

/**
 * Returns a human-readable reason when the key/value pair looks like a secret,
 * or null when it looks like benign configuration.
 */
export function detectEnvVarSecret(key: string, value: string): string | null {
  const trimmedKey = key.trim();
  if (SECRET_NAME_CN.test(trimmedKey)) {
    return `key name contains a secret marker (${trimmedKey.includes('凭证') ? '凭证' : trimmedKey.includes('密码') ? '密码' : '密钥'})`;
  }
  const segments = trimmedKey.split('_').filter((s) => s.length > 0);
  const last = segments.length > 0 ? segments[segments.length - 1]!.toUpperCase() : '';
  if (SECRET_NAME_SUFFIXES.has(last)) {
    return `key name ends with secret suffix "${last}"`;
  }
  const trimmedValue = value.trim();
  for (const { pattern, label } of SECRET_VALUE_PATTERNS) {
    if (pattern.test(trimmedValue)) {
      return `value looks like ${label}`;
    }
  }
  return null;
}

/** Mask a key name for logs: keep 2-char edges, hide the middle. */
export function maskEnvKey(key: string): string {
  if (key.length <= 4) return '***';
  return `${key.slice(0, 2)}***${key.slice(-2)}`;
}

export interface EnvVarDrop {
  /** Masked key name — safe to log. */
  maskedKey: string;
  reason: 'reserved_prefix' | 'invalid_key' | 'secret_like';
  /** Only present for secret_like drops; never contains the value. */
  detail?: string;
}

/**
 * Injection-time filter (defense-in-depth for accounts written before the
 * write-time rejection existed). Drops CAT_CAFE_ reserved keys, non-POSIX
 * keys, and secret-like entries. The optional onDrop callback receives
 * metadata only — never values.
 */
export function filterAccountEnvVars(
  vars: Readonly<Record<string, string>>,
  onDrop?: (drop: EnvVarDrop) => void,
): Record<string, string> {
  const validEnvKey = /^[A-Z_][A-Za-z0-9_]*$/;
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (!validEnvKey.test(k)) {
      onDrop?.({ maskedKey: maskEnvKey(k), reason: 'invalid_key' });
      continue;
    }
    if (k.startsWith('CAT_CAFE_')) {
      onDrop?.({ maskedKey: maskEnvKey(k), reason: 'reserved_prefix' });
      continue;
    }
    const secretReason = detectEnvVarSecret(k, v);
    if (secretReason) {
      onDrop?.({ maskedKey: maskEnvKey(k), reason: 'secret_like', detail: secretReason });
      continue;
    }
    filtered[k] = v;
  }
  return filtered;
}

export interface LeakedEnvVarFinding {
  accountId: string;
  maskedKey: string;
  detail: string;
}

/**
 * One-time read-only leak scan (startup). Returns masked findings only —
 * never includes values.
 */
export function scanAccountsForLeakedEnvVars(
  accounts: Readonly<Record<string, { envVars?: Readonly<Record<string, string>> }>>,
): LeakedEnvVarFinding[] {
  const findings: LeakedEnvVarFinding[] = [];
  for (const [accountId, account] of Object.entries(accounts)) {
    if (!account?.envVars) continue;
    for (const [k, v] of Object.entries(account.envVars)) {
      const reason = detectEnvVarSecret(k, v);
      if (reason) {
        findings.push({ accountId, maskedKey: maskEnvKey(k), detail: reason });
      }
    }
  }
  return findings;
}
