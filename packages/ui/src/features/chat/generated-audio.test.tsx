import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeneratedImageMeta, ImageProgress, ToolResultPart } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { saveBlob } from '../../lib/platform.ts';
import { resetBackend } from '../settings/test-backend.ts';
import { GeneratedAudio } from './generated-audio.tsx';
import type { ImageStep } from './generated-images.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});
vi.mock('../../lib/platform.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), saveBlob: vi.fn(async () => {}) }));
vi.mock('./waveform.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), loadPeaks: vi.fn(async () => Array.from({ length: 480 }, (_, i) => (i % 10) / 10)) }));
const openSettings = vi.fn();
vi.mock('../../app/navigation.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), useOpenSettings: () => openSettings }));

const TEXT = 'Welcome aboard, and thank you for flying with us today.';
const meta = (extra: Partial<GeneratedImageMeta> = {}): GeneratedImageMeta => ({ id: 'aud_1', blob: 'abc123def', mime: 'audio/mpeg', width: 0, height: 0, kind: 'audio', audioKind: 'speech', prompt: TEXT, voice: 'Bella', direction: 'calm', ref: 'tts/m', modelName: 'Fake Voice', seconds: 4.2, durationMs: 2100, costUsd: 0.001, costEstimated: true, ...extra });
const running = (progress?: Partial<ImageProgress>, input: unknown = { kind: 'speech', text: TEXT, voice: 'Bella' }): ImageStep => ({
  kind: 'tool',
  key: 'm:0',
  call: { type: 'tool_call', id: 'c1', name: 'GenerateAudio', input },
  result: undefined,
  running: true,
  since: 0,
  output: undefined,
  progress: progress ? { phase: 'generating', kind: 'audio', ...progress } : undefined,
});
const finished = (result: Partial<ToolResultPart>, input?: unknown): ImageStep => ({ ...running(undefined, input), running: false, result: { type: 'tool_result', callId: 'c1', content: [], ...result } });
const done = (sound = meta()) => finished({ generated: [sound], content: [{ type: 'text', text: 'Generated speech.' }] });

const wrap = (children: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TooltipProvider>{children}</TooltipProvider>
  </QueryClientProvider>
);
const show = (step: ImageStep, waiting = false) => render(wrap(<GeneratedAudio step={step} waiting={waiting} />));

beforeEach(() => {
  vi.mocked(saveBlob).mockClear();
  resetBackend({});
  // jsdom has no media playback: play resolves and says so, as a browser does.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event('pause'));
  });
});
afterEach(() => vi.restoreAllMocks());

describe('GeneratedAudio while running', () => {
  it('holds its place with what it is making and says what it is waiting for', () => {
    const { rerender } = show(running({ phase: 'queued', ahead: 2 }));
    expect(screen.getByText('Speech')).toBeTruthy();
    expect(screen.getByText('2 ahead of you')).toBeTruthy();
    rerender(wrap(<GeneratedAudio step={running({ phase: 'loading' })} waiting={false} />));
    expect(screen.getByText('Loading the model')).toBeTruthy();
    rerender(wrap(<GeneratedAudio step={running({ phase: 'generating' })} waiting={false} />));
    expect(screen.getByText('Making the speech')).toBeTruthy();
  });

  it('shows how far music has got, with a bar', () => {
    show(running({ step: 10, steps: 50, audioKind: 'music' }, { kind: 'music', prompt: 'lofi beat', seconds: 30 }));
    expect(screen.getByText('Music')).toBeTruthy();
    expect(screen.getByText('Step 10 of 50')).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Making the sound' }).getAttribute('aria-valuenow')).toBe('20');
  });

  it('waits for the person’s answer before saying it is getting ready', () => {
    show(running(), true);
    expect(screen.getByText('Waiting for your answer')).toBeTruthy();
  });
});

describe('GeneratedAudio when done', () => {
  it('shows the voice, the length and the words, and never plays on its own', () => {
    const { container } = show(done());
    expect(screen.getByRole('group', { name: `Speech · Bella: ${TEXT}` })).toBeTruthy();
    expect(screen.getByText('0:00 / 0:04')).toBeTruthy();
    expect(screen.getByRole('button', { name: `Show the prompt: ${TEXT}` })).toBeTruthy();
    const audio = container.querySelector('audio')!;
    expect(audio.autoplay).toBe(false);
    expect(audio.getAttribute('src')).toContain('abc123def');
  });

  it('plays and pauses from its button, and only one sound plays at a time', async () => {
    const { container } = render(
      wrap(
        <>
          <GeneratedAudio step={done()} waiting={false} />
          <GeneratedAudio step={done(meta({ blob: 'other', id: 'aud_2' }))} waiting={false} />
        </>,
      ),
    );
    const [first, second] = screen.getAllByRole('button', { name: 'Play' });
    await act(async () => fireEvent.click(first!));
    expect(screen.getAllByRole('button', { name: 'Pause' })).toHaveLength(1);
    await act(async () => fireEvent.click(second!));
    // The first stopped when the second started.
    expect(screen.getAllByRole('button', { name: 'Pause' })).toHaveLength(1);
    const audios = container.querySelectorAll('audio');
    expect(vi.mocked(HTMLMediaElement.prototype.pause).mock.contexts).toContain(audios[0]);
  });

  it('seeks with the keyboard on its waveform', () => {
    const { container } = show(done());
    const audio = container.querySelector('audio')!;
    Object.defineProperty(audio, 'duration', { value: 20, configurable: true });
    const slider = screen.getByRole('slider', { name: 'Position' });
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(audio.currentTime).toBe(5);
    fireEvent.keyDown(slider, { key: 'End' });
    expect(audio.currentTime).toBe(20);
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(audio.currentTime).toBe(0);
  });

  it('changes the speed of speech, and has no speed for music', () => {
    const { container, unmount } = show(done());
    fireEvent.click(screen.getByRole('button', { name: 'Playback speed, 1×' }));
    expect(container.querySelector('audio')!.playbackRate).toBe(1.25);
    unmount();
    show(done(meta({ audioKind: 'music', voice: undefined })));
    expect(screen.queryByRole('button', { name: /Playback speed/ })).toBeNull();
  });

  it('downloads under a name from its words', () => {
    show(done());
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(saveBlob).toHaveBeenCalledWith('abc123def', 'welcome-aboard-and-thank-you-for-flying-abc123.mp3');
  });

  it('opens its details: the voice, the direction and the words', () => {
    show(done());
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText('Fake Voice')).toBeTruthy();
    expect(screen.getByText('Direction')).toBeTruthy();
    expect(screen.getByText('calm')).toBeTruthy();
  });

  it('says so when the file is gone, and stops following the playhead', async () => {
    const frames = vi.spyOn(window, 'requestAnimationFrame');
    const { container } = show(done());
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Play' })));
    fireEvent.error(container.querySelector('audio')!);
    expect(screen.getByText('This sound is no longer available.')).toBeTruthy();
    const after = frames.mock.calls.length;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
    expect(frames.mock.calls.length).toBe(after);
  });
});

describe('GeneratedAudio when it failed', () => {
  it("says a refusal quietly, without the words meant for the model", () => {
    show(finished({ isError: true, content: [{ type: 'text', text: "Fake Voice refused this: not allowed That is final: tell the person, and don't reword the request to get past it." }] }));
    expect(screen.getByText('Fake Voice refused this: not allowed')).toBeTruthy();
  });

  it('offers to fix a missing model in Settings', () => {
    resetBackend({ account: { role: 'admin' } } as never);
    show(finished({ isError: true, content: [{ type: 'text', text: 'No sound model is available. An admin adds one in Settings › Media.' }] }));
    expect(screen.getByText('No sound model is available. An admin adds one in Settings › Media.')).toBeTruthy();
  });

  it('says it stopped when Atelier stopped under it', () => {
    show({ ...running(), running: false });
    expect(screen.getByText('Stopped before it finished.')).toBeTruthy();
  });
});
