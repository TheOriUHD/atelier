/**
 * Where dictation's words come from (ARCHITECTURE §27): Atelier's backend (its own speech model or a provider), or, in
 * the desktop app on a Mac, the Mac's own speech recognition through main (apps/desktop/src/speech.ts).
 */
import { useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { desktop } from '../../lib/platform.ts';
import { rpc } from '../../lib/rpc.ts';

export interface TransportUpdate {
  id: string;
  text?: string;
  error?: string;
  /** The Mac fetches its model for the language, this far (0 to 1). */
  preparing?: number;
}

export interface DictationTransport {
  kind: 'mac' | 'backend';
  start(language: string, hints: readonly string[]): Promise<{ id: string; live: boolean }>;
  audio(id: string, seq: number, samples: Int16Array): Promise<unknown>;
  stop(id: string): Promise<string>;
  cancel(id: string): void;
  subscribe(handler: (update: TransportUpdate) => void): () => void;
}

/** The Mac doesn't know the language picked: the backend takes the dictation instead. */
export class MacCantHear extends Error {}

function base64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export const backendTransport: DictationTransport = {
  kind: 'backend',
  start: (language, hints) => rpc().call('dictation.start', { language, ...(hints.length ? { hints: [...hints] } : {}) }),
  audio: (id, seq, samples) => rpc().call('dictation.audio', { id, seq, pcm: base64(samples) }),
  stop: async (id) => (await rpc().call('dictation.stop', { id })).text,
  cancel: (id) => void rpc().call('dictation.cancel', { id }).catch(() => undefined),
  subscribe: (handler) => rpc().on('dictation.update', (u) => handler({ id: u.id, text: u.text, ...(u.error ? { error: u.error } : {}) })),
};

type MacUpdate = { id: number; text?: string; preparing?: number; error?: string };

/** The Mac's own recognition; null outside the desktop app on a Mac, or in a desktop app older than it. */
export function macTransport(): DictationTransport | null {
  const speech = desktop?.speech;
  if (!speech) return null;
  return {
    kind: 'mac',
    async start(language) {
      const answer = await speech.start(language);
      if (answer.ok) return { id: String(answer.id), live: true };
      // A language it doesn't know, or the Mac's recognition failing to start: Atelier's backend takes it.
      throw new MacCantHear(answer.message);
    },
    audio(id, _seq, samples) {
      speech.audio(Number(id), new Uint8Array(samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength)));
      return Promise.resolve();
    },
    stop: (id) => speech.stop(Number(id)),
    cancel: (id) => speech.cancel(Number(id)),
    subscribe: (handler) =>
      speech.onUpdate((raw) => {
        const u = raw as MacUpdate;
        handler({ id: String(u.id), ...(u.text !== undefined ? { text: u.text } : {}), ...(u.error ? { error: u.error } : {}), ...(u.preparing !== undefined ? { preparing: u.preparing } : {}) });
      }),
  };
}

const ENGINE_KEY = 'atelier.dictation.engine';
const engineListeners = new Set<() => void>();

/** Settings › Developer on a Mac: dictate with Atelier's speech model (the server's, or this computer's) instead of the Mac's. */
export function prefersAtelierModel(): boolean {
  try {
    return localStorage.getItem(ENGINE_KEY) === 'atelier';
  } catch {
    return false;
  }
}

export function setPrefersAtelierModel(on: boolean): void {
  try {
    if (on) localStorage.setItem(ENGINE_KEY, 'atelier');
    else localStorage.removeItem(ENGINE_KEY);
  } catch {
    // storage refused: the choice lasts until the window closes
  }
  engineListeners.forEach((l) => l());
}

export function usePrefersAtelierModel(): boolean {
  return useSyncExternalStore(
    (listener) => {
      engineListeners.add(listener);
      return () => void engineListeners.delete(listener);
    },
    prefersAtelierModel,
    () => false,
  );
}

/** Whether this Mac can dictate on its own (the desktop app on macOS 26 or later); false everywhere else. */
export function useMacSpeech(): boolean {
  const { data } = useQuery({ queryKey: ['macSpeech'], queryFn: () => desktop!.speech!.available(), enabled: !!desktop?.speech, staleTime: Infinity, retry: false });
  return !!data?.available;
}
