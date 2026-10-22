/**
 * Client side of the reconnect contract: subscribe → snapshot, buffer events that arrive first, then
 * apply only events with seq > snapshot.seq. One store per open session, ref-counted.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ArtifactSummary, BackgroundTask, ContextUsage, Message, OutboxMessage, PendingInteraction, RunEvent, RunPhase, SessionSnapshot, SessionSummary, Todo } from '@atelier/protocol';
import { rpc } from './rpc.ts';
import { getTransport } from './platform.ts';

export interface LiveSessionState {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  session: SessionSummary | null;
  messages: Message[];
  siblings: Record<string, string[]>;
  streamingMessageId: string | null;
  /** Partial tool-call JSON while it streams, keyed `${messageId}:${index}`. */
  toolInputs: Record<string, string>;
  context: ContextUsage | null;
  /** The conversation is being summarized. */
  compacting: boolean;
  /** Waiting for a turn on the model's server, with this many ahead. */
  queued: number | null;
  /** A local model's server is loading the model or reading the prompt, before the reply's first output. */
  phase: RunPhase | null;
  retryAttempt?: number;
  /** Messages sent while the agent worked that it hasn't taken yet (shown as waiting, with Send now and take back). */
  outbox: OutboxMessage[];
  artifacts: Record<string, ArtifactSummary>;
  /** The permission prompt or question the run waits on. */
  pending: PendingInteraction | null;
  todos: Todo[];
  /** Background commands and sub-agents (the Background tasks pane). */
  tasks: BackgroundTask[];
  /** Live output of running tool calls (Bash), by call id; cleared when the results arrive. */
  toolOutput: Record<string, string>;
  seq: number;
}

/** The line for a run waiting on its model's server, with how many requests (or sub-agents) go first. */
export const queuedLabel = (ahead: number): string =>
  ahead > 0 ? `Waiting in line for the model · ${ahead} ${ahead === 1 ? 'request' : 'requests'} ahead` : 'Waiting for the model';

/** Hover text for the waiting line: a model server on this computer or network answers one request at a time. */
export const QUEUE_HELP = 'This model’s server answers one request at a time. Yours starts as soon as the ones ahead of it are done.';

/** How much live tool output to keep per call (the backend's snapshot keeps the same tail). */
const OUTPUT_TAIL_CHARS = 30_000;

const initial: LiveSessionState = {
  status: 'loading',
  error: null,
  session: null,
  messages: [],
  siblings: {},
  streamingMessageId: null,
  toolInputs: {},
  context: null,
  compacting: false,
  queued: null,
  phase: null,
  outbox: [],
  artifacts: {},
  pending: null,
  todos: [],
  tasks: [],
  toolOutput: {},
  seq: 0,
};

interface Entry {
  store: StoreApi<LiveSessionState>;
  refs: number;
  buffer: { seq: number; event: RunEvent }[] | null;
  release?: ReturnType<typeof setTimeout>;
}

const entries = new Map<string, Entry>();
let wired = false;

function wire(): void {
  if (wired) return;
  wired = true;
  rpc().on('session.event', ({ sessionId, seq, event }) => {
    const entry = entries.get(sessionId);
    if (!entry) return;
    if (entry.buffer) entry.buffer.push({ seq, event });
    // Compaction can slot its summary in before the newest message: take the backend's view of the branch.
    else if (event.type === 'compacted') void load(sessionId, entry);
    else if (seq > entry.store.getState().seq) entry.store.setState((s) => ({ ...applyEvent(s, event), seq }));
  });
  rpc().on('sessions.changed', (summary) => {
    const entry = entries.get(summary.id);
    if (entry) entry.store.setState({ session: summary });
  });
  getTransport().onReconnect(() => {
    for (const [id, entry] of entries) void load(id, entry);
  });
}

async function load(sessionId: string, entry: Entry): Promise<void> {
  entry.buffer = [];
  try {
    const snapshot = await rpc().call('sessions.subscribe', { id: sessionId });
    const artifacts = await rpc().call('artifacts.list', { sessionId });
    let state = fromSnapshot(snapshot, artifacts);
    for (const { seq, event } of entry.buffer) if (seq > state.seq) state = { ...applyEvent(state, event), seq };
    entry.buffer = null;
    entry.store.setState(state, true);
  } catch (error) {
    entry.buffer = null;
    entry.store.setState({ status: 'error', error: error instanceof Error ? error.message : 'Could not load this conversation' });
  }
}

