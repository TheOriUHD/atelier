import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_LENDING, type DeviceLending, type ImageModelInfo, type PersonalImageProvider } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { queryClient } from '../../lib/queries.ts';
import { PersonalImageServers } from './personal-image-servers.tsx';
import { imageModelGroups, imageModelSubtitle } from '../chat/image-model.ts';
import { PersonalModelsPage } from './personal-models-page.tsx';
import { SystemPage } from './system-page.tsx';
import { backend, callsTo, resetBackend, snapshot } from './test-backend.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});
const platform = vi.hoisted(() => ({ desktop: undefined as unknown }));
vi.mock('../../lib/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get desktop() {
    return platform.desktop;
  },
}));

const server = (extra: Partial<PersonalImageProvider> = {}): PersonalImageProvider => ({
  id: 'u-0123456789',
  type: 'comfyui',
  preset: 'comfyui',
  name: 'My ComfyUI',
  baseUrl: 'http://127.0.0.1:8188',
  enabled: true,
  deviceId: 'd-mac',
  deviceName: 'MacBook',
  online: true,
  hasKey: false,
  status: { providerId: 'u-0123456789', ok: true, latencyMs: 4, modelCount: 3, warnings: [], checkedAt: 1 },
  createdAt: 1,
  ...extra,
});

const INFO = { name: 'Atelier', version: '0.3.0', surface: 'web', platform: 'linux', dataDir: '/data', imageGeneration: true, deviceLink: { protocol: 2, services: ['runner', 'http', 'ws'] } };
const HERE = { id: 'd-mac', name: 'MacBook', platform: 'darwin', createdAt: 0, lastSeenAt: 0, current: true, online: true, services: ['runner', 'http', 'ws'] };

let allowed: DeviceLending | null;
const change = vi.fn(async (c: { kind: string; id?: string; baseUrl?: string; allowed: boolean }) => {
  if (!allowed) return null;
  const others = allowed.http.filter((a) => a.id !== c.id);
  allowed = { ...allowed, http: c.allowed ? [...others, { id: c.id!, baseUrl: c.baseUrl! }] : others };
  return allowed;
});

function show(node: React.ReactNode) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>,
  );
}

/** A desktop app signed in to a server, its `lending.json` in `allowed`. */
function onDesktop() {
  platform.desktop = {
    device: { id: 'd-mac' },
    connection: { get: async () => ({ mode: 'server', serverUrl: 'https://atelier.example.com' }) },
    lending: { get: async () => allowed, change },
    updates: { status: async () => ({ version: '0.3.0', channel: 'stable', automatic: true, state: { kind: 'idle' }, checkedAt: null }), onStatus: () => () => {} },
    system: { get: async () => ({ openAtLogin: false, dataFolder: '/Users/ada/.atelier/data' }) },
  };
}

const backendWith = (handlers: Record<string, (input: never) => unknown>) =>
  resetBackend({
    'app.info': () => INFO,
    'account.devices': () => [HERE],
    'settings.get': () => snapshot(),
    'personalProviders.list': () => [],
    'personalProviders.detect': () => [],
    'personalImageProviders.list': () => [],
    'personalImageProviders.detect': () => [],
    ...handlers,
  });

/** Opens the dialog, once the app knows this computer can add one. */
async function openAdd() {
  const button = (await screen.findByRole('button', { name: 'Add server' })) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
}

const addedAddress = () => (change.mock.calls.find(([c]) => c.allowed)?.[0] as { id: string; baseUrl: string });

beforeEach(() => {
  allowed = { ...NO_LENDING };
  change.mockClear();
  queryClient.clear();
  platform.desktop = undefined;
  backendWith({});
});

