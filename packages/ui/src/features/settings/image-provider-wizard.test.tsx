import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ImageModelInfo, ImageProviderConfig, ProviderConfig, ProviderStatus } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { keys } from '../../lib/queries.ts';
import { ImageProviderWizard } from './image-provider-wizard.tsx';
import { backend, callsTo, resetBackend, snapshot } from './test-backend.ts';

const platform = vi.hoisted(() => ({ openExternal: vi.fn() }));
vi.mock('../../lib/platform.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), openExternal: platform.openExternal }));
vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const ok: ProviderStatus = { providerId: 'x', ok: true, latencyMs: 12, modelCount: 2, warnings: [], checkedAt: 1 };

export function imageModel(modelId: string, extra: Partial<ImageModelInfo> = {}): ImageModelInfo {
  return {
    ref: `comfyui/${modelId}`,
    providerId: 'comfyui',
    modelId,
    displayName: modelId,
    capabilities: { family: 'sdxl', promptStyle: 'tags', negativePrompt: true, sizes: { kind: 'free', min: 256, max: 2048, multiple: 8, base: 1024 }, maxCount: 4, edit: false, mask: false, maxReferences: 0, transparent: false, seed: true, previews: true, tunable: true },
    source: 'detected',
    hidden: false,
    favorite: false,
    order: 0,
    ...extra,
  };
}

const text = (id: string, type: ProviderConfig['type'], baseUrl: string, extra: Partial<ProviderConfig> = {}): ProviderConfig => ({ id, type, name: id, baseUrl, headers: {}, enabled: true, ...extra });

function setup({ providers = [], imageProviders = [], existing }: { providers?: ProviderConfig[]; imageProviders?: ImageProviderConfig[]; existing?: ImageProviderConfig } = {}) {
  resetBackend({
    'settings.get': () => snapshot({ providers, imageProviders }),
    'secrets.list': () => [],
    'settings.set': () => ({ ok: true }),
    'imageProviders.test': () => ({ status: ok, models: [imageModel('sdxl'), imageModel('z-image')] }),
    'imageProviders.tryImage': () => ({ blob: 'a'.repeat(64), mime: 'image/png', width: 512, height: 512, durationMs: 14_200 }),
    'imageProviders.save': (draft: ImageProviderConfig) => draft,
  });
  const onOpenChange = vi.fn();
  // Settings are there by the time the page's Add button is pressed.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(keys.settings, snapshot({ providers, imageProviders }));
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ImageProviderWizard open onOpenChange={onOpenChange} {...(existing ? { existing } : {})} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

function pick(option: HTMLElement) {
  // Base UI only accepts mouse clicks that started on the option.
  fireEvent.pointerDown(option, { pointerType: 'mouse' });
  fireEvent.click(option);
}

const choose = async (service: string) => fireEvent.click(await screen.findByRole('button', { name: service }));
const test = () => fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));

describe('choosing a service', () => {
  it('groups the services as Local, Cloud, Aggregators and Custom', async () => {
    setup();
    const local = await screen.findByRole('region', { name: 'Local' });
    expect(within(local).getByRole('button', { name: 'ComfyUI' })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Cloud' })).getByRole('button', { name: 'OpenAI' })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Aggregators' })).getByRole('button', { name: 'fal.ai' })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Custom' })).getByRole('button', { name: 'OpenAI-compatible images' })).toBeTruthy();
  });

  it('shows how to start a server, and asks no key of it', async () => {
    setup();
    await choose('Forge');
    expect(screen.getByText('Start it with --api. Forge Neo and reForge work the same way.')).toBeTruthy();
    expect(screen.queryByText('API key')).toBeNull();
    expect((screen.getByLabelText('Base URL') as HTMLInputElement).value).toBe('http://127.0.0.1:7860');
  });

  it('avoids the id of a text provider', async () => {
    setup({ providers: [text('openai', 'openai', 'https://api.openai.com')] });
    await choose('OpenAI');
    expect((screen.getByLabelText('ID') as HTMLInputElement).value).toBe('openai-2');
  });
});