function fromSnapshot(s: SessionSnapshot, artifacts: ArtifactSummary[]): LiveSessionState {
  return {
    status: 'ready',
    error: null,
    session: s.session,
    messages: s.messages,
    siblings: s.siblings,
    streamingMessageId: s.streamingMessageId,
    toolInputs: {},
    context: s.context,
    compacting: s.compacting,
    queued: s.queued,
    phase: s.phase,
    retryAttempt: s.retryAttempt,
    outbox: s.outbox,
    artifacts: Object.fromEntries(artifacts.map((a) => [a.id, a])),
    pending: s.pending,
    todos: s.todos,
    tasks: s.tasks,
    toolOutput: s.toolOutput,
    seq: s.seq,
  };
}

function updateMessage(state: LiveSessionState, id: string, fn: (m: Message) => Message): LiveSessionState {
  const index = state.messages.findIndex((m) => m.id === id);
  if (index === -1) return state;
  const messages = state.messages.slice();
  messages[index] = fn(messages[index]!);
  return { ...state, messages };
}

export function applyEvent(state: LiveSessionState, event: RunEvent): LiveSessionState {
  // Output of the streaming reply ends the phase before it, should its own event go missing.
  if (state.phase && (event.type === 'part' || event.type === 'delta') && event.messageId === state.streamingMessageId) state = { ...state, phase: null };
  switch (event.type) {
    case 'message': {
      const m = event.message;
      if (state.messages.some((x) => x.id === m.id)) {
        const next = updateMessage(state, m.id, () => m);
        return { ...next, toolInputs: Object.fromEntries(Object.entries(next.toolInputs).filter(([key]) => !key.startsWith(`${m.id}:`))) };
      }
      // Truncate to the parent (an edit/retry starts a new branch) and record the sibling group.
      const parentIndex = m.parentId ? state.messages.findIndex((x) => x.id === m.parentId) : -1;
      const replaced = state.messages[parentIndex + 1];
      const messages = [...state.messages.slice(0, parentIndex + 1), m];
      const siblings = { ...state.siblings };
      if (replaced && replaced.parentId === m.parentId) {
        const group = [...(siblings[replaced.id] ?? [replaced.id]), m.id];
        for (const id of group) siblings[id] = group;
      }
      return {
        ...state,
        messages,
        siblings,
        streamingMessageId: m.role === 'assistant' && !m.stopReason ? m.id : state.streamingMessageId,
        ...(m.role === 'tool' ? { toolOutput: {} } : {}),
      };
    }
    case 'part':
      return updateMessage(state, event.messageId, (m) => {
        const parts = m.parts.slice();
        parts[event.index] = event.part;
        return { ...m, parts };
      });
    case 'delta': {
      if (event.kind === 'tool_input') {
        const key = `${event.messageId}:${event.index}`;
        return { ...state, toolInputs: { ...state.toolInputs, [key]: (state.toolInputs[key] ?? '') + event.text } };
      }
      return updateMessage(state, event.messageId, (m) => {
        const parts = m.parts.slice();
        const part = parts[event.index];
        if (part && (part.type === 'text' || part.type === 'thinking')) parts[event.index] = { ...part, text: part.text + event.text };
        return { ...m, parts };
      });
    }
    case 'done': {
      const next = updateMessage(state, event.messageId, (m) => ({
        ...m,
        usage: event.usage,
        stopReason: (event.stopReason as Message['stopReason']) ?? 'end',
        error: event.error,
      }));
      return { ...next, streamingMessageId: next.streamingMessageId === event.messageId ? null : next.streamingMessageId };
    }
    case 'status':
      return { ...state, session: state.session ? { ...state.session, status: event.status } : null, ...(event.status !== 'running' ? { streamingMessageId: null, phase: null } : {}) };
    case 'context':
      return { ...state, context: event.context };
    case 'title':
      return { ...state, session: state.session ? { ...state.session, title: event.title } : null };
    case 'artifact':
      return { ...state, artifacts: { ...state.artifacts, [event.artifact.id]: event.artifact } };
    case 'compacting':
      return { ...state, compacting: event.active };
    case 'queued':
      return { ...state, queued: event.ahead };
    case 'phase':
      return { ...state, phase: event.phase, retryAttempt: event.phase === 'retrying' ? event.retryAttempt : undefined };
    case 'outbox':
      return { ...state, outbox: event.items };
    case 'compacted':
      return { ...state, context: null };
    case 'todos':
      return { ...state, todos: event.todos };
    case 'tasks':
      return { ...state, tasks: event.tasks };
    case 'pending':
      return { ...state, pending: event.pending };
    case 'tool_output':
      return { ...state, toolOutput: { ...state.toolOutput, [event.callId]: ((state.toolOutput[event.callId] ?? '') + event.text).slice(-OUTPUT_TAIL_CHARS) } };
  }
}