describe('image servers on your computers', () => {
  it('lists the person’s own with their computer and whether it is connected, and leaves adding them to that computer', async () => {
    backendWith({
      'personalImageProviders.list': () => [server(), server({ id: 'u-9876543210', name: 'Studio', type: 'a1111', preset: 'forge', baseUrl: 'http://127.0.0.1:7860', deviceName: 'Desktop', online: false, status: undefined })],
    });
    show(<PersonalImageServers here={undefined} />);
    const comfy = (await screen.findByText('My ComfyUI')).closest('div.flex.min-h-14') as HTMLElement;
    expect(within(comfy).getByText(/On MacBook · 127.0.0.1:8188 · 3 models/)).toBeTruthy();
    expect(within(comfy).getByRole('img', { name: 'Connected' })).toBeTruthy();
    const studio = screen.getByText('Studio').closest('div.flex.min-h-14') as HTMLElement;
    expect(within(studio).getByText(/On Desktop · 127.0.0.1:7860 · Not connected/)).toBeTruthy();
    expect(within(studio).getByText('Forge')).toBeTruthy();
    // A browser has no computer of its own to add one from.
    expect((screen.getByRole('button', { name: 'Add server' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Open the desktop app on the computer that runs them/)).toBeTruthy();
    expect(screen.queryByText('Servers found on this computer')).toBeNull();
  });

  it('shows none of this on a server that doesn’t take image servers from computers', async () => {
    for (const info of [{ ...INFO, imageGeneration: undefined }, { ...INFO, deviceLink: { protocol: 2, services: ['runner', 'http'] } }, { ...INFO, deviceLink: undefined }]) {
      backendWith({ 'app.info': () => info });
      const { unmount } = render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <TooltipProvider>
            <PersonalImageServers here={undefined} />
          </TooltipProvider>
        </QueryClientProvider>,
      );
      await waitFor(() => expect(callsTo('app.info').length).toBeGreaterThan(0));
      await new Promise((r) => setTimeout(r, 10));
      expect(screen.queryByText('Image and sound servers on your computers')).toBeNull();
      expect(callsTo('personalImageProviders.list')).toEqual([]);
      unmount();
    }
  });

  it('sits on Your models, below the model servers', async () => {
    show(<PersonalModelsPage />);
    expect(await screen.findByRole('heading', { name: 'Image and sound servers on your computers' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Models on your computers' })).toBeTruthy();
  });

  it('lends the address of one it found here, checks it through this computer, then saves it', async () => {
    onDesktop();
    backendWith({
      'personalImageProviders.detect': () => [{ preset: 'comfyui', type: 'comfyui', baseUrl: 'http://127.0.0.1:8188', label: 'ComfyUI' }],
      'personalImageProviders.test': () => ({ status: { ok: true }, models: [] }),
      'personalImageProviders.save': () => server(),
    });
    show(<PersonalImageServers here="d-mac" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }));
    await waitFor(() => expect(callsTo('personalImageProviders.save')).toHaveLength(1));
    const lent = addedAddress();
    expect(lent).toMatchObject({ kind: 'http', baseUrl: 'http://127.0.0.1:8188', allowed: true });
    expect(lent.id).toMatch(/^u-[a-z0-9]{10}$/);
    expect(callsTo('personalImageProviders.test')).toEqual([{ id: lent.id, type: 'comfyui', preset: 'comfyui', name: 'ComfyUI', baseUrl: 'http://127.0.0.1:8188' }]);
    expect(backend.calls.map((c) => c.method).indexOf('personalImageProviders.test')).toBeLessThan(backend.calls.map((c) => c.method).indexOf('personalImageProviders.save'));
    expect(allowed?.http).toEqual([{ id: lent.id, baseUrl: 'http://127.0.0.1:8188' }]);
  });

  it('takes the address back when the server doesn’t answer, or saving fails', async () => {
    onDesktop();
    backendWith({
      'personalImageProviders.detect': () => [{ preset: 'comfyui', type: 'comfyui', baseUrl: 'http://127.0.0.1:8188', label: 'ComfyUI' }],
      'personalImageProviders.test': () => ({ status: { ok: false, error: 'Nothing answers there.' }, models: [] }),
    });
    show(<PersonalImageServers here="d-mac" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }));
    await waitFor(() => expect(change).toHaveBeenCalledTimes(2));
    expect(change.mock.calls[1]![0]).toEqual({ kind: 'http', id: addedAddress().id, allowed: false });
    expect(allowed?.http).toEqual([]);
    expect(callsTo('personalImageProviders.save')).toEqual([]);
  });

  it('adds one by hand from the local servers, saying what went wrong in the dialog', async () => {
    onDesktop();
    let works = false;
    backendWith({
      'personalImageProviders.test': () => {
        if (!works) throw new Error('Nothing answers there.');
        return { status: { ok: true }, models: [] };
      },
      'personalImageProviders.save': () => server({ name: 'Studio' }),
    });
    show(<PersonalImageServers here="d-mac" />);
    await openAdd();
    const dialog = await screen.findByRole('dialog', { name: 'Add server' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: 'Studio' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Address' }), { target: { value: 'ftp://studio.local' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(change).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Address' }), { target: { value: 'http://studio.local:8188/' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('Nothing answers there.'));
    await waitFor(() => expect(allowed?.http).toEqual([]));

    works = true;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(callsTo('personalImageProviders.save')).toHaveLength(1));
    expect(callsTo('personalImageProviders.save')[0]).toMatchObject({ type: 'comfyui', preset: 'comfyui', name: 'Studio', baseUrl: 'http://studio.local:8188' });
    expect(allowed?.http[0]?.baseUrl).toBe('http://studio.local:8188');
  });

  it('offers the servers that run on a computer, not cloud services', async () => {
    onDesktop();
    show(<PersonalImageServers here="d-mac" />);
    await openAdd();
    const dialog = await screen.findByRole('dialog', { name: 'Add server' });
    fireEvent.click(within(dialog).getByRole('combobox'));
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toEqual(expect.arrayContaining(['ComfyUI', 'Forge', 'SwarmUI', 'InvokeAI', 'stable-diffusion.cpp', 'OpenAI-compatible images']));
    expect(options).not.toContain('OpenAI');
    expect(options).not.toContain('Replicate');
  });

  it('stops lending the address when one from this computer is removed; another computer’s stays its own business', async () => {
    onDesktop();
    allowed = { ...NO_LENDING, http: [{ id: 'u-0123456789', baseUrl: 'http://127.0.0.1:8188' }] };
    backendWith({ 'personalImageProviders.list': () => [server()], 'personalImageProviders.remove': () => ({ ok: true }) });
    show(<PersonalImageServers here="d-mac" />);
    fireEvent.click(await screen.findByRole('button', { name: 'My ComfyUI options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(change).toHaveBeenCalledWith({ kind: 'http', id: 'u-0123456789', allowed: false }));
    expect(callsTo('personalImageProviders.remove')).toEqual([{ id: 'u-0123456789' }]);
  });
});

describe('what this computer lends, in Settings › System', () => {
  it('names image servers, and takes their address back', async () => {
    onDesktop();
    allowed = {
      ...NO_LENDING,
      http: [
        { id: 'u-0123456789', baseUrl: 'http://127.0.0.1:8188' },
        { id: 'connector', baseUrl: 'http://127.0.0.1:9000' },
      ],
    };
    backendWith({ 'personalImageProviders.list': () => [server()] });
    show(<SystemPage />);
    const section = (await screen.findByRole('heading', { name: 'What atelier.example.com can do here' })).closest('section')!;
    await waitFor(() => expect(within(section).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['My ComfyUI · http://127.0.0.1:8188Remove', 'http://127.0.0.1:9000Remove']));
    fireEvent.click(within(section).getAllByRole('button', { name: 'Remove' })[0]!);
    await waitFor(() => expect(change).toHaveBeenCalledWith({ kind: 'http', id: 'u-0123456789', allowed: false }));
  });

  it('lists addresses as they are on a server without image servers', async () => {
    onDesktop();
    allowed = { ...NO_LENDING, http: [{ id: 'ollama', baseUrl: 'http://127.0.0.1:11434' }] };
    backendWith({ 'app.info': () => ({ ...INFO, imageGeneration: undefined, deviceLink: { protocol: 2, services: ['runner', 'http'] } }), 'account.devices': () => [{ ...HERE, services: ['runner', 'http'] }] });
    show(<SystemPage />);
    const section = (await screen.findByRole('heading', { name: 'What atelier.example.com can do here' })).closest('section')!;
    await waitFor(() => expect(within(section).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['http://127.0.0.1:11434Remove']));
    expect(callsTo('personalImageProviders.list')).toEqual([]);
  });
});

describe('image models for a picker', () => {
  const model = (providerId: string, modelId: string, extra: Partial<ImageModelInfo> = {}): ImageModelInfo => ({
    ref: `${providerId}/${modelId}`,
    providerId,
    modelId,
    displayName: modelId,
    capabilities: { family: 'sdxl', promptStyle: 'tags', negativePrompt: true, sizes: { kind: 'fixed', list: [{ width: 1024, height: 1024 }] }, maxCount: 1, edit: false, mask: false, maxReferences: 0, transparent: false, seed: true, previews: false, tunable: false },
    source: 'detected',
    hidden: false,
    favorite: false,
    order: 0,
    ...extra,
  });

  it('groups the person’s own under their computer, and marks one that’s away', () => {
    const groups = imageModelGroups(
      [
        model('openai', 'gpt-image-1'),
        model('openai', 'hidden-one', { hidden: true }),
        model('u-0123456789', 'sdxl', { personal: { deviceId: 'laptop', deviceName: 'Laptop' }, available: true }),
        model('u-1111111111', 'flux', { personal: { deviceId: 'laptop', deviceName: 'Laptop' }, available: true }),
        model('u-9876543210', 'z-image', { personal: { deviceId: 'desktop', deviceName: 'Desktop' }, available: false }),
      ],
      (id) => (id === 'openai' ? 'OpenAI' : undefined),
    );
    expect(groups.map((g) => [g.id, g.label, g.offline, g.models.map((m) => m.modelId)])).toEqual([
      ['openai', 'OpenAI', false, ['gpt-image-1']],
      ['device:laptop', 'Laptop', false, ['flux', 'sdxl']],
      ['device:desktop', 'Desktop', true, ['z-image']],
    ]);
    expect(imageModelSubtitle(groups[2]!.models[0]!)).toBe('Desktop isn’t connected');
    expect(imageModelSubtitle(model('openai', 'x', { description: 'Good at text' }))).toBe('Good at text');
  });
});
