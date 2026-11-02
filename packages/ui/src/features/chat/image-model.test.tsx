import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { defaultSettings, defaultUserPrefs, type ImageModelInfo, type SessionSummary, type Settings } from '@atelier/protocol';
import { backend, callsTo, model, resetBackend, snapshot } from '../settings/test-backend.ts';
import { Composer } from './composer.tsx';
import { useNewImageModel, useSessionImageModel } from './image-model.ts';
import { keys, useImagesOffered } from '../../lib/queries.ts';
import type { Attachments } from './use-attachments.ts';

vi.mock('@tanstack/react-router', async (importOriginal) => ({ ...(await importOriginal<object>()), useNavigate: () => vi.fn() }));
vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const attachments: Attachments = { items: [], quotes: [], addQuote: () => {}, removeQuote: () => {}, add: async () => {}, remove: () => {}, clear: () => {}, restore: () => {}, uploading: false, parts: () => [] };

const imageModel = (providerId: string, modelId: string, extra: Partial<ImageModelInfo> = {}) => ({ ref: `${providerId}/${modelId}`, providerId, modelId, displayName: modelId, hidden: false, favorite: false, order: 0, ...extra });
const session = { id: 's1', imageModel: undefined } as unknown as SessionSummary;

const MODELS = [imageModel('comfy', 'z-image', { displayName: 'Z-Image Turbo', description: 'Fast, general images' }), imageModel('comfy', 'sdxl', { hidden: true }), imageModel('cloud', 'gpt-image-2', { displayName: 'GPT Image' })];

function setup(models: ReturnType<typeof imageModel>[], extra: Partial<Settings> = {}, prefs = defaultUserPrefs()) {
  resetBackend({
    'app.info': () => ({ imageGeneration: true }),
    'imageModels.list': () => models,
    'prefs.get': () => prefs,
    'settings.get': () =>
      snapshot({
        imageProviders: [
          { id: 'comfy', type: 'comfyui', name: 'ComfyUI', baseUrl: 'http://127.0.0.1:8188', headers: {}, enabled: true },
          { id: 'cloud', type: 'openai-images', name: 'OpenAI', baseUrl: 'https://api.openai.com', headers: {}, enabled: true },
        ],
        ...extra,
      }),
    'sessions.update': () => ({}),
    'slash.list': () => [],
  });
}

/** A conversation's message box, wired the way its page wires it. */
function SessionBox({ of }: { of: SessionSummary }) {
  const imageModel = useSessionImageModel(of);
  return <Composer variant="reply" attachments={attachments} model={model('fake', 'm')} streaming={false} onSubmit={() => {}} imageModel={imageModel} />;
}

function NewBox({ onChosen }: { onChosen(ref: string | null): void }) {
  const imageModel = useNewImageModel();
  return (
    <>
      <Composer variant="new" attachments={attachments} model={model('fake', 'm')} streaming={false} onSubmit={() => {}} imageModel={imageModel} />
      <button type="button" onClick={() => onChosen(imageModel?.ref ?? null)}>
        Start
      </button>
    </>
  );
}

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });

async function openRow() {
  fireEvent.click(screen.getByRole('button', { name: 'Add files and more' }));
  const row = await screen.findByRole('menuitem', { name: /Image model/ });
  fireEvent.click(row);
  return row;
}

describe('the + menu’s image model', () => {
  it('lists the visible models by provider, with Default first naming what it comes to', async () => {
    setup(MODELS, { models: { ...defaultSettings().models, defaults: { image: 'cloud/gpt-image-2' } } });
    render(<QueryClientProvider client={client()}><SessionBox of={session} /></QueryClientProvider>);
    await waitFor(() => expect(callsTo('imageModels.list')).toHaveLength(1));
    await openRow();
    const radios = await screen.findAllByRole('menuitemradio');
    expect(radios.map((r) => r.textContent)).toEqual(['DefaultGPT Image', 'Z-Image TurboFast, general images', 'GPT Image']);
    expect(radios[0]!.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('ComfyUI')).toBeTruthy();
    expect(screen.getByText('OpenAI')).toBeTruthy();
  });

  it('puts a person’s own default ahead of the server’s', async () => {
    const prefs = defaultUserPrefs();
    prefs.models.image = 'comfy/z-image';
    setup(MODELS, { models: { ...defaultSettings().models, defaults: { image: 'cloud/gpt-image-2' } } }, prefs);
    render(<QueryClientProvider client={client()}><SessionBox of={session} /></QueryClientProvider>);
    await waitFor(() => expect(callsTo('imageModels.list')).toHaveLength(1));
    await openRow();
    expect((await screen.findAllByRole('menuitemradio'))[0]!.textContent).toBe('DefaultZ-Image Turbo');
  });

  it('saves a choice on the conversation', async () => {
    setup(MODELS);
    render(<QueryClientProvider client={client()}><SessionBox of={session} /></QueryClientProvider>);
    await waitFor(() => expect(callsTo('imageModels.list')).toHaveLength(1));
    await openRow();
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /^Z-Image Turbo/ }));
    await waitFor(() => expect(callsTo('sessions.update')).toEqual([{ id: 's1', imageModel: 'comfy/z-image' }]));
  });

  it('marks the choice, and Default clears it', async () => {
    setup(MODELS);
    render(<QueryClientProvider client={client()}><SessionBox of={{ ...session, imageModel: 'cloud/gpt-image-2' }} /></QueryClientProvider>);
    await waitFor(() => expect(callsTo('imageModels.list')).toHaveLength(1));
    await openRow();
    const chosen = await screen.findByRole('menuitemradio', { name: 'GPT Image' });
    expect(chosen.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Default/ }));
    await waitFor(() => expect(callsTo('sessions.update')).toEqual([{ id: 's1', imageModel: null }]));
  });

  it('counts a model that has gone as Default', async () => {
    setup(MODELS);
    render(<QueryClientProvider client={client()}><SessionBox of={{ ...session, imageModel: 'gone/old' }} /></QueryClientProvider>);
    await waitFor(() => expect(callsTo('imageModels.list')).toHaveLength(1));
    await openRow();
    expect((await screen.findByRole('menuitemradio', { name: /^Default/ })).getAttribute('aria-checked')).toBe('true');
  });

  it('keeps a new conversation’s choice until it starts', async () => {
    setup(MODELS);
    const onChosen = vi.fn();
    render(<QueryClientProvider client={client()}><NewBox onChosen={onChosen} /></QueryClientProvider>);
    await waitFor(() => expect(callsTo('imageModels.list')).toHaveLength(1));
    await openRow();
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'GPT Image' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start', hidden: true }));
    expect(onChosen).toHaveBeenCalledWith('cloud/gpt-image-2');
    expect(callsTo('sessions.update')).toEqual([]);
  });
});

