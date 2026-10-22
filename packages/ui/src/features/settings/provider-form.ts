/** The "Add provider" form: defaults, id slugs, validation and the draft sent to the backend. */
import {
  DEFAULT_BASE_URLS,
  PROVIDER_LABELS,
  PROVIDER_PRESETS,
  ProviderId,
  presetOf,
  type DetectedProvider,
  type ProviderConfig,
  type ProviderDraft,
  type ProviderPresetId,
  type ProviderType,
  type SecretSummary,
} from '@atelier/protocol';

export interface ProviderForm {
  type: ProviderType;
  /** A hosted service offered by name (an `openai-compatible` provider at its address). */
  preset?: ProviderPresetId;
  name: string;
  id: string;
  /** Once the id is edited by hand it stops following the name. */
  idEdited: boolean;
  baseUrl: string;
  /** A newly entered key. Empty keeps the stored one when editing. */
  apiKey: string;
  /** Import the key from this environment variable instead. */
  apiKeyFromEnv?: string;
  headers: { name: string; value: string }[];
  enabled: boolean;
  /** What the server takes at once, as typed; empty is automatic. */
  parallelRequests: string;
  modelsAtOnce: string;
  vramGB: string;
}

export type ProviderFormErrors = Partial<Record<'name' | 'id' | 'baseUrl' | 'apiKey' | 'headers' | 'parallelRequests' | 'modelsAtOnce' | 'vramGB', string>>;

export const PROVIDER_DESCRIPTIONS: Record<ProviderType, string> = {
  ollama: 'Local models served by Ollama.',
  llamacpp: 'A llama.cpp server (llama-server).',
  'openai-compatible': 'LM Studio, vLLM, OpenRouter or any OpenAI-compatible API.',
  anthropic: 'Claude models through the Anthropic API.',
  openai: 'GPT models through the OpenAI API.',
  chatgpt: 'The models in your ChatGPT plan, signed in with your account.',
  'chatgpt-chat': 'Experimental: use ChatGPT itself through a private browser session.',
  copilot: 'The models in your GitHub Copilot plan, signed in with GitHub.',
};

/** Hosted APIs reject requests without a key; local servers usually don't need one. */
export function keyRequired(type: ProviderType): boolean {
  return type === 'anthropic' || type === 'openai';
}

/** What the form adds or edits: the preset's name, else the type's. */
export function formLabel(form: Pick<ProviderForm, 'type' | 'preset'>): string {
  return PROVIDER_PRESETS.find((p) => p.id === form.preset)?.name ?? PROVIDER_LABELS[form.type];
}

/** Presets are hosted APIs too. */
export function formNeedsKey(form: Pick<ProviderForm, 'type' | 'preset'>): boolean {
  return keyRequired(form.type) || !!form.preset;
}

/** Lowercase letters, digits and dashes, starting with a letter or digit, at most 48 long. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 48)
    .replace(/-+$/, '');
}

/** `base`, or `base-2`, `base-3`… when taken. */
export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  const root = base || 'provider';
  if (!taken.has(root)) return root;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = root.slice(0, 48 - suffix.length).replace(/-+$/, '') + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

export function newProviderForm(
  type: ProviderType,
  taken: ReadonlySet<string>,
  prefill: { name?: string; baseUrl?: string; apiKeyFromEnv?: string } = {},
): ProviderForm {
  const name = prefill.name ?? PROVIDER_LABELS[type];
  return {
    type,
    name,
    id: uniqueId(slugify(name), taken),
    idEdited: false,
    baseUrl: prefill.baseUrl ?? DEFAULT_BASE_URLS[type],
    apiKey: '',
    ...(prefill.apiKeyFromEnv ? { apiKeyFromEnv: prefill.apiKeyFromEnv } : {}),
    headers: [],
    enabled: true,
    parallelRequests: '',
    modelsAtOnce: '',
    vramGB: '',
  };
}

export function newPresetForm(id: ProviderPresetId, taken: ReadonlySet<string>): ProviderForm {
  const preset = PROVIDER_PRESETS.find((p) => p.id === id)!;
  return { ...newProviderForm('openai-compatible', taken, { name: preset.name, baseUrl: preset.baseUrl }), preset: id };
}

export function formFromDetected(d: DetectedProvider, taken: ReadonlySet<string>): ProviderForm {
  return newProviderForm(d.type, taken, { name: d.label, baseUrl: d.baseUrl, ...(d.envVar ? { apiKeyFromEnv: d.envVar } : {}) });
}

