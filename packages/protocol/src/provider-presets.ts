/**
 * Provider presets (ARCHITECTURE §7): hosted services the wizard offers by name. Each is an `openai-compatible`
 * provider at the service's address; the adapter recognizes the address and adds what the service needs.
 */

export type ProviderPresetId = 'openrouter' | 'opencode-zen';

export interface ProviderPreset {
  id: ProviderPresetId;
  name: string;
  description: string;
  baseUrl: string;
  /** Where a key is created, for the key field's help. */
  keyUrl: string;
}

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENCODE_ZEN_BASE_URL = 'https://opencode.ai/inference/openai/v1';

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'Hundreds of hosted models, some of them free. Connect with your account in one click.',
    baseUrl: OPENROUTER_BASE_URL,
    keyUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'opencode-zen',
    name: 'OpenCode Zen',
    description: 'Hosted models through an OpenCode Console key.',
    baseUrl: OPENCODE_ZEN_BASE_URL,
    keyUrl: 'https://opencode.ai',
  },
];

const HOSTS: Record<string, ProviderPresetId> = { 'openrouter.ai': 'openrouter', 'opencode.ai': 'opencode-zen' };

/** The preset a base URL belongs to, by its host. */
export function presetOf(baseUrl: string): ProviderPresetId | undefined {
  try {
    return HOSTS[new URL(baseUrl).hostname.replace(/^www\./, '')];
  } catch {
    return undefined;
  }
}