describe('when the row shows', () => {
  async function menuItems() {
    await waitFor(() => expect(callsTo('prefs.get').length + callsTo('app.info').length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    fireEvent.click(screen.getByRole('button', { name: 'Add files and more' }));
    return within(await screen.findByRole('menu')).getAllByRole('menuitem');
  }

  it('needs two models to choose between', async () => {
    setup([imageModel('comfy', 'z-image')]);
    render(<QueryClientProvider client={client()}><SessionBox of={session} /></QueryClientProvider>);
    expect((await menuItems()).map((i) => i.textContent)).not.toContainEqual(expect.stringContaining('Image model'));
  });

  it('doesn’t count hidden models', async () => {
    setup([imageModel('comfy', 'z-image'), imageModel('comfy', 'sdxl', { hidden: true })]);
    render(<QueryClientProvider client={client()}><SessionBox of={session} /></QueryClientProvider>);
    expect((await menuItems()).map((i) => i.textContent)).not.toContainEqual(expect.stringContaining('Image model'));
  });

  it('goes when an admin turns image generation off', async () => {
    setup(MODELS, { imageGeneration: { enabled: false, maxImagesPerTurn: 8 } });
    render(<QueryClientProvider client={client()}><SessionBox of={session} /></QueryClientProvider>);
    expect((await menuItems()).map((i) => i.textContent)).not.toContainEqual(expect.stringContaining('Image model'));
  });

  it('isn’t on an older server, which isn’t asked for image models', async () => {
    setup(MODELS);
    backend.handlers['app.info'] = () => ({});
    render(<QueryClientProvider client={client()}><SessionBox of={session} /></QueryClientProvider>);
    expect((await menuItems()).map((i) => i.textContent)).not.toContainEqual(expect.stringContaining('Image model'));
    expect(callsTo('imageModels.list')).toEqual([]);
  });
});

describe('an older server’s settings', () => {
  // While a server updates, the app can hear the new server's capabilities before its settings, which then still lack
  // every image setting: a desktop crashed on exactly that in 0.3.0.
  it('never breaks the window while a server updates under it', async () => {
    resetBackend({
      'app.info': () => ({ imageGeneration: true }),
      'imageModels.list': () => MODELS,
      'prefs.get': () => defaultUserPrefs(),
      'generatedImages.list': () => ({ items: [], next: null, totalBytes: 0 }),
      'settings.get': () => {
        const old = snapshot();
        const effective = old.effective as Partial<Settings>;
        delete effective.imageGeneration;
        delete effective.imageProviders;
        delete effective.imageModels;
        delete effective.imagePricing;
        return old;
      },
      'slash.list': () => [],
    });
    function Probe() {
      const offered = useImagesOffered();
      const choice = useSessionImageModel(session);
      return <p>{`offered ${offered}, choice ${choice ? 'shown' : 'hidden'}`}</p>;
    }
    const qc = client();
    // Held in the app's cache as it is, not as an answer parsed again, which would fill in the defaults.
    const old = snapshot();
    for (const key of ['imageGeneration', 'imageProviders', 'imageModels', 'imagePricing'] as const) delete (old.effective as Partial<Settings>)[key];
    qc.setQueryData(keys.settings, old);
    qc.setQueryData(keys.appInfo, { imageGeneration: true });
    qc.setQueryData(keys.imageModels, MODELS);
    render(<QueryClientProvider client={qc}><Probe /><SessionBox of={session} /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText(/^offered (true|false), choice hidden$/)).toBeTruthy());
  });
});
