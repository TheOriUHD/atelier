/**
 * "Run on this computer" (ARCHITECTURE §21): one person, no password, and an optional screen lock kept by the backend.
 * `isLocal` is known once the sign-in gate has read the backend's status, before any page renders.
 */
import { useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ScreenLockStatus } from '@atelier/protocol';
import { toast } from '../../components/ui/toaster.tsx';
import { keys } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';

let local = false;

/** The desktop app's own backend: sign-in, sessions, devices and passwords don't apply. */
export function isLocal(): boolean {
  return local;
}

export function setLocal(value: boolean): void {
  local = value;
}

/** The screen lock's status, kept current by `lock.changed`. Nothing is asked of a server. */
export function useScreenLock(): ScreenLockStatus | undefined {
  const qc = useQueryClient();
  const enabled = isLocal();
  const { data } = useQuery({ queryKey: keys.screenLock, queryFn: () => rpc().call('lock.status', {}), enabled });
  useEffect(
    () => (enabled ? rpc().on('lock.changed', (s) => qc.setQueryData(keys.screenLock, s)) : undefined),
    [qc, enabled],
  );
  return data;
}

/** "Lock now" from the menu, the command palette and Settings. Without a lock set it says where to set one. */
export function useLockNow(openSettings: (page?: string, row?: string) => void): () => void {
  const lock = useScreenLock();
  return useCallback(() => {
    if (!isLocal()) return;
    if (!lock?.enabled) {
      toast.message('Set a PIN or password first', { description: 'Then Atelier can lock.' });
      openSettings('account', 'account.screenLock');
      return;
    }
    rpc()
      .call('lock.lock', {})
      .catch((e: unknown) => toast.error(describeError(e).message));
  }, [lock?.enabled, openSettings]);
}

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
/** How often a window tells the others it is in use. */
const SHARE_EVERY_MS = 10_000;
const CHECK_EVERY_MS = 15_000;

/**
 * Locks after `minutes` without input in any of the app's windows (they share their last input over a
 * BroadcastChannel, so working in one window keeps the others open). 0 is never.
 */
export function useAutoLock(minutes: number, active: boolean): void {
  useEffect(() => {
    if (!active || minutes <= 0) return;
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('atelier-activity');
    let last = Date.now();
    let shared = 0;
    const seen = () => {
      last = Date.now();
      if (last - shared < SHARE_EVERY_MS) return;
      shared = last;
      channel?.postMessage(last);
    };
    if (channel) channel.onmessage = (e: MessageEvent<number>) => void (last = Math.max(last, e.data));
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, seen, { passive: true, capture: true });
    const timer = setInterval(() => {
      if (Date.now() - last >= minutes * 60_000)
        void rpc()
          .call('lock.lock', {})
          .catch(() => undefined);
    }, CHECK_EVERY_MS);
    return () => {
      clearInterval(timer);
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, seen, { capture: true });
      channel?.close();
    };
  }, [minutes, active]);
}
