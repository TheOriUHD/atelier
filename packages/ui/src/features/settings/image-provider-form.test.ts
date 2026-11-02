import { describe, expect, it } from 'vitest';
import { IMAGE_PROVIDER_PRESETS, imagePreset, type ImageProviderConfig, type ProviderConfig } from '@atelier/protocol';
import {
  IMAGE_PRESET_GROUPS,
  configToDraft,
  detectedDraft,
  gpuPartners,
  hasTypedModels,
  imageFormFromConfig,
  keySources,
  mayCostMoney,
  newImageProviderForm,
  renameImageForm,
  toImageDraft,
  validateImageProviderForm,
} from './image-provider-form.ts';

const preset = (id: string) => imagePreset(id)!;
const noTaken = new Set<string>();
const text = (id: string, type: ProviderConfig['type'], baseUrl: string, extra: Partial<ProviderConfig> = {}): ProviderConfig => ({ id, type, name: id, baseUrl, headers: {}, enabled: true, ...extra });
const valid = { taken: noTaken, editing: false, hasStoredKey: false };

describe('the services offered', () => {
  it('groups every preset once, in the order of the dialog', () => {
    expect(IMAGE_PRESET_GROUPS.map((g) => g.label)).toEqual(['Local', 'Cloud', 'Aggregators', 'Custom']);
    expect(IMAGE_PRESET_GROUPS.flatMap((g) => g.presets).length).toBe(IMAGE_PROVIDER_PRESETS.length);
  });

  it('treats only a local server as certainly free', () => {
    expect(mayCostMoney(preset('comfyui'))).toBe(false);
    expect(mayCostMoney(preset('openai'))).toBe(true);
    expect(mayCostMoney(preset('openai-compatible'))).toBe(true);
  });

  it('asks for typed-in models where a service may report none', () => {
    expect(hasTypedModels(preset('fal'))).toBe(true);
    expect(hasTypedModels(preset('azure'))).toBe(true);
    expect(hasTypedModels(preset('openai'))).toBe(false);
    expect(hasTypedModels(preset('comfyui'))).toBe(false);
  });
});

describe('a new form', () => {
  it('starts from the preset, with an id no provider of either kind has', () => {
    const form = newImageProviderForm(preset('openai'), new Set(['openai']));
    expect(form).toMatchObject({ name: 'OpenAI', id: 'openai-2', baseUrl: 'https://api.openai.com', models: [] });
  });

  it('offers a service’s suggested models', () => {
    expect(newImageProviderForm(preset('fal'), noTaken).models).toEqual(preset('fal').suggestedModels);
  });

  it('lets the id follow the name until it was edited by hand', () => {
    const form = newImageProviderForm(preset('comfyui'), noTaken);
    expect(renameImageForm(form, 'Studio GPU', noTaken).id).toBe('studio-gpu');
    expect(renameImageForm({ ...form, idEdited: true }, 'Studio GPU', noTaken).id).toBe('comfyui');
  });
});

describe('validation', () => {
  it('needs a key where the service does, and takes a copied one or a stored one instead', () => {
    const form = newImageProviderForm(preset('openai'), noTaken);
    expect(validateImageProviderForm(form, valid).apiKey).toBe('OpenAI needs an API key.');
    expect(validateImageProviderForm({ ...form, keyFrom: 'openai-text' }, valid).apiKey).toBeUndefined();
    expect(validateImageProviderForm(form, { ...valid, editing: true, hasStoredKey: true }).apiKey).toBeUndefined();
    expect(validateImageProviderForm(newImageProviderForm(preset('comfyui'), noTaken), valid)).toEqual({});
  });

  it('refuses an id another provider has, and a bad address', () => {
    const form = newImageProviderForm(preset('comfyui'), noTaken);
    expect(validateImageProviderForm({ ...form, id: 'Bad Id' }, valid).id).toBeTruthy();
    expect(validateImageProviderForm({ ...form, id: 'ollama' }, { ...valid, taken: new Set(['ollama']) }).id).toBe('Another provider already uses this id.');
    expect(validateImageProviderForm({ ...form, baseUrl: 'localhost:8188' }, valid).baseUrl).toBeTruthy();
  });

  it('keeps Azure’s placeholder address and an empty deployment list from being saved', () => {
    const errors = validateImageProviderForm({ ...newImageProviderForm(preset('azure'), noTaken), apiKey: 'k' }, valid);
    expect(errors.baseUrl).toContain('YOUR-RESOURCE');
    expect(errors.models).toBe('Add at least one deployment.');
  });

  it('takes 1 to 64 requests at once, or empty for automatic', () => {
    const form = newImageProviderForm(preset('comfyui'), noTaken);
    expect(validateImageProviderForm({ ...form, parallelRequests: '65' }, valid).parallelRequests).toBeTruthy();
    expect(validateImageProviderForm({ ...form, parallelRequests: '1' }, valid).parallelRequests).toBeUndefined();
  });
});

