import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DetectedImageServer, ImageModelInfo, ImageProviderConfig, ProviderStatus, Settings, SettingsPath } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { setPath } from '../../lib/json-path.ts';
import { keys, useLiveQueries } from '../../lib/queries.ts';
import { ImageProvidersPage } from './image-providers-page.tsx';
import { backend, callsTo, emit, resetBackend, snapshot } from './test-backend.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const comfy: ImageProviderConfig = { id: 'comfy', type: 'comfyui', preset: 'comfyui', name: 'ComfyUI', baseUrl: 'http://192.168.20.25:8188', headers: {}, enabled: true, sharesGpuWith: 'ollama' };
const cloud: ImageProviderConfig = { id: 'open', type: 'openai-images', preset: 'openai', name: 'Work images', baseUrl: 'https://api.openai.com', apiKey: '${secret:image-provider-open}', headers: {}, enabled: true };
const status = (providerId: string, extra: Partial<ProviderStatus> = {}): ProviderStatus => ({ providerId, ok: true, latencyMs: 40, modelCount: 3, warnings: [], checkedAt: 1, ...extra });

const imageModel = (providerId: string, modelId: string, extra: Partial<ImageModelInfo> = {}): ImageModelInfo => ({
  ref: `${providerId}/${modelId}`,
  providerId,
  modelId,
  displayName: modelId,
  capabilities: {
    family: 'sdxl',
    promptStyle: 'tags',
    negativePrompt: true,
    sizes: { kind: 'free', min: 256, max: 2048, multiple: 8, base: 1024 },
    maxCount: 4,
    edit: true,
    mask: false,
    maxReferences: 1,
    transparent: false,
    seed: true,
    previews: true,
    tunable: true,
    defaults: { steps: 30, guidance: 5 },
    samplers: ['euler', 'dpmpp_2m_sde'],
    schedulers: ['karras', 'simple'],
  },
  source: 'detected',
  hidden: false,
  favorite: false,
  order: 0,
  ...extra,
});

function LiveQueries() {
  useLiveQueries();
  return null;
}

function pick(option: HTMLElement) {
  // Base UI only accepts mouse clicks that started on the option.
  fireEvent.pointerDown(option, { pointerType: 'mouse' });
  fireEvent.click(option);
}

