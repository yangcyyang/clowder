/**
 * clowder-ai#340 — Account startup hook (fail-fast contract)
 *
 * Triggers migration, verifies accounts + credentials are readable,
 * and enforces LL-043: legacy source present + no accounts = hard error.
 */
import { hasLegacyProviderProfiles, readCatalogAccounts } from './catalog-accounts.js';
import { assertCredentialsReadable } from './credentials.js';
import { scanAccountsForLeakedEnvVars, type LeakedEnvVarFinding } from '../utils/env-var-secret-guard.js';
import { createModuleLogger } from '../infrastructure/logger.js';

const moduleLog = createModuleLogger('account-startup');

export interface AccountStartupResult {
  accountCount: number;
  /** 票B B1: masked findings from the one-time read-only envVars leak scan. */
  leakedEnvVars: LeakedEnvVarFinding[];
}

interface WarnLogger {
  warn: (obj: unknown, msg?: string) => void;
}

/**
 * Startup check — trigger migration and verify system health.
 * Throws on: migration conflict, corrupt accounts/credentials, LL-043 invariant.
 */
export function accountStartupHook(projectRoot: string, options?: { log?: WarnLogger }): AccountStartupResult {
  // readCatalogAccounts triggers ensureMigrated → may throw on account conflicts
  let accounts: Record<string, unknown>;
  try {
    accounts = readCatalogAccounts(projectRoot);
  } catch (err) {
    // Wrap with context if legacy source exists (LL-043: migration failed)
    if (hasLegacyProviderProfiles(projectRoot)) {
      throw new Error(
        `F136 LL-043: account read/migration failed while legacy provider-profiles.json exists. ` +
          `Original: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    throw err;
  }

  // Verify credentials file is readable (fail-fast on corrupt JSON)
  try {
    assertCredentialsReadable(projectRoot);
  } catch (err) {
    throw new Error(`F136 startup: credentials read failed — ${err instanceof Error ? err.message : String(err)}`);
  }

  // LL-043: Legacy source present but no accounts after migration = silent failure
  if (hasLegacyProviderProfiles(projectRoot) && Object.keys(accounts).length === 0) {
    throw new Error(
      'F136 LL-043: legacy provider-profiles.json exists but no accounts after migration. ' +
        'Migration may have failed silently. Check migration logs.',
    );
  }

  // 票B B1: one-time read-only leak scan — accounts written before the
  // write-time rejection may carry secret-like envVars in accounts.json (0644).
  // Warn-only, masked key names, NEVER values.
  const log = options?.log ?? moduleLog;
  const leakedEnvVars = scanAccountsForLeakedEnvVars(
    accounts as Record<string, { envVars?: Readonly<Record<string, string>> }>,
  );
  for (const finding of leakedEnvVars) {
    log.warn(
      { accountId: finding.accountId, envKey: finding.maskedKey, detail: finding.detail },
      '[security] account envVars contains a secret-like entry — move it to credentials.json (0600 keychain)',
    );
  }

  return { accountCount: Object.keys(accounts).length, leakedEnvVars };
}
