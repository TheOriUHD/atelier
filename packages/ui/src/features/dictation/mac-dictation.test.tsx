import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultUserPrefs, type DictationStatus } from '@atelier/protocol';
import { callsTo, model, resetBackend } from '../settings/test-backend.ts';
import { Composer } from '../chat/composer.tsx';
import type { Attachments } from '../chat/use-attachments.ts';
import type { CaptureOptions } from './capture.ts';

// The desktop app on a Mac: dictation goes to the Mac's own recognition through main.
const mac = vi.hoisted(() => ({
  starts: [] as string[],
  audio: [] as number[],
  answer: { ok: true, id: 7, locale: 'de_DE' } as { ok: true; id: number; locale: string } | { ok: false; code: string; message: string },
  listener: null as ((u: unknown) => void) | null,
  stopText: 'Guten Morgen.',
}));
vi.mock('../../lib/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  desktop: {
    platform: 'darwin',
    microphone: { ask: async () => true, openSettings: async () => {} },
    speech: {
      available: async () => ({ available: true, locales: ['de-DE', 'en-US'] }),
      start: async (language: string) => (mac.starts.push(language), mac.answer),
      audio: (_id: number, pcm: Uint8Array) => void mac.audio.push(pcm.byteLength),
      stop: async () => mac.stopText,
      cancel: () => {},
      onUpdate: (listener: (u: unknown) => void) => ((mac.listener = listener), () => (mac.listener = null)),
    },
  },
}));
vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});
vi.mock('../../app/navigation.ts', () => ({ useOpenSettings: () => () => {} }));
const mic = vi.hoisted(() => ({ options: null as CaptureOptions | null }));
vi.mock('./capture.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  startCapture: async (options: CaptureOptions) => ((mic.options = options), { stop: () => {} }),
  listMicrophones: async () => ({ defaultLabel: null, list: [] }),
}));

const attachments: Attachments = { items: [], quotes: [], addQuote: () => {}, removeQuote: () => {}, add: async () => {}, remove: () => {}, clear: () => {}, restore: () => {}, uploading: false, parts: () => [] };
const status = (over: Partial<DictationStatus> = {}): DictationStatus => ({ enabled: true, source: null, sources: [], chosen: null, ...over });

function box() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Composer variant="reply" attachments={attachments} model={model('fake', 'm')} streaming={false} onSubmit={() => {}} />
    </QueryClientProvider>,
  );
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
}

beforeEach(() => {
  localStorage.clear();
  mac.starts = [];
  mac.audio = [];
  mac.answer = { ok: true, id: 7, locale: 'de_DE' };
  mic.options = null;
  resetBackend({
    'dictation.status': () => status(),
    'dictation.start': () => ({ id: 'b1', live: true }),
    'dictation.audio': () => ({ ok: true }),
    'dictation.stop': () => ({ text: 'Vom Server.' }),
    'dictation.cancel': () => ({ ok: true }),
    'prefs.get': () => ({ ...defaultUserPrefs(), dictation: { language: 'de', holdToRecord: true } }),
  });
});

describe('dictating on a Mac', () => {
  it('uses the Mac’s own recognition, even when the backend has no speech service', async () => {
    const input = box();
    fireEvent.click(await screen.findByRole('button', { name: 'Dictate' }));
    await waitFor(() => expect(mac.starts).toEqual(['de']));
    act(() => mic.options!.onAudio(new Int16Array(1600)));
    await waitFor(() => expect(mac.audio).toEqual([3200]));
    act(() => mac.listener!({ id: 7, text: 'Guten' }));
    expect(input.value).toBe('Guten');
    fireEvent.click(screen.getByRole('button', { name: 'Stop dictation' }));
    await waitFor(() => expect(input.value).toBe('Guten Morgen.'));
    expect(callsTo('dictation.start')).toHaveLength(0);
  });

  it('hands a language the Mac doesn’t know to Atelier’s backend', async () => {
    mac.answer = { ok: false, code: 'unsupported', message: 'The Mac’s speech recognition doesn’t know this language.' };
    const input = box();
    fireEvent.click(await screen.findByRole('button', { name: 'Dictate' }));
    await waitFor(() => expect(callsTo('dictation.start')).toEqual([{ language: 'de' }]));
    fireEvent.click(screen.getByRole('button', { name: 'Stop dictation' }));
    await waitFor(() => expect(input.value).toBe('Vom Server.'));
  });

  it('uses Atelier’s model instead when Settings › Developer says so', async () => {
    localStorage.setItem('atelier.dictation.engine', 'atelier');
    resetBackend({ 'dictation.status': () => status({ source: { id: 'builtin', label: 'Nemotron 3.5 ASR', provider: 'Atelier', live: true } }), 'dictation.start': () => ({ id: 'b1', live: true }), 'dictation.stop': () => ({ text: '' }), 'dictation.cancel': () => ({ ok: true }) });
    box();
    fireEvent.click(await screen.findByRole('button', { name: 'Dictate' }));
    await waitFor(() => expect(callsTo('dictation.start')).toHaveLength(1));
    expect(mac.starts).toEqual([]);
  });
});
