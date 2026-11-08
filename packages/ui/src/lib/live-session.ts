/**
 * Client side of the reconnect contract (`@atelier/client`'s live sessions) as React hooks: one store per open session,
 * held while a component shows it and released 30 s after the last one unmounts.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { SessionSnapshot } from '@atelier/protocol';
import { createLiveSessions } from '@atelier/client/live-sessions.ts';
import type { LiveSessionState } from '@atelier/client/live-state.ts';
import { rpc } from './rpc.ts';
import { getTransport } from './platform.ts';

export { applyEvent, QUEUE_HELP, queuedLabel, turnStart, TYPING_LAPSE_MS, type LiveSessionState } from '@atelier/client/live-state.ts';
export { LEAVE_TEMPORARY_MS } from '@atelier/client/live-sessions.ts';

const live = createLiveSessions({ rpc, onReconnect: (handler) => void getTransport().onReconnect(handler) });

/** Counted per mounted component (not per render), so the subscription ends 30s after the last one unmounts. */
export function useLiveSession(sessionId: string): LiveSessionState {
  const store = live.store(sessionId);
  useEffect(() => {
    live.retain(sessionId);
    return () => live.release(sessionId);
  }, [sessionId]);
  return useSyncExternalStore(store.subscribe, store.getState);
}

/**
 * `select` over a session's live state, re-evaluated at most every `ms` after it changes: for counters that move on
 * every streamed delta. `select` must be stable (a module-level function); the session must be held by a component
 * above (`useLiveSession`).
 */
export function useThrottledLive<T>(sessionId: string, select: (state: LiveSessionState) => T, ms: number): T {
  const store = live.store(sessionId);
  const [value, setValue] = useState(() => select(store.getState()));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sample = () => {
      timer = undefined;
      const next = select(store.getState());
      setValue((prev) => (shallowEqual(prev, next) ? prev : next));
    };
    sample();
    const unsubscribe = store.subscribe(() => void (timer ??= setTimeout(sample, ms)));
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [store, select, ms]);
  return value;
}

function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Co-op: a call to a session on the host's computer said it can't be reached (`host_away`), before the event did. */
export const markHostAway = (sessionId: string): void => live.markHostAway(sessionId);

/** Co-op: says above the message box why the host's backend refused something (null clears it). */
export const showCoopNotice = (sessionId: string, text: string | null): void => live.showCoopNotice(sessionId, text);

/** Whether a session open in this window is a shared one (co-op), as its summary says. */
export const isSharedSession = (sessionId: string): boolean => live.isShared(sessionId);

/** Replaces local state with a snapshot returned by a call (e.g. switching branches). */
export const resetFromSnapshot = (sessionId: string, snapshot: SessionSnapshot): void => live.resetFromSnapshot(sessionId, snapshot);
