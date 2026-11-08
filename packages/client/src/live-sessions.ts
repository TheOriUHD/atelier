/**
 * Client side of the reconnect contract: subscribe → snapshot, buffer events that arrive first, then apply only events
 * with seq > snapshot.seq. One store per open session, ref-counted, released 30 s after the last holder lets go. The
 * desktop and web app (React hooks over it) and the terminal app share it; each passes its own RPC client.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import { isCoopMirror, type AppContract, type RpcClient, type SessionSnapshot } from '@atelier/protocol';
import { applyEvent, fromGateway, fromSnapshot, initialLiveState, needsReload, type LiveSessionState } from './live-state.ts';

export interface LiveSessionsOptions {
  /** The RPC client, asked for when first needed (the app makes its own lazily). */
  rpc(): RpcClient<AppContract>;
  /** Runs `handler` after the transport connects again, so every open session loads anew. */
  onReconnect(handler: () => void): void;
  /** How long a session stays subscribed after its last holder let go (30 s). */
  releaseMs?: number;
}

interface Entry {
  store: StoreApi<LiveSessionState>;
  refs: number;
  buffer: { seq: number; event: import('@atelier/protocol').RunEvent }[] | null;
  release?: ReturnType<typeof setTimeout>;
}

/** Long enough for a remount in the same render pass (Strict Mode, a moved component) to keep it. */
export const LEAVE_TEMPORARY_MS = 1_000;
const RELEASE_MS = 30_000;

export type LiveSessions = ReturnType<typeof createLiveSessions>;