describe('the key', () => {
  it('links to where a key comes from, and won’t add the provider without one', async () => {
    setup();
    await choose('OpenAI');
    fireEvent.click(screen.getByRole('button', { name: 'Get a key' }));
    expect(platform.openExternal).toHaveBeenCalledWith('https://platform.openai.com/api-keys');
    save();
    expect(await screen.findByText('OpenAI needs an API key.')).toBeTruthy();
    expect(callsTo('imageProviders.save')).toEqual([]);
  });

  it('uses the key of a text provider without anyone pasting it', async () => {
    setup({ providers: [text('work', 'openai', 'https://api.openai.com', { name: 'Work OpenAI', apiKey: '${secret:provider-work}' })] });
    await choose('OpenAI');
    fireEvent.click(screen.getByRole('button', { name: 'Use the key from Work OpenAI' }));
    expect(screen.getByText('The key from Work OpenAI')).toBeTruthy();
    save();
    await waitFor(() => expect(callsTo('imageProviders.save')[0]).toMatchObject({ apiKeyFromProvider: 'work', preset: 'openai', type: 'openai-images' }));
    expect(callsTo('imageProviders.save')[0]).not.toHaveProperty('apiKey');
  });

  it('can go back to typing one', async () => {
    setup({ providers: [text('work', 'openai', 'https://api.openai.com', { apiKey: '${secret:provider-work}' })] });
    await choose('OpenAI');
    fireEvent.click(screen.getByRole('button', { name: 'Use the key from work' }));
    fireEvent.click(screen.getByRole('button', { name: 'Enter a key' }));
    expect(screen.getByPlaceholderText('Paste your API key')).toBeTruthy();
  });
});

