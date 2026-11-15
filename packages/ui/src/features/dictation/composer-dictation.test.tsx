import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultUserPrefs, type DictationStatus } from '@atelier/protocol';
import { backend, callsTo, emit, model, resetBackend, user } from '../settings/test-backend.ts';
import { Composer } from '../chat/composer.tsx';
import type { Attachments } from '../chat/use-attachments.ts';
import { MicrophoneError, type CaptureOptions } from './capture.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});
vi.mock('../../app/navigation.ts', () => ({ useOpenSettings: () => () => {} }));

// The microphone: the test hands it sound.
const mic = vi.hoisted(() => ({ options: null as CaptureOptions | null, stopped: 0, fail: null as Error | null }));
vi.mock('./capture.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  startCapture: async (options: CaptureOptions) => {
    if (mic.fail) throw mic.fail;
    mic.options = options;
    return { stop: () => void mic.stopped++ };
  },
  listMicrophones: async () => ({ defaultLabel: 'Default - Built-in Microphone', list: [{ id: 'usb', label: 'USB Microphone' }] }),
}));

const attachments: Attachments = { items: [], quotes: [], addQuote: () => {}, removeQuote: () => {}, add: async () => {}, remove: () => {}, clear: () => {}, restore: () => {}, uploading: false, parts: () => [] };
const source = { id: 'text:mis:voxtral-mini-transcribe-realtime-3', label: 'Voxtral Realtime', provider: 'Mistral', live: true };
const status = (over: Partial<DictationStatus> = {}): DictationStatus => ({ enabled: true, source, sources: [], chosen: null, ...over });

function box(props: { onSubmit?: (text: string) => void; variant?: 'new' | 'reply' } = {}) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Composer variant={props.variant ?? 'reply'} attachments={attachments} model={model('fake', 'm')} streaming={false} onSubmit={props.onSubmit ?? (() => {})} />
    </QueryClientProvider>,
  );
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
}

const micButton = () => screen.findByRole('button', { name: 'Dictate' });
const speak = (samples: number) => act(() => mic.options!.onAudio(new Int16Array(samples).fill(1000)));
const heard = (text: string, error?: string) => act(() => emit('dictation.update', { id: 'd1', text, ...(error ? { error } : {}) }));
const mirror = () => document.querySelector('[data-dictation]');

beforeEach(() => {
  localStorage.clear();
  mic.options = null;
  mic.stopped = 0;
  mic.fail = null;
  resetBackend({
    'dictation.status': () => status(),
    'dictation.start': () => ({ id: 'd1', live: true }),
    'dictation.audio': () => ({ ok: true }),
    'dictation.stop': () => ({ text: 'Hello world.' }),
    'dictation.cancel': () => ({ ok: true }),
    'prefs.set': ({ path, value }: { path: string[]; value: unknown }) => ({ ...defaultUserPrefs(), dictation: { ...defaultUserPrefs().dictation, [path[1]!]: value } }),
  });
});
afterEach(() => vi.restoreAllMocks());

/** Starts dictating with a click, after the caret was put at the end of `typed`. */
async function dictateInto(input: HTMLTextAreaElement, typed = '') {
  if (typed) {
    fireEvent.change(input, { target: { value: typed } });
    input.setSelectionRange(typed.length, typed.length);
  }
  fireEvent.click(await micButton());
  await waitFor(() => expect(screen.getByRole('button', { name: 'Stop dictation' })).toBeTruthy());
  await waitFor(() => expect(mic.options).not.toBeNull());
}