export function createLiveSessions(options: LiveSessionsOptions) {
  const entries = new Map<string, Entry>();
  const releaseMs = options.releaseMs ?? RELEASE_MS;
  let wired = false;

  function wire(): void {
    if (wired) return;
    wired = true;
    const rpc = options.rpc();
    rpc.on('session.event', ({ sessionId, seq, event }) => {
      const entry = entries.get(sessionId);
      if (!entry) return;
      // Made up by a co-op guest's own backend, under the session's last number: applied whatever it is, and left as it is.
      if (fromGateway(sessionId, event)) {
        if (event.type === 'resync') void load(sessionId, entry);
        else if (entry.buffer) entry.buffer.push({ seq, event });
        else entry.store.setState((s) => applyEvent(s, event));
        return;
      }
      if (entry.buffer) entry.buffer.push({ seq, event });
      // Compaction can slot its summary in before the newest message, a switch or rewind changes the branch, and a message
      // can follow one this window never had (it moved elsewhere): take the backend's view of the branch.
      else if (needsReload(entry.store.getState(), event)) void load(sessionId, entry);
      else if (seq > entry.store.getState().seq) entry.store.setState((s) => ({ ...applyEvent(s, event), seq }));
    });
    rpc.on('sessions.changed', (summary) => {
      const entry = entries.get(summary.id);
      if (entry) entry.store.setState({ session: summary });
    });
    // Deleted elsewhere (another window, the other half of a split view, Delete all): say so instead of failing on send.
    rpc.on('sessions.removed', ({ id }) => {
      const entry = entries.get(id);
      // A co-op session on someone else's computer goes from the sidebar when it ended and a copy took its place.
      if (entry) entry.store.setState({ status: 'error', error: isCoopMirror(id) ? 'Co-op ended. If the host kept you a copy, it’s in your sidebar.' : 'This conversation was deleted.' });
    });
    options.onReconnect(() => {
      for (const [id, entry] of entries) void load(id, entry);
    });
  }

  async function load(sessionId: string, entry: Entry): Promise<void> {
    entry.buffer = [];
    try {
      const rpc = options.rpc();
      const snapshot = await rpc.call('sessions.subscribe', { id: sessionId });
      const artifacts = await rpc.call('artifacts.list', { sessionId });
      let state = fromSnapshot(snapshot, artifacts);
      for (const { seq, event } of entry.buffer) {
        if (fromGateway(sessionId, event)) {
          state = applyEvent(state, event);
          continue;
        }
        if (seq <= state.seq) continue;
        // The branch changed again while this loaded (a second compaction slotted its summary in, a switch): the events
        // after it name messages this snapshot doesn't have, and applied anyway one would cut the list down to itself.
        if (needsReload(state, event)) return await load(sessionId, entry);
        state = { ...applyEvent(state, event), seq };
      }
      entry.buffer = null;
      entry.store.setState(state, true);
    } catch (error) {
      entry.buffer = null;
      entry.store.setState({ status: 'error', error: error instanceof Error ? error.message : 'Could not load this conversation' });
    }
  }

  function entryFor(sessionId: string): Entry {
    wire();
    let entry = entries.get(sessionId);
    if (!entry) {
      entry = { store: createStore<LiveSessionState>(() => initialLiveState), refs: 0, buffer: null };
      entries.set(sessionId, entry);
      void load(sessionId, entry);
      // Made during a render that may never commit: it ends on its own unless a holder retains it.
      scheduleRelease(sessionId, entry);
    }
    return entry;
  }

  /** Keeps the subscription briefly so quick navigations back are instant, then ends it. */
  function scheduleRelease(sessionId: string, entry: Entry, ms = releaseMs): void {
    clearTimeout(entry.release);
    entry.release = setTimeout(() => {
      if (entries.get(sessionId) !== entry || entry.refs > 0) return;
      entries.delete(sessionId);
      const leave = !!entry.store.getState().session?.temporary;
      void options
        .rpc()
        .call(leave ? 'sessions.leave' : 'sessions.unsubscribe', { id: sessionId })
        .catch(() => {});
    }, ms);
    entry.release.unref?.();
  }

  return {
    /** The session's store, subscribing to it on first use. */
    store(sessionId: string): StoreApi<LiveSessionState> {
      return entryFor(sessionId).store;
    },
    /** One more holder of the session; pair with `release`. */
    retain(sessionId: string): void {
      const entry = entryFor(sessionId);
      clearTimeout(entry.release);
      entry.refs++;
    },
    release(sessionId: string): void {
      const entry = entries.get(sessionId);
      if (!entry) return;
      entry.refs--;
      // Leaving a temporary chat deletes it (unless another window has it open), so it isn't kept around for a return.
      if (entry.refs === 0) scheduleRelease(sessionId, entry, entry.store.getState().session?.temporary ? LEAVE_TEMPORARY_MS : releaseMs);
    },
    /** Loads the session again from a fresh snapshot (after a call that changed it, or when the client wants it). */
    reload(sessionId: string): Promise<void> {
      const entry = entries.get(sessionId);
      return entry ? load(sessionId, entry) : Promise.resolve();
    },
    /** Co-op: a call to a session on the host's computer said it can't be reached (`host_away`), before the event did. */
    markHostAway(sessionId: string): void {
      const entry = entries.get(sessionId);
      if (entry && !entry.store.getState().hostAway) entry.store.setState({ hostAway: true });
    },
    /** Co-op: says above the message box why the host's backend refused something (null clears it). */
    showCoopNotice(sessionId: string, text: string | null): void {
      entries.get(sessionId)?.store.setState({ coopNotice: text });
    },
    /** Whether a session open here is a shared one (co-op), as its summary says. */
    isShared(sessionId: string): boolean {
      return isCoopMirror(sessionId) || !!entries.get(sessionId)?.store.getState().session?.coop;
    },
    /** Replaces local state with a snapshot returned by a call (e.g. switching branches). */
    resetFromSnapshot(sessionId: string, snapshot: SessionSnapshot): void {
      const entry = entries.get(sessionId);
      if (entry) entry.store.setState((s) => ({ ...fromSnapshot(snapshot, Object.values(s.artifacts)) }));
    },
  };
}