/** The backend's settings, which each write changes. */
function renderPage(extra: Partial<Settings> = {}, models: ImageModelInfo[] = [], detected: DetectedImageServer[] = []) {
  let settings = snapshot({ providers: [{ id: 'ollama', type: 'ollama', name: 'Ollama', baseUrl: 'http://192.168.20.25:11434', headers: {}, enabled: true }], imageProviders: [comfy, cloud], ...extra });
  resetBackend({
    'app.info': () => ({ imageGeneration: true }),
    'settings.get': () => settings,
    'settings.set': ({ path, value }: { path: SettingsPath; value: unknown }) => {
      settings = { ...settings, effective: setPath(settings.effective, path, value) };
      return { ok: true };
    },
    'settings.reset': () => ({ ok: true }),
    'secrets.list': () => [{ id: 'image-provider-open', label: 'key', kind: 'api_key', masked: '••••3f9a', createdAt: 0, updatedAt: 0, usedBy: [] }],
    'imageProviders.status': () => [status('comfy'), status('open', { ok: false, error: 'The key was refused.' })],
    'imageProviders.detect': () => detected,
    'imageProviders.refresh': () => [],
    'imageProviders.remove': () => ({ ok: true }),
    'imageProviders.save': (draft: ImageProviderConfig) => draft,
    'imageModels.list': () => models,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(keys.settings, settings);
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <LiveQueries />
        <ImageProvidersPage />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('found on this computer', () => {
  it('adds a server in one click, with an id free among text and image providers', async () => {
    renderPage({ imageProviders: [] }, [], [{ preset: 'comfyui', type: 'comfyui', baseUrl: 'http://127.0.0.1:8188', label: 'ComfyUI' }]);
    expect(await screen.findByText('Running at 127.0.0.1:8188')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(callsTo('imageProviders.save')).toEqual([expect.objectContaining({ id: 'comfyui', type: 'comfyui', preset: 'comfyui', baseUrl: 'http://127.0.0.1:8188', enabled: true })]));
  });

  it('says when nothing new is there, and looks again when asked', async () => {
    renderPage();
    expect(await screen.findByText('Nothing new found.')).toBeTruthy();
    backend.handlers['imageProviders.detect'] = () => [{ preset: 'forge', type: 'a1111', baseUrl: 'http://127.0.0.1:7860', label: 'Forge' }];
    fireEvent.click(screen.getByRole('button', { name: 'Scan again' }));
    expect(await screen.findByText('Forge')).toBeTruthy();
  });
});

describe('provider rows', () => {
  it('shows health, model count, what it shares and a masked key', async () => {
    renderPage();
    expect(await screen.findByText('192.168.20.25:8188 · 40 ms · 3 models · Shares a GPU with Ollama')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Connected' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Unreachable' })).toBeTruthy();
    expect(screen.getByText('The key was refused.')).toBeTruthy();
    expect(screen.getByText(/Key ••••3f9a/)).toBeTruthy();
    expect(screen.getByText('OpenAI')).toBeTruthy();
  });

  it('follows the health the backend reports', async () => {
    renderPage();
    await screen.findByRole('img', { name: 'Unreachable' });
    act(() => emit('imageProviders.changed', [status('comfy'), status('open')]));
    await waitFor(() => expect(screen.queryByRole('img', { name: 'Unreachable' })).toBeNull());
  });

  it('turns a provider off and checks it again', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('switch', { name: 'Enable ComfyUI' }));
    await waitFor(() => expect(callsTo('settings.set')).toEqual([{ layer: 'global', path: ['imageProviders', 0, 'enabled'], value: false }]));
    await waitFor(() => expect(callsTo('imageProviders.refresh')).toEqual([{ id: 'comfy' }]));
  });

  it('tests, edits and removes through its menu', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Work images options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Test connection' }));
    await waitFor(() => expect(callsTo('imageProviders.refresh')).toEqual([{ id: 'open' }]));

    fireEvent.click(screen.getByRole('button', { name: 'Work images options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    expect(await screen.findByRole('dialog', { name: 'Edit Work images' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('button', { name: 'Work images options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Remove Work images?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(callsTo('imageProviders.remove')).toEqual([{ id: 'open' }]));
  });

  it('offers workflows on ComfyUI only', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Work images options' }));
    await screen.findByRole('menuitem', { name: 'Edit' });
    expect(screen.queryByRole('menuitem', { name: 'Workflows…' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.click(await screen.findByRole('button', { name: 'ComfyUI options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Workflows…' }));
    expect(await screen.findByRole('dialog', { name: 'Workflows' })).toBeTruthy();
  });

  it('opens the add dialog', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Add image provider' }));
    expect(await screen.findByRole('dialog', { name: 'Add image provider' })).toBeTruthy();
  });
});

describe('image models', () => {
  const models = [imageModel('comfy', 'z-image', { displayName: 'Z-Image Turbo', description: 'Fast, general images', favorite: true }), imageModel('comfy', 'sdxl', { hidden: true })];

  it('points to providers while there are no models', async () => {
    renderPage();
    expect(await screen.findByText('Models appear here once an image provider is connected.')).toBeTruthy();
  });

  it('shows each model by provider with its capabilities and what it’s good at', async () => {
    renderPage({}, models);
    const table = await screen.findByRole('table', { name: 'ComfyUI models' });
    const row = within(table).getByText('Z-Image Turbo').closest<HTMLElement>('[role=row]')!;
    expect(within(row).getByText('z-image')).toBeTruthy();
    expect(within(row).getByText('Fast, general images')).toBeTruthy();
    expect(within(row).getByText('SDXL')).toBeTruthy();
    expect(within(row).getByText('Edits')).toBeTruthy();
    expect(within(row).getByText('Previews')).toBeTruthy();
  });

  it('hides and favorites a model through its override', async () => {
    renderPage({}, models);
    fireEvent.click(await screen.findByRole('switch', { name: 'Show Z-Image Turbo in the model picker' }));
    fireEvent.click(screen.getByRole('button', { name: 'Favorite sdxl' }));
    await waitFor(() =>
      expect(callsTo('settings.set')).toEqual([
        { layer: 'global', path: ['imageModels', 'overrides', 'comfy/z-image', 'hidden'], value: true },
        { layer: 'global', path: ['imageModels', 'overrides', 'comfy/sdxl', 'favorite'], value: true },
      ]),
    );
  });

  it('makes a model the default from the table, and marks it', async () => {
    renderPage({}, models);
    fireEvent.click(await screen.findByRole('button', { name: 'Z-Image Turbo options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Make default' }));
    await waitFor(() => expect(callsTo('settings.set')).toEqual([{ layer: 'global', path: ['models', 'defaults', 'image'], value: 'comfy/z-image' }]));
    expect(await screen.findByText('Default')).toBeTruthy();
  });

  it('warns when the default model has gone, and offers only visible ones', async () => {
    renderPage({ models: { ...snapshot().effective.models, defaults: { image: 'comfy/gone' } } }, models);
    await screen.findByRole('table', { name: 'ComfyUI models' });
    expect(screen.getByText(/no longer available/)).toBeTruthy();
    fireEvent.click(screen.getByRole('combobox', { name: 'Default image model for everyone' }));
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options.some((o) => o?.includes('Z-Image Turbo'))).toBe(true);
    expect(options.some((o) => o?.includes('sdxl'))).toBe(false);
  });

  it('saves what a model is good at and its tuning, with the model’s samplers as choices', async () => {
    renderPage({}, models);
    fireEvent.click(await screen.findByRole('button', { name: 'Z-Image Turbo options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Description and tuning…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Z-Image Turbo' });
    fireEvent.change(within(dialog).getByLabelText('What it’s good at'), { target: { value: 'Posters with text' } });
    expect(within(dialog).getByLabelText<HTMLInputElement>('Steps').placeholder).toBe('30');
    fireEvent.change(within(dialog).getByLabelText('Steps'), { target: { value: '8' } });
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Sampler' }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Automatic', 'euler', 'dpmpp_2m_sde']);
    pick(screen.getByRole('option', { name: 'dpmpp_2m_sde' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(callsTo('settings.set')).toEqual([
        { layer: 'global', path: ['imageModels', 'overrides', 'comfy/z-image', 'description'], value: 'Posters with text' },
        { layer: 'global', path: ['imageModels', 'overrides', 'comfy/z-image', 'tuning'], value: { steps: 8, sampler: 'dpmpp_2m_sde' } },
      ]),
    );
  });

  it('refuses steps out of range', async () => {
    renderPage({}, models);
    fireEvent.click(await screen.findByRole('button', { name: 'sdxl options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Description and tuning…' }));
    const dialog = await screen.findByRole('dialog', { name: 'sdxl' });
    fireEvent.change(within(dialog).getByLabelText('Steps'), { target: { value: '900' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Enter a whole number from 1 to 200.')).toBeTruthy();
    expect(callsTo('settings.set')).toEqual([]);
  });

  it('clears an override left empty', async () => {
    renderPage({ imageModels: { overrides: { 'comfy/z-image': { description: 'Old text' } } } }, models);
    fireEvent.click(await screen.findByRole('button', { name: 'Z-Image Turbo options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Description and tuning…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Z-Image Turbo' });
    fireEvent.change(within(dialog).getByLabelText('What it’s good at'), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(callsTo('settings.reset')).toEqual([{ layer: 'global', path: ['imageModels', 'overrides', 'comfy/z-image', 'description'] }]));
  });

  it('keeps the tuning out for a model that takes none', async () => {
    const hosted = imageModel('open', 'gpt-image-2', { capabilities: { ...imageModel('open', 'x').capabilities, tunable: false } });
    renderPage({}, [hosted]);
    fireEvent.click(await screen.findByRole('button', { name: 'gpt-image-2 options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Description and tuning…' }));
    const dialog = await screen.findByRole('dialog', { name: 'gpt-image-2' });
    expect(within(dialog).queryByLabelText('Steps')).toBeNull();
  });

  it('searches a long list', async () => {
    renderPage({}, Array.from({ length: 12 }, (_, i) => imageModel('comfy', `model-${i}`)));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Search ComfyUI models' }), { target: { value: 'model-11' } });
    const table = screen.getByRole('table', { name: 'ComfyUI models' });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
  });
});

describe('image generation limits', () => {
  it('turns it off', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('switch', { name: 'Let models make images' }));
    await waitFor(() => expect(callsTo('settings.set')).toEqual([{ layer: 'global', path: ['imageGeneration', 'enabled'], value: false }]));
  });

  it('saves a limit, and an optional one goes when emptied', async () => {
    renderPage({ imageGeneration: { enabled: true, maxImagesPerTurn: 8, maxImagesPerUserPerDay: 20 } });
    const perDay = await screen.findByRole('textbox', { name: 'Images per person per day' });
    expect((perDay as HTMLInputElement).value).toBe('20');
    fireEvent.focus(perDay);
    fireEvent.change(perDay, { target: { value: '' } });
    fireEvent.blur(perDay);
    await waitFor(() => expect(callsTo('settings.reset')).toEqual([{ layer: 'global', path: ['imageGeneration', 'maxImagesPerUserPerDay'] }]));

    const spend = screen.getByRole('textbox', { name: 'Spend per person per day' });
    fireEvent.focus(spend);
    fireEvent.change(spend, { target: { value: '2.50' } });
    fireEvent.blur(spend);
    await waitFor(() => expect(callsTo('settings.set')).toEqual([{ layer: 'global', path: ['imageGeneration', 'maxSpendPerUserPerDayUsd'], value: 2.5 }]));
  });

  it('refuses a limit out of range, and images per turn can’t be emptied', async () => {
    renderPage();
    const perTurn = await screen.findByRole('textbox', { name: 'Images per turn' });
    fireEvent.focus(perTurn);
    fireEvent.change(perTurn, { target: { value: '500' } });
    fireEvent.blur(perTurn);
    expect(await screen.findByText('Enter a whole number from 1 to 100.')).toBeTruthy();
    fireEvent.focus(perTurn);
    fireEvent.change(perTurn, { target: { value: '' } });
    fireEvent.blur(perTurn);
    await waitFor(() => expect(screen.getByText('Enter a whole number from 1 to 100.')).toBeTruthy());
    expect(callsTo('settings.set')).toEqual([]);
    expect(callsTo('settings.reset')).toEqual([]);
  });
});