describe('typed-in models', () => {
  it('starts from the suggestions, and adds and removes ids', async () => {
    setup();
    await choose('fal.ai');
    fireEvent.change(screen.getByPlaceholderText('Paste your API key'), { target: { value: 'k' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove fal-ai/flux-2/pro' }));
    const field = screen.getByRole('textbox', { name: 'Model id to add' });
    fireEvent.change(field, { target: { value: 'fal-ai/recraft-v3' } });
    // Enter adds to the list; it must not save the provider.
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(callsTo('imageProviders.save')).toEqual([]);
    save();
    await waitFor(() => expect(callsTo('imageProviders.save')[0]).toMatchObject({ models: ['fal-ai/flux/schnell', 'fal-ai/recraft-v3'] }));
  });

  it('isn’t offered for a service that lists its own', async () => {
    setup();
    await choose('ComfyUI');
    expect(screen.queryByRole('textbox', { name: 'Model id to add' })).toBeNull();
  });
});

describe('a local server’s GPU', () => {
  it('offers text providers on the same computer first, says the text model reloads, and saves the choice', async () => {
    setup({ providers: [text('far', 'ollama', 'http://10.0.0.2:11434'), text('near', 'ollama', 'http://127.0.0.1:11434'), text('cloud', 'anthropic', 'https://api.anthropic.com')] });
    await choose('ComfyUI');
    const gpu = screen.getByRole('region', { name: 'GPU' });
    fireEvent.click(within(gpu).getByRole('combobox', { name: 'Shares a GPU with' }));
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Nothing else', 'near · same computer', 'far']);
    pick(options[1]!);
    expect(await screen.findByText(/reloads afterwards/)).toBeTruthy();
    fireEvent.click(within(gpu).getByRole('switch', { name: 'Unload after each image' }));
    save();
    await waitFor(() => expect(callsTo('imageProviders.save')[0]).toMatchObject({ sharesGpuWith: 'near', freeAfterRun: true }));
  });

  it('is not offered for a cloud service', async () => {
    setup({ providers: [text('near', 'ollama', 'http://127.0.0.1:11434')] });
    await choose('Stability AI');
    expect(screen.queryByRole('region', { name: 'GPU' })).toBeNull();
  });
});

describe('testing', () => {
  it('shows health and models, and makes an image only when asked', async () => {
    setup();
    await choose('ComfyUI');
    test();
    expect(await screen.findByText('Connected · 2 models · 12 ms')).toBeTruthy();
    expect(callsTo('imageProviders.tryImage')).toEqual([]);
    expect(screen.getByText(/Makes one small image/)).toBeTruthy();

    const section = screen.getByRole('region', { name: 'Test image' });
    fireEvent.click(within(section).getByRole('combobox', { name: 'Model' }));
    pick((await screen.findAllByRole('option')).at(-1)!);
    fireEvent.click(within(section).getByRole('button', { name: 'Make a test image' }));
    expect(await screen.findByText('Made in 14 s · 512×512')).toBeTruthy();
    expect(within(section).getByRole<HTMLImageElement>('img').src).toContain('aaaa');
    expect(callsTo('imageProviders.tryImage')).toEqual([expect.objectContaining({ modelId: 'z-image', draft: expect.objectContaining({ id: 'comfyui' }) })]);
  });

  it('says a paid service’s test is a real request that may cost money', async () => {
    setup();
    await choose('Black Forest Labs');
    fireEvent.change(screen.getByPlaceholderText('Paste your API key'), { target: { value: 'k' } });
    test();
    const button = await screen.findByRole('button', { name: 'Make a test image' });
    expect(document.getElementById(button.getAttribute('aria-describedby')!)!.textContent).toBe('This is a real request to Black Forest Labs and may cost money.');
  });

  it('shows why a test image failed, and what changed drops the old result', async () => {
    setup();
    backend.handlers['imageProviders.tryImage'] = () => {
      throw new Error('Missing model foo.safetensors');
    };
    await choose('ComfyUI');
    test();
    fireEvent.click(await screen.findByRole('button', { name: 'Make a test image' }));
    expect(await screen.findByText('Missing model foo.safetensors')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'http://127.0.0.1:9999' } });
    expect(screen.queryByText('Missing model foo.safetensors')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Make a test image' })).toBeNull();
  });

  it('offers no test image when the connection failed', async () => {
    setup();
    backend.handlers['imageProviders.test'] = () => ({ status: { ...ok, ok: false, error: 'Nothing answers there.' }, models: [] });
    await choose('ComfyUI');
    test();
    expect(await screen.findByText('Nothing answers there.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Make a test image' })).toBeNull();
  });
});

describe('models on a server with other accounts', () => {
  it('lets an admin hide a model the test found before saving', async () => {
    setup();
    await choose('ComfyUI');
    test();
    fireEvent.click(await screen.findByRole('switch', { name: 'Show sdxl to everyone' }));
    save();
    await waitFor(() => expect(callsTo('settings.set')).toEqual([{ layer: 'global', path: ['imageModels', 'overrides', 'comfyui/sdxl', 'hidden'], value: true }]));
    expect(callsTo('imageProviders.save')).toHaveLength(1);
  });
});

describe('editing', () => {
  const existing: ImageProviderConfig = { id: 'comfy', type: 'comfyui', preset: 'comfyui', name: 'ComfyUI', baseUrl: 'http://192.168.20.25:8188', headers: {}, enabled: true, parallelRequests: 1, freeAfterRun: true, workflows: [] };

  it('starts on the form with the id fixed, and keeps what the form doesn’t show', async () => {
    const { onOpenChange } = setup({ imageProviders: [existing], existing });
    expect((await screen.findByLabelText('Requests at once') as HTMLInputElement).value).toBe('1');
    expect((screen.getByLabelText('ID') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(callsTo('imageProviders.save')[0]).toMatchObject({ id: 'comfy', freeAfterRun: true, workflows: [] });
  });
});
