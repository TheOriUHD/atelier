import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeneratedImageMeta, ImageProgress, ToolResultPart } from '@atelier/protocol';
import { TooltipProvider, toast } from '../../components/ui/index.ts';
import { saveBlob } from '../../lib/platform.ts';
import { fakeRpc, resetBackend, user } from '../settings/test-backend.ts';
import { ComposerImages, GeneratedImages, useImageReference, type ImageStep } from './generated-images.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});
vi.mock('../../lib/platform.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), saveBlob: vi.fn(async () => {}) }));
const openSettings = vi.fn();
vi.mock('../../app/navigation.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), useOpenSettings: () => openSettings }));

const meta = (extra: Partial<GeneratedImageMeta> = {}): GeneratedImageMeta => ({ id: 'img_1', blob: 'abc123def', mime: 'image/png', width: 1536, height: 1024, prompt: 'A kite above the dunes', ref: 'p/m', modelName: 'Fake Diffusion', seed: 42, durationMs: 14_000, costUsd: 0.04, costEstimated: true, ...extra });
const running = (progress?: Partial<ImageProgress>, input: unknown = { prompt: 'A kite above the dunes' }): ImageStep => ({
  kind: 'tool',
  key: 'm:0',
  call: { type: 'tool_call', id: 'c1', name: 'GenerateImage', input },
  result: undefined,
  running: true,
  since: 0,
  output: undefined,
  progress: progress ? { phase: 'generating', ...progress } : undefined,
});
const finished = (result: Partial<ToolResultPart>, input: unknown = { prompt: 'A kite above the dunes' }): ImageStep => ({ ...running(undefined, input), running: false, result: { type: 'tool_result', callId: 'c1', content: [], ...result } });
const done = (...images: GeneratedImageMeta[]) => finished({ generated: images, content: [{ type: 'text', text: 'Generated.' }] });
const failed = (text: string) => finished({ isError: true, content: [{ type: 'text', text }] });

function wrap(children: ReactNode, attach?: (image: { blob: string; mime: string }) => void) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <ComposerImages.Provider value={attach ? { attach, focus: () => {} } : null}>{children}</ComposerImages.Provider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
const show = (step: ImageStep, { waiting = false, attach }: { waiting?: boolean; attach?: (image: { blob: string; mime: string }) => void } = {}) => render(wrap(<GeneratedImages step={step} waiting={waiting} />, attach));

/** The frames, by their inline `--at-image-ratio`. */
const ratios = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.group\\/image')].map((el) => Number(el.style.getPropertyValue('--at-image-ratio')));

beforeEach(() => {
  openSettings.mockClear();
  vi.mocked(saveBlob).mockClear();
  resetBackend({});
});
afterEach(() => vi.unstubAllGlobals());

describe('GeneratedImages while running', () => {
  it('has the final shape as soon as the backend knows it, and a sensible one before', () => {
    const { container, rerender } = show(running(undefined, { prompt: 'x', aspect_ratio: '16:9' }));
    expect(ratios(container)).toEqual([1.7778]);
    rerender(wrap(<GeneratedImages step={running({ width: 1536, height: 1024 }, { prompt: 'x', aspect_ratio: '16:9' })} waiting={false} />));
    expect(ratios(container)).toEqual([1.5]);
    expect(screen.getByText('Making the image')).toBeTruthy();
  });

  it('shows one frame per image, sharing one status line', () => {
    const { container } = show(running({ count: 4, width: 1024, height: 1024 }));
    expect(ratios(container)).toEqual([1, 1, 1, 1]);
    expect(screen.getAllByText('Making 4 images')).toHaveLength(1);
  });

  it('has a thin bar once it knows how far it is, and none before', () => {
    const { rerender } = show(running({ phase: 'loading' }));
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText('Loading the model')).toBeTruthy();
    rerender(wrap(<GeneratedImages step={running({ step: 7, steps: 28, etaMs: 21_000 })} waiting={false} />));
    expect(screen.getByRole('progressbar', { name: 'Making the image' }).getAttribute('aria-valuenow')).toBe('25');
    expect(screen.getByText('Step 7 of 28 · about 20 s')).toBeTruthy();
  });

  it('eases the preview in behind a blur that clears as the steps advance', () => {
    const preview = { mime: 'image/jpeg', data: 'aaaa' };
    const { container, rerender } = show(running({ step: 3, steps: 30, preview }));
    const forming = () => container.querySelector<HTMLImageElement>('img[src^="data:image/jpeg"]')!.parentElement!;
    expect(forming().style.filter).toMatch(/blur\(1[0-9.]+px\)/);
    expect(container.querySelector('.at-image-sheen')?.className).toContain('opacity-0');
    rerender(wrap(<GeneratedImages step={running({ step: 27, steps: 30, preview: { mime: 'image/jpeg', data: 'bbbb' } })} waiting={false} />));
    expect(forming().style.filter).toBe('');
    // The new frame fades in over the last one.
    expect(container.querySelectorAll('img[src^="data:image/jpeg"]')).toHaveLength(2);
  });

  it('shimmers while it works, but not while the run waits for the person', () => {
    const { container, rerender } = show(running());
    expect(container.querySelector('.at-image-sheen')?.className).not.toContain('opacity-0');
    rerender(wrap(<GeneratedImages step={running()} waiting />));
    expect(container.querySelector('.at-image-sheen')?.className).toContain('opacity-0');
    expect(screen.getByText('Waiting for your answer')).toBeTruthy();
  });

  it('announces the end once, not every step', () => {
    const { rerender } = show(running({ step: 1, steps: 2 }));
    const announced = () => screen.getAllByRole('status').map((s) => `${s.getAttribute('aria-live')}:${s.textContent}`);
    expect(announced()).toEqual(['off:Step 1 of 2', 'null:']);
    rerender(wrap(<GeneratedImages step={done(meta())} waiting={false} />));
    expect(announced()).toEqual(['null:Image ready']);
  });
});

describe('GeneratedImages when done', () => {
  it('takes over the frame it was made in, without remounting it', () => {
    const { container, rerender } = show(running({ width: 1536, height: 1024, preview: { mime: 'image/png', data: 'aaaa' } }));
    const frame = container.querySelector('.group\\/image');
    rerender(wrap(<GeneratedImages step={done(meta())} waiting={false} />));
    expect(container.querySelector('.group\\/image')).toBe(frame);
    expect(ratios(container)).toEqual([1.5]);
    // The preview stays under the image for the crossfade.
    expect(container.querySelectorAll('img')).toHaveLength(2);
  });

  it('keeps the preview until the image has loaded and the crossfade is over', async () => {
    vi.useFakeTimers();
    const { container, rerender } = show(running({ preview: { mime: 'image/png', data: 'aaaa' } }));
    rerender(wrap(<GeneratedImages step={done(meta())} waiting={false} />));
    // Slow to arrive: an empty frame would flash between the preview and the image.
    act(() => void vi.advanceTimersByTime(5000));
    expect(container.querySelector('img[src^="data:"]')).not.toBeNull();
    fireEvent.load(container.querySelector('img[src*="abc123def"]')!);
    act(() => void vi.advanceTimersByTime(1000));
    vi.useRealTimers();
    expect(container.querySelector('img[src^="data:"]')).toBeNull();
  });

  it('shows its image as soon as it is done, while calls beside it still run', () => {
    const { container } = show(running({ phase: 'finishing', images: [meta()] }));
    expect(screen.getByRole('button', { name: /^Open image/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Show the prompt/ })).toBeTruthy();
    expect(container.querySelector('.at-image-sheen')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('uses the sizes the images really have, in a layout for how many there are', () => {
    const { container } = show(done(meta({ id: 'a' }), meta({ id: 'b', width: 1024, height: 1024 })));
    expect(ratios(container)).toEqual([1.5, 1]);
    expect(screen.getAllByRole('button', { name: /^Open image/ }).map((b) => b.getAttribute('aria-label'))).toEqual(['Open image 1 of 2: A kite above the dunes', 'Open image 2 of 2: A kite above the dunes']);
  });

  it('keeps the prompt on a line that opens, and shows how the service reworded it', () => {
    show(done(meta({ revisedPrompt: 'A red kite above tall dunes at noon' })));
    expect(screen.queryByText(/A red kite/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Show the prompt/ }));
    expect(screen.getByText('A kite above the dunes')).toBeTruthy();
    expect(screen.getByText(/A red kite above tall dunes/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hide the prompt' }));
    expect(screen.queryByText(/A red kite/)).toBeNull();
  });

  it('works for a result from before `generated`, taking the shape from the file', () => {
    const { container } = show(finished({ content: [{ type: 'text', text: 'Generated.' }, { type: 'image', mime: 'image/png', blob: 'old1' }] }, { prompt: 'Old', aspect_ratio: '1:1' }));
    expect(ratios(container)).toEqual([1]);
    const img = screen.getByRole('img', { hidden: true });
    Object.defineProperty(img, 'naturalWidth', { value: 800 });
    Object.defineProperty(img, 'naturalHeight', { value: 400 });
    fireEvent.load(img);
    expect(ratios(container)).toEqual([2]);
    expect(screen.getByRole('button', { name: /^Show the prompt/ }).textContent).toContain('Old');
  });

  it('keeps what a screen reader says of an image short, whatever the prompt’s length', () => {
    show(done(meta({ prompt: 'x'.repeat(2000) })));
    expect(screen.getByRole('button', { name: /^Open image/ }).getAttribute('aria-label')?.length).toBeLessThan(230);
  });

  it('says so when only some images came back', () => {
    show(finished({ generated: [meta()], content: [{ type: 'text', text: 'Generated an image.\nOnly these came back: The server fell over.' }] }));
    expect(screen.getByText('The rest didn’t come back: The server fell over.')).toBeTruthy();
  });

  it.each([2, 3, 4])('asked for %i, with one that failed: the frames go from the planned count to those that came, and say why the rest did not', (count) => {
    const input = { prompt: 'A kite above the dunes', count };
    const { container, rerender } = show(running(undefined, input));
    expect(container.querySelectorAll('.group\\/image')).toHaveLength(count);
    const came = Array.from({ length: count - 1 }, (_, i) => meta({ id: `img_${i}`, blob: `blob${i}` }));
    rerender(wrap(<GeneratedImages step={finished({ generated: came, content: [{ type: 'text', text: `Generated ${count - 1} images.\nOnly these came back: The server fell over.` }] }, input)} waiting={false} />));
    expect(container.querySelectorAll('.group\\/image')).toHaveLength(count - 1);
    // Every frame that is left has an image in it: no empty frame stays behind for the one that failed.
    expect(screen.getAllByRole('img', { hidden: true })).toHaveLength(count - 1);
    expect(screen.getByText('The rest didn’t come back: The server fell over.')).toBeTruthy();
    expect(screen.getByText(count - 1 === 1 ? 'Image ready' : `${count - 1} images ready`)).toBeTruthy();
  });

  it('shows a mark in place of an image whose file is gone', () => {
    show(done(meta()));
    fireEvent.error(screen.getByRole('img', { hidden: true }));
    expect(screen.getByText('This image is no longer available.')).toBeTruthy();
  });
});

describe('GeneratedImages actions', () => {
  const stubClipboard = (write: (items: ClipboardItem[]) => Promise<void>) => {
    vi.stubGlobal('ClipboardItem', class { constructor(readonly items: Record<string, Promise<Blob>>) {} });
    Object.defineProperty(navigator, 'clipboard', { value: { write }, configurable: true });
  };
  afterEach(() => Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }));

  it('copies as a PNG where the browser allows it', async () => {
    const write = vi.fn(async () => {});
    stubClipboard(write);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['png'], { type: 'image/png' }))));
    show(done(meta()));
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
    const [[[item]]] = write.mock.calls as unknown as [[[{ items: Record<string, Promise<Blob>> }]]];
    expect(Object.keys(item.items)).toEqual(['image/png']);
    expect((await item.items['image/png']!).type).toBe('image/png');
  });

  it('turns other formats into a PNG through a canvas', async () => {
    const write = vi.fn(async () => {});
    stubClipboard(write);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['jpeg'], { type: 'image/jpeg' }))));
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 2, height: 2, close: () => {} })));
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done) => done(new Blob(['png'], { type: 'image/png' })));
    show(done(meta({ mime: 'image/jpeg' })));
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await screen.findByRole('button', { name: 'Copied' });
    const [[[item]]] = write.mock.calls as unknown as [[[{ items: Record<string, Promise<Blob>> }]]];
    expect((await item.items['image/png']!).type).toBe('image/png');
    expect(drawImage).toHaveBeenCalledOnce();
  });

  it('says so when the image can’t be read to copy it', async () => {
    const write = vi.fn(async (items: { items: Record<string, Promise<Blob>> }[]) => void (await items[0]!.items['image/png']));
    stubClipboard(write as never);
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    const error = vi.spyOn(toast, 'error').mockImplementation(() => 0);
    show(done(meta()));
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(error).toHaveBeenCalledWith('The image could not be copied.'));
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
    error.mockRestore();
  });

  it('has no Copy on plain http, where the Clipboard API doesn’t exist', () => {
    show(done(meta()));
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy();
  });

  it('downloads under a name from the prompt', () => {
    show(done(meta()));
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(saveBlob).toHaveBeenCalledWith('abc123def', 'a-kite-above-the-dunes-abc123.png');
  });

  it('offers Use as reference only where there is a message box', () => {
    const attach = vi.fn();
    const { unmount } = show(done(meta()), { attach });
    fireEvent.click(screen.getByRole('button', { name: 'Use as reference' }));
    expect(attach).toHaveBeenCalledWith(expect.objectContaining({ blob: 'abc123def', mime: 'image/png' }));
    unmount();
    show(done(meta()));
    expect(screen.queryByRole('button', { name: 'Use as reference' })).toBeNull();
  });

  it('folds them into one button for a small cell, working the same', async () => {
    show(done(meta()));
    fireEvent.click(screen.getByRole('button', { name: 'Image actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Download' }));
    expect(saveBlob).toHaveBeenCalledOnce();
  });

  it('opens Details beside the image: model, size, seed, time, cost and the prompts', async () => {
    show(done(meta({ revisedPrompt: 'A red kite', negativePrompt: 'blurry' })));
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const details = await screen.findByRole('complementary', { name: 'Details' });
    const text = details.textContent!;
    for (const fact of ['Fake Diffusion', '1536 × 1024', '42', '14 s', '$0.04 estimated', 'A kite above the dunes', 'A red kite', 'blurry']) expect(text).toContain(fact);
    expect(within(details).getByRole('button', { name: 'Copy prompt' })).toBeTruthy();
  });

  it('marks a cost only when it is an estimate, and leaves out what isn’t known', async () => {
    show(done(meta({ costEstimated: false, seed: undefined })));
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const details = await screen.findByRole('complementary', { name: 'Details' });
    expect(details.textContent).toContain('$0.04');
    expect(details.textContent).not.toContain('estimated');
    expect(details.textContent).not.toContain('Seed');
  });

  it('opens the lightbox from the image, with its actions there too and no Details panel yet', async () => {
    show(done(meta()));
    fireEvent.click(screen.getByRole('button', { name: /^Open image/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Image' });
    expect(within(dialog).getByRole('button', { name: 'Download' })).toBeTruthy();
    expect(within(dialog).queryByRole('complementary')).toBeNull();
  });
});

describe('GeneratedImages when it did not work', () => {
  it('says what the provider said, without what was meant for the model', () => {
    const { container } = show(failed("OpenAI refused this: it breaks the content policy. That is final: tell the person, and don't reword the prompt to get past it."));
    expect(screen.getByText('OpenAI refused this: it breaks the content policy.')).toBeTruthy();
    expect(container.querySelector('.group\\/image')).toBeNull();
    expect(screen.getByRole('button', { name: /^Show the prompt/ })).toBeTruthy();
  });

  it('offers admins the fix for a setup problem', async () => {
    resetBackend({ 'account.get': () => user() });
    show(failed('Cannot reach ComfyUI at 127.0.0.1:8188'));
    fireEvent.click(await screen.findByRole('button', { name: 'Fix in Settings' }));
    expect(openSettings).toHaveBeenCalledWith('image-providers');
  });

  it('keeps the fix from people who can’t use it, and from what Settings can’t fix', async () => {
    resetBackend({ 'account.get': () => user({ role: 'user' }) });
    const { unmount } = show(failed('Cannot reach ComfyUI at 127.0.0.1:8188'));
    await waitFor(() => expect(fakeRpc.call).toBeDefined());
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Fix in Settings' })).toBeNull();
    unmount();
    resetBackend({ 'account.get': () => user() });
    show(failed('The server fell over.'));
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Fix in Settings' })).toBeNull();
  });

  it('says it was stopped and keeps the preview it got to', () => {
    const { container, rerender } = show(running({ step: 3, steps: 30, preview: { mime: 'image/jpeg', data: 'aaaa' } }));
    rerender(wrap(<GeneratedImages step={failed('GenerateImage failed: This operation was aborted')} waiting={false} />));
    expect(screen.getByText('Stopped before it finished.')).toBeTruthy();
    const preview = container.querySelector<HTMLImageElement>('img[src^="data:image/jpeg"]')!;
    expect(preview.parentElement!.style.filter).toMatch(/blur/);
    expect(container.querySelector('.at-image-sheen')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('with no preview to keep, leaves the words in the frame’s place', () => {
    const { container, rerender } = show(running());
    rerender(wrap(<GeneratedImages step={failed('GenerateImage failed: This operation was aborted')} waiting={false} />));
    expect(screen.getByText('Stopped before it finished.')).toBeTruthy();
    expect(container.querySelector('.group\\/image')).toBeNull();
  });

  it('counts a call that never got an answer as stopped (Atelier restarted under it)', () => {
    show({ ...running(), running: false });
    expect(screen.getByText('Stopped before it finished.')).toBeTruthy();
  });
});

describe('useImageReference', () => {
  function Harness({ items, restore }: { items: { file?: { blob: string } }[]; restore: (parts: unknown[]) => void }) {
    const reference = useImageReference({ items, restore } as never, { current: { focus } } as never);
    return (
      <button type="button" onClick={() => reference.attach({ blob: 'abc', mime: 'image/png' })}>
        Attach
      </button>
    );
  }
  const focus = vi.fn();

  it('adds an image to the message box once', () => {
    const restore = vi.fn();
    const { rerender } = render(<Harness items={[]} restore={restore} />);
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
    expect(restore).toHaveBeenCalledWith([{ type: 'image', blob: 'abc', mime: 'image/png' }]);
    rerender(<Harness items={[{ file: { blob: 'abc' } }]} restore={restore} />);
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
    expect(restore).toHaveBeenCalledOnce();
  });
});