function entryFor(sessionId: string): Entry {
  wire();
  let entry = entries.get(sessionId);
  if (!entry) {
    entry = { store: createStore<LiveSessionState>(() => initial), refs: 0, buffer: null };
    entries.set(sessionId, entry);
    void load(sessionId, entry);
    // Made during a render that may never commit: it ends on its own unless a component retains it.
    scheduleRelease(sessionId, entry);
  }
  return entry;
}

function retain(sessionId: string): void {
  const entry = entryFor(sessionId);
  clearTimeout(entry.release);
  entry.refs++;
}

function release(sessionId: string): void {
  const entry = entries.get(sessionId);
  if (!entry) return;
  entry.refs--;
  // Leaving a temporary chat deletes it (unless another window has it open), so it isn't kept around for a return.
  if (entry.refs === 0) scheduleRelease(sessionId, entry, entry.store.getState().session?.temporary ? LEAVE_TEMPORARY_MS : RELEASE_MS);
}

const RELEASE_MS = 30_000;
/** Long enough for a remount in the same render pass (Strict Mode, a moved component) to keep it. */
export const LEAVE_TEMPORARY_MS = 1_000;

/** Keeps the subscription briefly so quick navigations back are instant, then ends it. */
function scheduleRelease(sessionId: string, entry: Entry, ms = RELEASE_MS): void {
  clearTimeout(entry.release);
  entry.release = setTimeout(() => {
    if (entries.get(sessionId) !== entry || entry.refs > 0) return;
    entries.delete(sessionId);
    const leave = !!entry.store.getState().session?.temporary;
    void rpc().call(leave ? 'sessions.leave' : 'sessions.unsubscribe', { id: sessionId }).catch(() => {});
  }, ms);
}

/** Counted per mounted component (not per render), so the subscription ends 30s after the last one unmounts. */
export function useLiveSession(sessionId: string): LiveSessionState {
  const entry = entryFor(sessionId);
  useEffect(() => {
    retain(sessionId);
    return () => release(sessionId);
  }, [sessionId]);
  return useSyncExternalStore(entry.store.subscribe, entry.store.getState);
}

/**
 * `select` over a session's live state, re-evaluated at most every `ms` after it changes: for counters that move on
 * every streamed delta. `select` must be stable (a module-level function); the session must be held by a component
 * above (`useLiveSession`).
 */
export function useThrottledLive<T>(sessionId: string, select: (state: LiveSessionState) => T, ms: number): T {
  const entry = entryFor(sessionId);
  const [value, setValue] = useState(() => select(entry.store.getState()));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sample = () => {
      timer = undefined;
      const next = select(entry.store.getState());
      setValue((prev) => (shallowEqual(prev, next) ? prev : next));
    };
    sample();
    const unsubscribe = entry.store.subscribe(() => void (timer ??= setTimeout(sample, ms)));
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [entry, select, ms]);
  return value;
}

function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Replaces local state with a snapshot returned by a call (e.g. switching branches). */
export function resetFromSnapshot(sessionId: string, snapshot: SessionSnapshot): void {
  const entry = entries.get(sessionId);
  if (entry) entry.store.setState((s) => ({ ...fromSnapshot(snapshot, Object.values(s.artifacts)) }));
}