describe('the draft', () => {
  const config: ImageProviderConfig = {
    id: 'comfy',
    type: 'comfyui',
    preset: 'comfyui',
    name: 'ComfyUI',
    baseUrl: 'http://192.168.20.25:8188',
    apiKey: '${secret:image-provider-comfy}',
    headers: { 'x-team': 'a' },
    enabled: false,
    parallelRequests: 1,
    sharesGpuWith: 'ollama',
    freeAfterRun: true,
    workflows: [],
  };

  it('carries what the form holds, and what it doesn’t show, through an edit', () => {
    expect(toImageDraft(imageFormFromConfig(config))).toEqual({
      id: 'comfy',
      type: 'comfyui',
      preset: 'comfyui',
      name: 'ComfyUI',
      baseUrl: 'http://192.168.20.25:8188',
      headers: { 'x-team': 'a' },
      enabled: false,
      parallelRequests: 1,
      sharesGpuWith: 'ollama',
      freeAfterRun: true,
      workflows: [],
    });
  });

  it('turns GPU sharing off by leaving it out, which replaces the saved value', () => {
    const draft = toImageDraft({ ...imageFormFromConfig(config), sharesGpuWith: null, freeAfterRun: false, parallelRequests: '' });
    expect(draft).not.toHaveProperty('sharesGpuWith');
    expect(draft).not.toHaveProperty('freeAfterRun');
    expect(draft).not.toHaveProperty('parallelRequests');
  });

  it('sends a typed key, or says whose to copy, never both', () => {
    const form = { ...newImageProviderForm(preset('openai'), noTaken), apiKey: ' sk-1 ' };
    expect(toImageDraft(form)).toMatchObject({ apiKey: 'sk-1' });
    const copied = toImageDraft({ ...form, keyFrom: 'openai-text' });
    expect(copied).toMatchObject({ apiKeyFromProvider: 'openai-text' });
    expect(copied).not.toHaveProperty('apiKey');
  });

  it('leaves the stored key out of a saved provider, or it would be stored as a new key', () => {
    expect(configToDraft(config)).not.toHaveProperty('apiKey');
    expect(configToDraft(config).sharesGpuWith).toBe('ollama');
  });

  it('adds a server found on this computer with what is known of it', () => {
    const draft = detectedDraft({ preset: 'comfyui', type: 'comfyui', baseUrl: 'http://127.0.0.1:8188', label: 'ComfyUI' }, new Set(['comfyui']));
    expect(draft).toMatchObject({ id: 'comfyui-2', type: 'comfyui', preset: 'comfyui', name: 'ComfyUI', baseUrl: 'http://127.0.0.1:8188', enabled: true });
  });
});

describe('a key to reuse', () => {
  it('comes from a text provider of the kind the service shares keys with', () => {
    const providers = [text('work', 'openai', 'https://api.openai.com', { apiKey: '${secret:a}' }), text('local', 'ollama', 'http://localhost:11434')];
    expect(keySources(preset('openai'), providers).map((p) => p.id)).toEqual(['work']);
  });

  it('needs the provider to have a key, and a compatible provider to be at the service’s own address', () => {
    const lmStudio = text('lm', 'openai-compatible', 'http://localhost:1234/v1', { apiKey: 'x' });
    const router = text('router', 'openai-compatible', 'https://openrouter.ai/api/v1', { apiKey: 'x' });
    const keyless = text('none', 'openai-compatible', 'https://openrouter.ai/api/v1');
    expect(keySources(preset('openrouter'), [lmStudio, router, keyless]).map((p) => p.id)).toEqual(['router']);
    expect(keySources(preset('fal'), [router])).toEqual([]);
  });
});

describe('sharing a GPU', () => {
  it('offers local text providers, those on the same computer first', () => {
    const providers = [
      text('cloud', 'anthropic', 'https://api.anthropic.com'),
      text('router', 'openai-compatible', 'https://openrouter.ai/api/v1'),
      text('elsewhere', 'llamacpp', 'http://10.0.0.9:8080'),
      text('ollama', 'ollama', 'http://192.168.20.25:11434'),
    ];
    expect(gpuPartners('http://192.168.20.25:8188', providers).map((p) => [p.provider.id, p.sameHost])).toEqual([
      ['ollama', true],
      ['elsewhere', false],
    ]);
  });

  it('counts every name of this computer as the same one', () => {
    expect(gpuPartners('http://localhost:8188', [text('ollama', 'ollama', 'http://127.0.0.1:11434')])[0]?.sameHost).toBe(true);
  });

  it('copes with an address still being typed', () => {
    expect(gpuPartners('http://', [text('ollama', 'ollama', 'http://127.0.0.1:11434')])[0]?.sameHost).toBe(false);
  });
});
