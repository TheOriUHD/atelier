import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeneratedImage } from '@atelier/protocol';
import { draftAttachments, draftKeys } from '../../lib/drafts.ts';
import { callsTo, resetBackend, snapshot, user } from '../settings/test-backend.ts';
import { ImagesPage, totalSize } from './images-page.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const image = (n: number, extra: Partial<GeneratedImage> = {}): GeneratedImage => ({
  id: `img_${n}`,
  blob: String(n).padStart(64, '0'),
  mime: 'image/png',
  width: 1024,
  height: 768,
  prompt: `Prompt ${n}`,
  ref: 'comfy/z-image',
  modelName: 'Z-Image Turbo',
  sessionId: 's1',
  sessionTitle: 'Summer party',
  sessionMode: 'chat',
  createdAt: 1000 - n,
  ...extra,
});

interface ListInput {
  before?: number;
  query?: string;
  ref?: string;
}

function renderPage(list: (input: ListInput) => { items: GeneratedImage[]; next: number | null; totalBytes: number }, extra: Record<string, (input: never) => unknown> = {}) {
  resetBackend({
    'app.info': () => ({ imageGeneration: true }),
    'settings.get': () => snapshot(),
    'imageModels.list': () => [
      { ref: 'comfy/z-image', providerId: 'comfy', modelId: 'z-image', displayName: 'Z-Image Turbo', hidden: false },
      { ref: 'comfy/flux', providerId: 'comfy', modelId: 'flux', displayName: 'FLUX', hidden: false },
      { ref: 'comfy/secret', providerId: 'comfy', modelId: 'secret', displayName: 'Hidden one', hidden: true },
    ],
    'generatedImages.list': list,
    ...extra,
  });
  const rootRoute = createRootRoute();
  const page = createRoute({ getParentRoute: () => rootRoute, path: '/images', component: ImagesPage });
  const home = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => <p>Home</p> });
  const chat = createRoute({ getParentRoute: () => rootRoute, path: '/chat/$sessionId', component: () => <p>The chat</p> });
  const code = createRoute({ getParentRoute: () => rootRoute, path: '/code/$sessionId', component: () => <p>The code session</p> });
  const router = createRouter({ routeTree: rootRoute.addChildren([page, home, chat, code]), history: createMemoryHistory({ initialEntries: ['/images'] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

function pick(option: HTMLElement) {
  // Base UI only accepts mouse clicks that started on the option.
  fireEvent.pointerDown(option, { pointerType: 'mouse' });
  fireEvent.click(option);
}

let intersect: (() => void) | null = null;
beforeEach(() => {
  intersect = null;
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private readonly callback: IntersectionObserverCallback) {
        intersect = () => this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('the Images page', () => {
  it('shows everything made, newest first, and the total size', async () => {
    renderPage(() => ({ items: [image(1), image(2)], next: null, totalBytes: 340_000_000 }));
    const grid = await screen.findByRole('list', { name: 'Images' });
    expect(within(grid).getAllByRole('img').map((i) => i.getAttribute('alt'))).toEqual(['Prompt 1', 'Prompt 2']);
    expect(screen.getByText('340 MB in all')).toBeTruthy();
  });

  it('sizes tiles from what each image is, before any of them has loaded', async () => {
    renderPage(() => ({ items: [image(1, { width: 2048, height: 1024 }), image(2, { width: 512, height: 1024 })], next: null, totalBytes: 1 }));
    const [wide, tall] = within(await screen.findByRole('list', { name: 'Images' })).getAllByRole('listitem');
    expect(Number.parseInt(wide!.style.width)).toBeGreaterThan(Number.parseInt(tall!.style.width));
  });

  it('loads the next page on the way down, and from the button', async () => {
    const list = (input: ListInput) => (input.before === undefined ? { items: [image(1)], next: 999, totalBytes: 1 } : input.before === 999 ? { items: [image(2)], next: 998, totalBytes: 1 } : { items: [image(3)], next: null, totalBytes: 1 });
    renderPage(list);
    await screen.findByAltText('Prompt 1');
    intersect!();
    await screen.findByAltText('Prompt 2');
    fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    await screen.findByAltText('Prompt 3');
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    expect(callsTo('generatedImages.list').map((c) => (c as ListInput).before)).toEqual([undefined, 999, 998]);
  });

  it('searches by prompt, and says when nothing matches', async () => {
    renderPage(({ query }) => (query ? { items: [], next: null, totalBytes: 5000 } : { items: [image(1)], next: null, totalBytes: 5000 }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Search by prompt' }), { target: { value: 'lighthouse' } });
    expect(await screen.findByText('No images match “lighthouse”.')).toBeTruthy();
    expect(callsTo('generatedImages.list').at(-1)).toMatchObject({ query: 'lighthouse' });
    // The search box stays, or there'd be no way back.
    expect(screen.getByRole('textbox', { name: 'Search by prompt' })).toBeTruthy();
  });

  it('filters by model, leaving hidden models out, with those of old images kept', async () => {
    renderPage(({ ref }) => ({ items: ref ? [image(2)] : [image(1), image(3, { ref: 'gone/old', modelName: 'Old model' })], next: null, totalBytes: 1 }));
    await screen.findByAltText('Prompt 1');
    fireEvent.click(await screen.findByRole('combobox', { name: 'Model' }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['All models', 'Z-Image Turbo', 'FLUX', 'Old model']);
    pick(screen.getByRole('option', { name: 'FLUX' }));
    await screen.findByAltText('Prompt 2');
    expect(callsTo('generatedImages.list').at(-1)).toMatchObject({ ref: 'comfy/flux' });
  });

  it('says what went wrong', async () => {
    renderPage(() => {
      throw new Error('The server is away.');
    });
    expect((await screen.findByRole('alert')).textContent).toBe('The server is away.');
  });
});

describe('opening an image', () => {
  const made = image(1, { revisedPrompt: 'A bigger cat', negativePrompt: 'blurry', seed: 42, durationMs: 14_200, costUsd: 0.04, costEstimated: true });

  it('shows what made it, marks an estimate, and steps through the rest', async () => {
    renderPage(() => ({ items: [made, image(2)], next: null, totalBytes: 1 }));
    fireEvent.click(await screen.findByAltText('Prompt 1'));
    const dialog = await screen.findByRole('dialog', { name: 'Image' });
    const details = within(dialog).getByRole('complementary', { name: 'Details' });
    expect(within(details).getByText('Prompt 1')).toBeTruthy();
    expect(within(details).getByText('A bigger cat')).toBeTruthy();
    expect(within(details).getByText('blurry')).toBeTruthy();
    expect(within(details).getByText('Z-Image Turbo')).toBeTruthy();
    expect(within(details).getByText('1024×768')).toBeTruthy();
    expect(within(details).getByText('42')).toBeTruthy();
    expect(within(details).getByText('14 s')).toBeTruthy();
    expect(within(details).getByText('$0.04')).toBeTruthy();
    expect(within(details).getByText('estimate')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Next image' }));
    expect(await within(details).findByText('Prompt 2')).toBeTruthy();
    expect(within(details).queryByText('estimate')).toBeNull();
    fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    expect(await within(details).findByText('Prompt 1')).toBeTruthy();
  });

  it('links back to the conversation, on the page of its mode', async () => {
    const router = renderPage(() => ({ items: [image(1, { sessionMode: 'code', sessionId: 'c9', sessionTitle: 'Landing page' })], next: null, totalBytes: 1 }));
    fireEvent.click(await screen.findByAltText('Prompt 1'));
    fireEvent.click(await screen.findByRole('link', { name: 'Landing page' }));
    expect(await screen.findByText('The code session')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/code/c9');
  });

  it('has no link when the conversation is gone', async () => {
    renderPage(() => ({ items: [image(1, { sessionId: null, sessionMode: null, sessionTitle: null })], next: null, totalBytes: 1 }));
    fireEvent.click(await screen.findByAltText('Prompt 1'));
    await screen.findByRole('dialog', { name: 'Image' });
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('starts a new chat with the image attached as a reference', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['123456']) })));
    const router = renderPage(() => ({ items: [image(1)], next: null, totalBytes: 1 }));
    fireEvent.click(await screen.findByAltText('Prompt 1'));
    fireEvent.click(await screen.findByRole('button', { name: 'Use as reference' }));
    expect(await screen.findByText('Home')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/');
    // The home page's message box opens with it: the same draft it reads its attachments from.
    const kept = draftAttachments(`${user().id}|${draftKeys.newChat}`);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ mime: 'image/png', size: 6, file: { blob: image(1).blob } });
    // Asking twice doesn't attach it twice.
    router.history.back();
    fireEvent.click(await screen.findByAltText('Prompt 1'));
    fireEvent.click(await screen.findByRole('button', { name: 'Use as reference' }));
    await screen.findByText('Home');
    expect(draftAttachments(`${user().id}|${draftKeys.newChat}`)).toHaveLength(1);
  });

  it('opens the editor to change an area, and the lightbox gets out of its way', async () => {
    renderPage(() => ({ items: [image(1)], next: null, totalBytes: 1 }));
    fireEvent.click(await screen.findByAltText('Prompt 1'));
    fireEvent.click(await screen.findByRole('button', { name: 'Change an area' }));
    const editor = await screen.findByRole('dialog', { name: 'Change an area' });
    expect(editor.querySelector('img')!.getAttribute('src')).toContain(image(1).blob);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Image' })).toBeNull());
  });

  it('offers no area change for an image whose conversation is gone: there is nowhere to send it', async () => {
    renderPage(() => ({ items: [image(1, { sessionId: null, sessionMode: null, sessionTitle: null })], next: null, totalBytes: 1 }));
    fireEvent.click(await screen.findByAltText('Prompt 1'));
    await screen.findByRole('dialog', { name: 'Image' });
    expect(screen.queryByRole('button', { name: 'Change an area' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Use as reference' })).toBeTruthy();
  });

  it('closes on a click beside the image', async () => {
    renderPage(() => ({ items: [image(1)], next: null, totalBytes: 1 }));
    fireEvent.click(await screen.findByAltText('Prompt 1'));
    const dialog = await screen.findByRole('dialog', { name: 'Image' });
    fireEvent.click(within(dialog).getByRole('img').parentElement!);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Image' })).toBeNull());
  });
});

describe('with nothing made yet', () => {
  it('says what to do with a model to hand', async () => {
    const router = renderPage(() => ({ items: [], next: null, totalBytes: 0 }));
    expect(await screen.findByText(/Ask for one in a chat/)).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Search by prompt' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  it('sends an admin without models to add a provider', async () => {
    renderPage(() => ({ items: [], next: null, totalBytes: 0 }), { 'imageModels.list': () => [] });
    expect(await screen.findByText('Add an image provider, then ask for an image in a chat.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add image provider' })).toBeTruthy();
  });

  it('sends anyone else to an admin', async () => {
    renderPage(() => ({ items: [], next: null, totalBytes: 0 }), { 'imageModels.list': () => [], 'account.get': () => user({ role: 'user' }) });
    expect(await screen.findByText(/Ask an admin to add an image provider/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add image provider' })).toBeNull();
  });
});

describe('on an older server', () => {
  it('asks it for nothing', async () => {
    renderPage(() => ({ items: [], next: null, totalBytes: 0 }), { 'app.info': () => ({}) });
    await waitFor(() => expect(callsTo('app.info')).toHaveLength(1));
    expect(callsTo('generatedImages.list')).toEqual([]);
    expect(callsTo('imageModels.list')).toEqual([]);
  });
});

describe('the total size', () => {
  it('is in decimal units', () => {
    expect(totalSize(2_400_000_000)).toBe('2.4 GB');
    expect(totalSize(340_000_000)).toBe('340 MB');
    expect(totalSize(5000)).toBe('5 KB');
  });
});