describe('dictating into the message box', () => {
  it('shows the microphone only when a service is set up, or to admins to learn how to add one', async () => {
    resetBackend({ 'dictation.status': () => status({ source: null }), 'account.get': () => user({ role: 'user' }) });
    box();
    await waitFor(() => expect(callsTo('dictation.status')).toHaveLength(1));
    expect(screen.queryByRole('button', { name: 'Dictate' })).toBeNull();
  });

  it('streams what is heard into the box, in italics where the caret was, and keeps the final words', async () => {
    const input = box();
    await dictateInto(input, 'Note:');
    expect(callsTo('dictation.start')).toEqual([{ language: 'auto' }]);
    // 100 ms at a time: two 50 ms pieces make one call.
    speak(800);
    expect(callsTo('dictation.audio')).toHaveLength(0);
    speak(800);
    await waitFor(() => expect(callsTo('dictation.audio')).toHaveLength(1));
    expect(callsTo('dictation.audio')[0]).toMatchObject({ id: 'd1', seq: 0 });
    expect(atob((callsTo('dictation.audio')[0] as { pcm: string }).pcm)).toHaveLength(3200);
    heard('Hello wor');
    expect(input.value).toBe('Note: Hello wor');
    expect(input.readOnly).toBe(true);
    expect(mirror()?.querySelector('.italic')?.textContent).toBe('Hello wor');
    expect(screen.getByRole('img', { name: 'Listening' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop dictation' }));
    await waitFor(() => expect(input.value).toBe('Note: Hello world.'));
    expect(input.readOnly).toBe(false);
    expect(input.selectionStart).toBe('Note: Hello world.'.length);
    expect(mirror()).toBeNull();
    expect(mic.stopped).toBeGreaterThan(0);
  });

  it('sends with Enter, words and all', async () => {
    const onSubmit = vi.fn();
    const input = box({ onSubmit });
    await dictateInto(input);
    heard('Hello');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('Hello world.'));
    expect(input.value).toBe('');
  });

  it('drops what was said with Escape, leaving the message as it was', async () => {
    const input = box();
    await dictateInto(input, 'Keep this');
    heard('not this');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('Keep this');
    expect(callsTo('dictation.cancel')).toEqual([{ id: 'd1' }]);
    expect(callsTo('dictation.stop')).toHaveLength(0);
  });

  it('ends when the person starts typing, and types on after the words', async () => {
    const input = box();
    await dictateInto(input);
    heard('Hello');
    fireEvent.keyDown(input, { key: '!' });
    await waitFor(() => expect(input.value).toBe('Hello world.!'));
  });

  it('keeps the words heard and says why when the service stops', async () => {
    const input = box();
    await dictateInto(input, 'Start');
    heard('so far', 'Mistral closed the connection (1011).');
    expect(input.value).toBe('Start so far');
    expect(screen.getByRole('alert').textContent).toContain('Mistral closed the connection (1011).');
    expect(screen.getByRole('button', { name: 'Dictate' })).toBeTruthy();
  });

  it('says why when the microphone isn’t allowed, and leaves the box alone', async () => {
    mic.fail = new MicrophoneError('denied', 'Atelier isn’t allowed to use the microphone.');
    const input = box();
    fireEvent.change(input, { target: { value: 'typed' } });
    fireEvent.click(await micButton());
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Allow it in the browser’s site settings'));
    expect(input.value).toBe('typed');
    expect(input.readOnly).toBe(false);
    // The backend is asked only once the microphone works.
    expect(callsTo('dictation.start')).toHaveLength(0);
  });

  it('records while the button is held, with "Hold to record"', async () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const input = box();
    const button = await micButton();
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
    await waitFor(() => expect(mic.options).not.toBeNull());
    heard('held');
    now += 800;
    fireEvent.pointerUp(button, { pointerId: 1 });
    await waitFor(() => expect(input.value).toBe('Hello world.'));
    expect(callsTo('dictation.start')).toHaveLength(1);
  });

  it('keeps listening after a quick click with "Hold to record", until the next click', async () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    box();
    const button = await micButton();
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
    now += 120;
    fireEvent.pointerUp(button, { pointerId: 1 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop dictation' })).toBeTruthy());
    expect(callsTo('dictation.stop')).toHaveLength(0);
    // A pointer's click (detail 1) does nothing more: the press did it.
    fireEvent.click(screen.getByRole('button', { name: 'Stop dictation' }), { detail: 1 });
    expect(callsTo('dictation.stop')).toHaveLength(0);
    // The next press stops it.
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Stop dictation' }), { button: 0, pointerId: 2 });
    await waitFor(() => expect(callsTo('dictation.stop')).toHaveLength(1));
  });

  it('starts and stops with the shortcut, and records while it is held', async () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const input = box();
    await micButton();
    // Ctrl+Shift+Space here (⇧⌘Space on a Mac).
    fireEvent.keyDown(window, { key: ' ', code: 'Space', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(mic.options).not.toBeNull());
    now += 900;
    fireEvent.keyUp(window, { key: ' ', code: 'Space', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(input.value).toBe('Hello world.'));
  });

  it('sends a long start’s backlog in pieces the backend takes, in order', async () => {
    let answer: (v: { id: string; live: boolean }) => void = () => {};
    backend.handlers['dictation.start'] = () => new Promise((resolve) => (answer = resolve));
    box();
    fireEvent.click(await micButton());
    await waitFor(() => expect(mic.options).not.toBeNull());
    // Three seconds while the backend connects.
    for (let i = 0; i < 60; i++) speak(800);
    expect(callsTo('dictation.audio')).toHaveLength(0);
    await act(async () => answer({ id: 'd1', live: true }));
    const sent = callsTo('dictation.audio') as { seq: number; pcm: string }[];
    expect(sent.map((c) => c.seq)).toEqual([0, 1, 2]);
    expect(sent.map((c) => atob(c.pcm).length)).toEqual([32_000, 32_000, 32_000]);
  });

  it('shows why the service stopped even when it said so before the start was answered', async () => {
    let answer: (v: { id: string; live: boolean }) => void = () => {};
    backend.handlers['dictation.start'] = () => new Promise((resolve) => (answer = resolve));
    const input = box();
    fireEvent.click(await micButton());
    await waitFor(() => expect(mic.options).not.toBeNull());
    heard('', 'Mistral: Invalid language alpha2 code');
    await act(async () => answer({ id: 'd1', live: true }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Invalid language alpha2 code'));
    expect(input.readOnly).toBe(false);
  });

  it('ends when the backend no longer has it (the connection dropped), and keeps the words', async () => {
    const { RpcError, RpcErrorCode } = await import('@atelier/protocol');
    const input = box();
    await dictateInto(input, 'Kept');
    heard('these words');
    backend.handlers['dictation.audio'] = () => {
      throw new RpcError(RpcErrorCode.Application, 'That dictation has ended.', { code: 'not_found' });
    };
    speak(1600);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('connection to Atelier was interrupted'));
    expect(input.value).toBe('Kept these words');
  });

  it('stops once however often it is asked, and types every key pressed meanwhile after the words', async () => {
    let finalWords: (v: { text: string }) => void = () => {};
    backend.handlers['dictation.stop'] = () => new Promise((resolve) => (finalWords = resolve));
    const onSubmit = vi.fn();
    const input = box({ onSubmit });
    await dictateInto(input);
    heard('Hello');
    fireEvent.keyDown(input, { key: ' ' });
    fireEvent.keyDown(input, { key: 'o' });
    fireEvent.keyDown(input, { key: 'k' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(callsTo('dictation.stop')).toHaveLength(1));
    await act(async () => finalWords({ text: 'Hello world.' }));
    expect(callsTo('dictation.stop')).toHaveLength(1);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('Hello world. ok'));
  });

  it('keeps what was said when the microphone goes away, transcribed to the end', async () => {
    const input = box();
    await dictateInto(input);
    heard('Half a');
    act(() => mic.options!.onEnded());
    await waitFor(() => expect(input.value).toBe('Hello world.'));
    expect(screen.getByRole('alert').textContent).toContain('The microphone was disconnected.');
  });

  it('fetches Atelier’s speech model the first time, shows how far it got, and says when it is ready', async () => {
    const { RpcError, RpcErrorCode } = await import('@atelier/protocol');
    backend.handlers['dictation.start'] = () => {
      throw new RpcError(RpcErrorCode.Application, 'Dictation is getting ready: its speech model is being downloaded.', { code: 'preparing' });
    };
    backend.handlers['dictation.prepare'] = () => status({ builtin: { state: 'downloading', received: 0, total: 715_000_000 } });
    const input = box();
    fireEvent.click(await micButton());
    await waitFor(() => expect(callsTo('dictation.prepare')).toHaveLength(1));
    // The microphone isn't kept open meanwhile, and the box is the person's again.
    expect(mic.stopped).toBeGreaterThan(0);
    expect(input.readOnly).toBe(false);
    act(() => emit('dictation.changed', status({ builtin: { state: 'downloading', received: 357_000_000, total: 715_000_000 } })));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('357 of 715 MB'));
    act(() => emit('dictation.changed', status({ builtin: { state: 'ready' } })));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Dictation is ready'));
  });

  it('speaks the language chosen, and says so to the backend', async () => {
    backend.handlers['prefs.get'] = () => ({ ...defaultUserPrefs(), dictation: { language: 'de', holdToRecord: false } });
    const input = box();
    await dictateInto(input);
    expect(callsTo('dictation.start')).toEqual([{ language: 'de' }]);
  });
});
