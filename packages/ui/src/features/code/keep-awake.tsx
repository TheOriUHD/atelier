/**
 * "Keep computer awake" (the More menu, desktop app only): sessions on this device that keep the computer from sleeping
 * while they run. The desktop app holds a power-save blocker while any of them is running or waiting on the person
 * (apps/desktop/src/keep-awake.ts) and lets it go when the switch is off, the run ends, the session is deleted or the
 * app quits.
 */
import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { useSessions } from '../../lib/queries.ts';
import { desktop } from '../../lib/platform.ts';
import { rpc } from '../../lib/rpc.ts';

const KEY = 'atelier.keepAwake';

function read(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function write(ids: string[]): void {
  try {
    if (ids.length) localStorage.setItem(KEY, JSON.stringify(ids));
    else localStorage.removeItem(KEY);
  } catch {
    // Storage unavailable: the switch lasts as long as the window.
  }
}

interface KeepAwakeState {
  sessions: string[];
  set(sessionId: string, on: boolean): void;
}

export const useKeepAwake = create<KeepAwakeState>((set) => ({
  sessions: read(),
  set: (sessionId, on) =>
    set((s) => {
      const sessions = on ? [...new Set([...s.sessions, sessionId])] : s.sessions.filter((id) => id !== sessionId);
      write(sessions);
      return { sessions };
    }),
}));

/** The sessions to keep the computer awake for right now: switched on here and running (or waiting on the person). */
export function awakeSessions(on: readonly string[], sessions: readonly { id: string; status: string }[]): string[] {
  return sessions.filter((s) => on.includes(s.id) && (s.status === 'running' || s.status === 'waiting')).map((s) => s.id);
}

/** Desktop app: tells the main process which sessions need the computer awake. Mounted once, in the app shell. */
export function KeepAwakeSync() {
  const on = useKeepAwake((s) => s.sessions);
  // A deleted session lets go of the switch.
  useEffect(() => rpc().on('sessions.removed', ({ id }) => useKeepAwake.getState().set(id, false)), []);
  useEffect(() => {
    if (!on.length) desktop?.keepAwake.set([]);
  }, [on.length]);
  return on.length ? <Watch on={on} /> : null;
}

function Watch({ on }: { on: string[] }) {
  const { data } = useSessions({ mode: 'code' });
  const key = useMemo(() => awakeSessions(on, data ?? []).join(','), [on, data]);
  useEffect(() => {
    desktop?.keepAwake.set(key ? key.split(',') : []);
  }, [key]);
  return null;
}
