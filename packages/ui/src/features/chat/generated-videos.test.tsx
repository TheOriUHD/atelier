import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeneratedImageMeta, ImageProgress, ToolResultPart } from '@atelier/protocol';
import { TooltipProvider, toast } from '../../components/ui/index.ts';
import { saveBlob } from '../../lib/platform.ts';
import { resetBackend } from '../settings/test-backend.ts';
import { ComposerImages, type ImageStep } from './generated-images.tsx';
import { GeneratedVideos } from './generated-videos.tsx';
import { firstFrame } from './video-frame.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});
vi.mock('../../lib/platform.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), saveBlob: vi.fn(async () => {}) }));
vi.mock('./video-frame.ts', () => ({ firstFrame: vi.fn(async () => new File(['png'], 'first-frame.png', { type: 'image/png' })) }));
const openSettings = vi.fn();
vi.mock('../../app/navigation.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), useOpenSettings: () => openSettings }));

const PROMPT = 'Waves rolling onto a beach at dusk';
const meta = (extra: Partial<GeneratedImageMeta> = {}): GeneratedImageMeta => ({ id: 'vid_1', blob: 'abc123def', mime: 'video/mp4', width: 1280, height: 720, kind: 'video', prompt: PROMPT, ref: 'p/m', modelName: 'Fake Video', seconds: 6, fps: 24, audio: true, seed: 7, durationMs: 95_000, costUsd: 0.6, costEstimated: true, ...extra });
const running = (progress?: Partial<ImageProgress>, input: unknown = { prompt: PROMPT, seconds: 6 }): ImageStep => ({
  kind: 'tool',
  key: 'm:0',
  call: { type: 'tool_call', id: 'c1', name: 'GenerateVideo', input },
  result: undefined,
  running: true,
  since: 0,
  output: undefined,
  progress: progress ? { phase: 'generating', kind: 'video', ...progress } : undefined,
});
const finished = (result: Partial<ToolResultPart>, input: unknown = { prompt: PROMPT }): ImageStep => ({ ...running(undefined, input), running: false, result: { type: 'tool_result', callId: 'c1', content: [], ...result } });
const done = (clip = meta()) => finished({ generated: [clip], content: [{ type: 'text', text: 'Generated a video.' }] });

function wrap(children: ReactNode, composer: { attach(image: { blob: string; mime: string }): void; focus(): void; addFile?(file: File): void } | null = null) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <ComposerImages.Provider value={composer}>{children}</ComposerImages.Provider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
const show = (step: ImageStep, options: { waiting?: boolean; composer?: Parameters<typeof wrap>[1] } = {}) => render(wrap(<GeneratedVideos step={step} waiting={options.waiting ?? false} />, options.composer));
const frameRatio = (container: HTMLElement) => Number(container.querySelector<HTMLElement>('.at-image-frames > div')!.style.getPropertyValue('--at-image-ratio'));

beforeEach(() => {
  openSettings.mockClear();
  vi.mocked(saveBlob).mockClear();
  vi.mocked(firstFrame).mockClear();
  resetBackend({});
});
afterEach(() => vi.unstubAllGlobals());

describe('GeneratedVideos while running', () => {
  it('has the shape of the clip from the first moment, from the ratio asked for, then from what the backend settled on', () => {
    const { container, rerender } = show(running(undefined, { prompt: PROMPT, aspect_ratio: '9:16' }));
    expect(frameRatio(container)).toBe(0.5625);
    rerender(wrap(<GeneratedVideos step={running({ width: 1600, height: 900 })} waiting={false} />));
    expect(frameRatio(container)).toBe(1.7778);
  });

  it('says what it is waiting for, step by step', () => {
    const { rerender } = show(running({ phase: 'queued', ahead: 2 }));
    expect(screen.getByText('2 ahead of you')).toBeTruthy();
    rerender(wrap(<GeneratedVideos step={running({ phase: 'loading' })} waiting={false} />));
    expect(screen.getByText('Loading the model')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    rerender(wrap(<GeneratedVideos step={running({ fraction: 0.4, etaMs: 100_000 })} waiting={false} />));
    expect(screen.getByText('40% · about 2 min')).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Making the video' }).getAttribute('aria-valuenow')).toBe('40');
  });

  it('waits for the person’s answer before saying it is getting ready', () => {
    const { rerender } = show(running(), { waiting: true });
    expect(screen.getByText('Waiting for your answer')).toBeTruthy();
    rerender(wrap(<GeneratedVideos step={running()} waiting={false} />));
    expect(screen.getByText('Getting ready')).toBeTruthy();
  });

  it('shows the latest preview picture, blurred while far from done', () => {
    const { container } = show(running({ fraction: 0.2, preview: { mime: 'image/jpeg', data: 'aaaa' } }));
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('data:image/jpeg;base64,aaaa');
    expect(img.style.filter).toMatch(/blur\(/);
  });

  it('shows a clip that progress says is done ahead of the result', () => {
    const { container } = show({ ...running({ phase: 'finishing', images: [meta()] }) });
    expect(container.querySelector('video')).not.toBeNull();
  });
});

describe('GeneratedVideos once done', () => {
  it('is the browser’s player: controls, looping, muted, inline, with the first frame as its poster', () => {
    const { container } = show(done());
    const video = container.querySelector('video')!;
    expect(video.controls).toBe(true);
    expect(video.loop).toBe(true);
    expect(video.muted).toBe(true);
    expect(video.hasAttribute('playsinline')).toBe(true);
    expect(video.getAttribute('src')).toMatch(/abc123def#t=0\.001$/);
    expect(video.getAttribute('aria-label')).toBe(PROMPT);
    expect(video.getAttribute('preload')).toBe('metadata');
  });

  it('does not play on its own for a clip that was there already', () => {
    const { container } = show(done());
    expect(container.querySelector('video')!.autoplay).toBe(false);
  });

  it('plays a clip that arrived while watching, muted, unless less motion was asked for', () => {
    // Watching from the start (the step was running when it mounted), then done.
    const view = render(wrap(<GeneratedVideos step={running()} waiting={false} />));
    view.rerender(wrap(<GeneratedVideos step={done()} waiting={false} />));
    expect(view.container.querySelector('video')!.autoplay).toBe(true);
    document.documentElement.dataset.motion = 'reduced';
    try {
      const calm = render(wrap(<GeneratedVideos step={running()} waiting={false} />));
      calm.rerender(wrap(<GeneratedVideos step={done()} waiting={false} />));
      expect(calm.container.querySelector('video')!.autoplay).toBe(false);
    } finally {
      delete document.documentElement.dataset.motion;
    }
  });

  it('has the frame of the file the clip really has when the result gave no size', () => {
    const { container } = show(done(meta({ width: 0, height: 0 })));
    expect(container.querySelector('video')).not.toBeNull();
    expect(frameRatio(container)).toBe(1.7778);
  });

  it('downloads under a name made from its prompt', async () => {
    show(done());
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(saveBlob).toHaveBeenCalledWith('abc123def', 'waves-rolling-onto-a-beach-at-dusk-abc123.mp4');
  });

  it('offers the first frame as a reference only where the page has a message box that takes a file, and attaches it', async () => {
    const { unmount } = show(done());
    expect(screen.queryByRole('button', { name: 'Use first frame as reference' })).toBeNull();
    unmount();
    const addFile = vi.fn();
    const focus = vi.fn();
    show(done(), { composer: { attach: () => {}, focus, addFile } });
    fireEvent.click(screen.getByRole('button', { name: 'Use first frame as reference' }));
    await waitFor(() => expect(addFile).toHaveBeenCalledOnce());
    expect(vi.mocked(firstFrame)).toHaveBeenCalledWith(expect.stringMatching(/abc123def$/));
    expect((addFile.mock.calls[0]![0] as File).name).toBe('first-frame.png');
    expect(focus).toHaveBeenCalled();
  });

  it('says why when the frame cannot be taken', async () => {
    vi.mocked(firstFrame).mockRejectedValueOnce(new Error('The video could not be loaded.'));
    const error = vi.spyOn(toast, 'error').mockImplementation(() => '');
    show(done(), { composer: { attach: () => {}, focus: () => {}, addFile: vi.fn() } });
    fireEvent.click(screen.getByRole('button', { name: 'Use first frame as reference' }));
    await waitFor(() => expect(error).toHaveBeenCalledWith('The video could not be loaded.'));
  });

  it('opens larger in a viewer with details, and closes it', async () => {
    show(done());
    fireEvent.click(screen.getByRole('button', { name: 'Open larger' }));
    const dialog = await screen.findByRole('dialog', { name: 'Video' });
    expect(dialog.querySelector('video')!.getAttribute('src')).toMatch(/abc123def$/);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    for (const text of ['Fake Video', '0:06', '1280 × 720', '24 fps', 'Yes', '1 min 35 s']) expect(screen.getByText(text, { exact: false })).toBeTruthy();
    expect(screen.getByText('Seed').nextElementSibling!.textContent).toBe('7');
    expect(screen.getByText('$0.60', { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows the prompt under the player, and a message when the file is gone', () => {
    const { container } = show(done());
    expect(screen.getByRole('button', { name: new RegExp(`Show the prompt: ${PROMPT}`) })).toBeTruthy();
    fireEvent.error(container.querySelector('video')!);
    expect(screen.getByText('This video is no longer available.')).toBeTruthy();
  });

  it('keeps clips and pictures apart: a result with only a picture shows no player', () => {
    const { container } = show(finished({ generated: [meta({ kind: 'image', mime: 'image/png' })], content: [] }));
    expect(container.querySelector('video')).toBeNull();
  });
});

describe('GeneratedVideos that did not make a clip', () => {
  const failed = (text: string) => finished({ isError: true, content: [{ type: 'text', text }] });

  it('says a refusal in plain words and keeps the prompt', () => {
    show(failed('Fake Video refused this: policy. That is final: tell the person, and don\'t reword the prompt to get past it.'));
    expect(screen.getByText('Fake Video refused this: policy.')).toBeTruthy();
    expect(screen.getByRole('button', { name: new RegExp('Show the prompt') })).toBeTruthy();
  });

  it('offers admins the way to fix a missing model', () => {
    show(failed('No video model is available. An admin adds one in Settings › Image and video providers.'));
    expect(screen.getByText(/No video model is available/)).toBeTruthy();
  });

  it('says stopped when the run is over and left nothing', () => {
    show({ ...running(), running: false });
    expect(screen.getByText('Stopped before it finished.')).toBeTruthy();
  });
});
