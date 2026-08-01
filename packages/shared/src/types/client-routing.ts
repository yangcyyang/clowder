import type { ClientId } from './cat.js';
import type { AccountProtocol } from './cat-breed.js';

export type BuiltinAccountClient = Extract<
  ClientId,
  'anthropic' | 'openai' | 'google' | 'kimi' | 'grok' | 'dare' | 'opencode'
>;
export type BuiltinAccountProtocol = Extract<AccountProtocol, 'anthropic' | 'openai' | 'google' | 'kimi' | 'xai'>;

export type ClientAuthMode = 'account-binding' | 'cli-login' | 'external';
export type AccountBindingMode = 'required' | 'optional' | 'unsupported';

export interface ClientAuthCapabilities {
  readonly mode: ClientAuthMode;
  readonly accountBinding: AccountBindingMode;
}

const BUILTIN_ACCOUNT_IDS: Record<BuiltinAccountClient, string> = {
  anthropic: 'claude',
  openai: 'codex',
  google: 'gemini',
  kimi: 'kimi',
  grok: 'grok',
  dare: 'dare',
  opencode: 'opencode',
};

/**
 * Single source of truth for client authentication requirements.
 *
 * `grok` primarily reuses the CLI's own login state, while still allowing an
 * explicit API-key account binding. Bridge-only clients do not accept account
 * bindings at all.
 */
const CLIENT_AUTH_CAPABILITIES: Readonly<Record<ClientId, ClientAuthCapabilities>> = {
  anthropic: { mode: 'account-binding', accountBinding: 'required' },
  openai: { mode: 'account-binding', accountBinding: 'required' },
  google: { mode: 'account-binding', accountBinding: 'required' },
  kimi: { mode: 'account-binding', accountBinding: 'required' },
  grok: { mode: 'cli-login', accountBinding: 'optional' },
  dare: { mode: 'account-binding', accountBinding: 'required' },
  antigravity: { mode: 'cli-login', accountBinding: 'unsupported' },
  opencode: { mode: 'account-binding', accountBinding: 'required' },
  pi: { mode: 'cli-login', accountBinding: 'optional' },
  a2a: { mode: 'external', accountBinding: 'unsupported' },
  catagent: { mode: 'account-binding', accountBinding: 'required' },
};

export function getClientAuthCapabilities(client: ClientId): ClientAuthCapabilities {
  return CLIENT_AUTH_CAPABILITIES[client];
}

export function builtinAccountFamilyForClient(client: ClientId): BuiltinAccountClient | null {
  switch (client) {
    case 'anthropic':
    case 'openai':
    case 'google':
    case 'kimi':
    case 'grok':
    case 'dare':
    case 'opencode':
      return client;
    case 'catagent':
      return 'anthropic';
    default:
      return null;
  }
}

export function builtinAccountIdForClient(client: ClientId): string | null {
  const family = builtinAccountFamilyForClient(client);
  return family ? BUILTIN_ACCOUNT_IDS[family] : null;
}

export function protocolForClient(client: ClientId): BuiltinAccountProtocol | null {
  switch (client) {
    case 'anthropic':
    case 'catagent':
    case 'opencode':
      return 'anthropic';
    case 'openai':
    case 'dare':
      return 'openai';
    case 'google':
      return 'google';
    case 'kimi':
      return 'kimi';
    case 'grok':
      return 'xai';
    default:
      return null;
  }
}
