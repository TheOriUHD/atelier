/** The "Add image provider" form: which services there are, defaults, validation and the draft sent to the backend. */
import {
  IMAGE_PROVIDER_PRESETS,
  ProviderId,
  imagePreset,
  isLoopbackHost,
  presetOf,
  type DetectedImageServer,
  type ImagePreset,
  type ImagePresetGroup,
  type ImageProviderConfig,
  type ImageProviderDraft,
  type ProviderConfig,
  type ProviderType,
} from '@atelier/protocol';
import { count, isHttpUrl, slugify, uniqueId } from './provider-form.ts';

export interface ImageProviderForm {
  preset: ImagePreset;
  name: string;
  id: string;
  /** Once the id is edited by hand it stops following the name. */
  idEdited: boolean;
  baseUrl: string;
  /** A newly entered key. Empty keeps the stored one when editing. */
  apiKey: string;
  /** Copies this text provider's key when saved, instead of a typed one. */
  keyFrom: string | null;
  /** As typed; empty is automatic. */
  parallelRequests: string;
  sharesGpuWith: string | null;
  freeAfterRun: boolean;
  /** Model ids typed in, for a service with no list of models. */
  models: string[];
  /** What the form doesn't show, kept when editing. */
  kept: Pick<ImageProviderConfig, 'headers' | 'enabled' | 'workflows'>;
}

export type ImageProviderFormErrors = Partial<Record<'name' | 'id' | 'baseUrl' | 'apiKey' | 'parallelRequests' | 'models', string>>;

export const IMAGE_PRESET_GROUPS: readonly { group: ImagePresetGroup; label: string; presets: readonly ImagePreset[] }[] = (
  [
    ['local', 'Local'],
    ['cloud', 'Cloud'],
    ['aggregator', 'Aggregators'],
    ['custom', 'Custom'],
  ] as const
).map(([group, label]) => ({ group, label, presets: IMAGE_PROVIDER_PRESETS.filter((p) => p.group === group) }));

/** Local servers can share a GPU with a text model; a custom address may be one. */
export const runsLocally = (preset: ImagePreset) => preset.group === 'local' || preset.group === 'custom';

/** Only a local server is certainly free; a custom address may be a paid gateway. */
export const mayCostMoney = (preset: ImagePreset) => preset.group !== 'local';

/** Azure and custom servers may report no models either, though no suggestion fits them. */
export const hasTypedModels = (preset: ImagePreset) => !!preset.suggestedModels || preset.id === 'azure' || preset.id === 'openai-compatible' || preset.id === 'sd-server';

const NEW_CONFIG: ImageProviderForm['kept'] = { headers: {}, enabled: true };

export function newImageProviderForm(preset: ImagePreset, taken: ReadonlySet<string>, prefill: { name?: string; baseUrl?: string } = {}): ImageProviderForm {
  const name = prefill.name ?? preset.label;
  return {
    preset,
    name,
    id: uniqueId(slugify(name), taken),
    idEdited: false,
    baseUrl: prefill.baseUrl ?? preset.baseUrl,
    apiKey: '',
    keyFrom: null,
    parallelRequests: '',
    sharesGpuWith: null,
    freeAfterRun: false,
    models: [...(preset.suggestedModels ?? [])],
    kept: NEW_CONFIG,
  };
}

/** A provider's service: the preset it was added as, or a preset of its kind for one written into a settings file. */
export function presetFor(config: Pick<ImageProviderConfig, 'preset' | 'type'>): ImagePreset {
  return imagePreset(config.preset) ?? IMAGE_PROVIDER_PRESETS.find((p) => p.type === config.type) ?? IMAGE_PROVIDER_PRESETS.at(-1)!;
}

export function imageFormFromConfig(config: ImageProviderConfig): ImageProviderForm {
  return {
    preset: presetFor(config),
    name: config.name,
    id: config.id,
    idEdited: true,
    baseUrl: config.baseUrl,
    apiKey: '',
    keyFrom: null,
    parallelRequests: config.parallelRequests?.toString() ?? '',
    sharesGpuWith: config.sharesGpuWith ?? null,
    freeAfterRun: !!config.freeAfterRun,
    models: config.models ?? [],
    kept: { headers: config.headers, enabled: config.enabled, ...(config.workflows ? { workflows: config.workflows } : {}) },
  };
}