export function formFromConfig(config: ProviderConfig): ProviderForm {
  const preset = config.type === 'openai-compatible' ? presetOf(config.baseUrl) : undefined;
  return {
    type: config.type,
    ...(preset ? { preset } : {}),
    name: config.name,
    id: config.id,
    idEdited: true,
    baseUrl: config.baseUrl,
    apiKey: '',
    headers: Object.entries(config.headers).map(([name, value]) => ({ name, value })),
    enabled: config.enabled,
    parallelRequests: config.parallelRequests?.toString() ?? '',
    modelsAtOnce: config.modelsAtOnce?.toString() ?? '',
    vramGB: config.vramGiB === undefined ? '' : (config.vramGiB * 1024 ** 3 / 1e9).toString(),
  };
}

/** Renaming also renames the id until the id has been edited by hand. */
export function renameForm(form: ProviderForm, name: string, taken: ReadonlySet<string>): ProviderForm {
  return { ...form, name, ...(form.idEdited ? {} : { id: uniqueId(slugify(name), taken) }) };
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function validateProviderForm(
  form: ProviderForm,
  ctx: { taken: ReadonlySet<string>; editing: boolean; hasStoredKey: boolean },
): ProviderFormErrors {
  const errors: ProviderFormErrors = {};
  if (!form.name.trim()) errors.name = 'Enter a name.';
  if (!ProviderId.safeParse(form.id).success) errors.id = 'Use lowercase letters, digits and dashes, starting with a letter or digit.';
  else if (!ctx.editing && ctx.taken.has(form.id)) errors.id = 'Another provider already uses this id.';
  if (!isHttpUrl(form.baseUrl.trim())) errors.baseUrl = 'Enter a URL starting with http:// or https://.';
  if (formNeedsKey(form) && !form.apiKey.trim() && !form.apiKeyFromEnv && !(ctx.editing && ctx.hasStoredKey)) {
    errors.apiKey = `${formLabel(form)} needs an API key.`;
  }
  const named = form.headers.filter((h) => h.name.trim() || h.value);
  if (named.some((h) => !HEADER_NAME.test(h.name.trim()))) errors.headers = 'Header names can’t be empty or contain spaces.';
  else if (new Set(named.map((h) => h.name.trim().toLowerCase())).size !== named.length) errors.headers = 'Each header can only be set once.';
  if (count(form.parallelRequests, 64) === undefined) errors.parallelRequests = 'Leave empty for automatic, or enter 1 to 64.';
  if (count(form.modelsAtOnce, 16) === undefined) errors.modelsAtOnce = 'Leave empty for automatic, or enter 1 to 16.';
  if (form.vramGB.trim() && (!Number.isFinite(Number(form.vramGB)) || Number(form.vramGB) <= 0 || Number(form.vramGB) > 1_048_576)) {
    errors.vramGB = 'Leave empty for the default context, or enter available memory in GB (greater than 0).';
  }
  return errors;
}

/** A whole number from 1 to `max`, null when empty (automatic), undefined when invalid. */
function count(text: string, max: number): number | null | undefined {
  if (!text.trim()) return null;
  const n = Number(text.trim());
  return Number.isInteger(n) && n >= 1 && n <= max ? n : undefined;
}

function isHttpUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname;
  } catch {
    return false;
  }
}

/** What `providers.test` / `providers.save` take. The key is only included when one was entered. */
export function toDraft(form: ProviderForm): ProviderDraft {
  const headers = Object.fromEntries(form.headers.filter((h) => h.name.trim()).map((h) => [h.name.trim(), h.value]));
  return {
    id: form.id,
    type: form.type,
    name: form.name.trim(),
    baseUrl: form.baseUrl.trim(),
    headers,
    enabled: form.enabled,
    ...(form.vramGB.trim() ? { vramGiB: Number(form.vramGB.trim()) * 1e9 / 1024 ** 3 } : {}),
    ...(count(form.parallelRequests, 64) ? { parallelRequests: Number(form.parallelRequests.trim()) } : {}),
    ...(count(form.modelsAtOnce, 16) ? { modelsAtOnce: Number(form.modelsAtOnce.trim()) } : {}),
    ...(form.apiKeyFromEnv ? { apiKeyFromEnv: form.apiKeyFromEnv } : form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
  };
}

/**
 * What to show for a provider's stored key without revealing it: the masked tail of a stored
 * secret, an environment reference as written, or dots for anything else.
 */
export function keyHint(apiKey: string | undefined, secrets: readonly SecretSummary[] = []): string | undefined {
  if (!apiKey) return undefined;
  const secretId = apiKey.match(/^\$\{secret:([^}]+)\}$/)?.[1];
  if (secretId) return secrets.find((s) => s.id === secretId)?.masked ?? '••••';
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*(:-[^}]*)?\}$/.test(apiKey) ? apiKey : '••••';
}
