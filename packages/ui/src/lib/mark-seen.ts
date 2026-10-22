import { useEffect } from 'react';
import type { SessionStatus } from '@atelier/protocol';
import { rpc } from './rpc.ts';

/**
 * Tells the backend the person is looking at this session, so the sidebar's "finished" dot (set when a turn ended
 * while they were elsewhere) goes away: on opening it, and again whenever a turn ends while they watch. A hidden
 * window isn't looking; it counts again when it comes back.
 */
export function useMarkSeen(sessionId: string, status: SessionStatus | undefined): void {
  useEffect(() => {
    if (!status || status === 'running') return;
    const mark = () => {
      if (document.visibilityState === 'visible') void rpc().call('sessions.markSeen', { id: sessionId }).catch(() => undefined);
    };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [sessionId, status]);
}