/** Renaming also renames the id until the id has been edited by hand. */
export function renameImageForm(form: ImageProviderForm, name: string, taken: ReadonlySet<string>): ImageProviderForm {
  return { ...form, name, ...(form.idEdited ? {} : { id: uniqueId(slugify(name), taken) }) };
}

export function validateImageProviderForm(form: ImageProviderForm, ctx: { taken: ReadonlySet<string>; editing: boolean; hasStoredKey: boolean }): ImageProviderFormErrors {
  const errors: ImageProviderFormErrors = {};
  const url = form.baseUrl.trim();
  if (!form.name.trim()) errors.name = 'Enter a name.';
  if (!ProviderId.safeParse(form.id).success) errors.id = 'Use lowercase letters, digits and dashes, starting with a letter or digit.';
  else if (!ctx.editing && ctx.taken.has(form.id)) errors.id = 'Another provider already uses this id.';
  if (!isHttpUrl(url)) errors.baseUrl = 'Enter a URL starting with http:// or https://.';
  else if (url.includes('YOUR-RESOURCE')) errors.baseUrl = 'Put the name of your resource in place of YOUR-RESOURCE.';
  if (form.preset.key === 'required' && !form.apiKey.trim() && !form.keyFrom && !(ctx.editing && ctx.hasStoredKey)) errors.apiKey = `${form.preset.label} needs an API key.`;
  if (count(form.parallelRequests, 64) === undefined) errors.parallelRequests = 'Leave empty for automatic, or enter 1 to 64.';
  if (form.preset.id === 'azure' && form.models.length === 0) errors.models = 'Add at least one deployment.';
  return errors;
}

/** What `imageProviders.test`, `.tryImage` and `.save` take. The key is only included when one was entered. */
export function toImageDraft(form: ImageProviderForm): ImageProviderDraft {
  const parallel = count(form.parallelRequests, 64);
  return {
    ...form.kept,
    id: form.id,
    type: form.preset.type,
    preset: form.preset.id,
    name: form.name.trim(),
    baseUrl: form.baseUrl.trim(),
    ...(parallel ? { parallelRequests: parallel } : {}),
    ...(form.sharesGpuWith ? { sharesGpuWith: form.sharesGpuWith } : {}),
    ...(form.freeAfterRun ? { freeAfterRun: true } : {}),
    ...(form.models.length ? { models: form.models } : {}),
    ...(form.keyFrom ? { apiKeyFromProvider: form.keyFrom } : form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
  };
}

/** A saved provider as a draft, for changing part of it. Its stored key stays out: `apiKey` here would be saved as a new key. */
export function configToDraft(config: ImageProviderConfig): ImageProviderDraft {
  const { apiKey: _stored, ...draft } = config;
  return draft;
}

/** One click on a server found on this computer. */
export function detectedDraft(server: DetectedImageServer, taken: ReadonlySet<string>): ImageProviderDraft {
  return toImageDraft(newImageProviderForm(presetFor({ preset: server.preset, type: server.type }), taken, { name: server.label, baseUrl: server.baseUrl }));
}

const HOSTED: ReadonlySet<ProviderType> = new Set<ProviderType>(['anthropic', 'openai', 'chatgpt', 'chatgpt-chat', 'copilot']);

function hostOf(url: string): string | null {
  try {
    const { hostname } = new URL(url);
    return isLoopbackHost(hostname) ? 'localhost' : hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Text providers whose key also works for this service: for a service that isn't OpenAI itself, only those at its own address. */
export function keySources(preset: ImagePreset, providers: readonly ProviderConfig[]): ProviderConfig[] {
  if (!preset.sharesKeyWith) return [];
  return providers.filter((p) => p.type === preset.sharesKeyWith && !!p.apiKey && (p.type === 'openai' || hostOf(p.baseUrl) === hostOf(preset.baseUrl)));
}

export interface GpuPartner {
  provider: ProviderConfig;
  /** On the same computer as the image server, so it most likely shares the GPU. */
  sameHost: boolean;
}

/** Local text providers an image server can share a GPU with, those on its own computer first. */
export function gpuPartners(baseUrl: string, providers: readonly ProviderConfig[]): GpuPartner[] {
  const host = hostOf(baseUrl);
  return providers
    .filter((p) => !HOSTED.has(p.type) && !presetOf(p.baseUrl))
    .map((provider) => ({ provider, sameHost: !!host && hostOf(provider.baseUrl) === host }))
    .sort((a, b) => Number(b.sameHost) - Number(a.sameHost));
}
