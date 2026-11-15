/**
 * Which microphone dictation uses: this window's own choice (a device id only means something on the computer it came
 * from), kept in local storage. None is the system's default.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { listMicrophones } from './capture.ts';

const KEY = 'atelier.dictation.microphone';
const listeners = new Set<() => void>();

export function savedMicrophone(): string | null {
  try {
    return localStorage.getItem(KEY) || null;
  } catch {
    return null;
  }
}

export function saveMicrophone(id: string | null): void {
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    // storage refused: the choice lasts until the window closes
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => e.key === KEY && listener();
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function useSavedMicrophone(): string | null {
  return useSyncExternalStore(subscribe, savedMicrophone, () => null);
}

/** The microphones there are, read again when one is plugged in or out, and whenever `refresh` changes (a menu opened). */
export function useMicrophones(refresh: unknown): { defaultLabel: string | null; list: { id: string; label: string }[] } {
  const [list, setList] = useState<{ defaultLabel: string | null; list: { id: string; label: string }[] }>({ defaultLabel: null, list: [] });
  useEffect(() => {
    let alive = true;
    const read = () => void listMicrophones().then((l) => alive && setList(l));
    read();
    const devices = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    devices?.addEventListener?.('devicechange', read);
    return () => {
      alive = false;
      devices?.removeEventListener?.('devicechange', read);
    };
  }, [refresh]);
  return list;
}
