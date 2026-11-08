/**
 * A session's state as a client holds it (the reconnect contract, ARCHITECTURE §2): built from the snapshot that
 * `sessions.subscribe` returns, then moved on by each run event with a higher `seq`. Pure, so the app and the terminal
 * apply events the same way.
 */
import { isCoopMirror } from '@atelier/protocol';
import type { ArtifactSummary, BackgroundTask, ContextUsage, ImageProgress, LimitWarning, Message, OutboxMessage, Participant, PendingInteraction, RunEvent, RunPhase, SessionSnapshot, SessionSummary, Todo } from '@atelier/protocol';

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
  /** How far running image generations are, by call id. */
  toolProgress?: Record<string, ImageProgress>;
  /** A short guess at the person's next message (Code and Cowork): the message box shows it while empty. */
  suggestion: string | null;
  /** The person passed 80% of a usage limit: shown above the message box until their next turn starts. */
  limitWarning?: LimitWarning | null;
  /** When the run going on began, from the server; null or absent while none runs (or from a server too old to say). */
  runStartedAt?: number | null;
  /** Co-op: who is in the session and online, from the latest `presence` event; absent until one arrives. */
  participants?: Participant[] | null;
  /** Co-op: when each participant last said they were typing (this window's clock); it lapses after `TYPING_LAPSE_MS`. */
  typing?: Record<string, number>;
  /** Co-op, on a guest's computer: the host's computer can't be reached right now (the `host_away` event, or a call that said so). */
  hostAway?: boolean;
  /** Co-op: the emoji people put on messages, by message id. */
  reactions?: Record<string, { emoji: string; participants: string[] }[]>;
  /** Co-op: what the host's backend refused last (a model the person may not use…), shown above the message box until dismissed. */
  coopNotice?: string | null;
  seq: number;
}

/** A reaction put on (`on`) or taken off a message's list. */
function react(list: { emoji: string; participants: string[] }[] = [], participantId: string, emoji: string, on: boolean): { emoji: string; participants: string[] }[] {
  const others = list.find((r) => r.emoji === emoji)?.participants.filter((p) => p !== participantId) ?? [];
  const participants = on ? [...others, participantId] : others;
  const rest = list.filter((r) => r.emoji !== emoji);
  return participants.length ? [...rest, { emoji, participants }] : rest;
}

/** How long "is typing" lasts after the last `typing` event (they come at most every 2 s while someone types). */
export const TYPING_LAPSE_MS = 5000;

/** Someone's typing ends with what they sent: their message, or one of theirs waiting. */
function doneTyping(typing: Record<string, number> | undefined, authors: (string | undefined)[]): Record<string, number> | undefined {
  if (!typing || !authors.some((a) => a && a in typing)) return typing;
  const next = { ...typing };
  for (const a of authors) if (a) delete next[a];
  return next;
}

/**
 * When the turn on screen began, for the running line's clock: the person's latest message, or the run's start where that
 * is later. A retry keeps the message and a woken turn has none of its own, so their clock starts again from zero.
 */
export function turnStart(state: Pick<LiveSessionState, 'messages' | 'runStartedAt'>): number | undefined {
  const sent = state.messages.findLast((m) => m.role === 'user' && m.kind === 'normal')?.createdAt;
  if (!state.runStartedAt) return sent;
  return sent === undefined ? state.runStartedAt : Math.max(sent, state.runStartedAt);
}

/** The line for a run waiting on its model's server, with how many requests (or sub-agents) go first. */
export const queuedLabel = (ahead: number): string =>
  ahead > 0 ? `Waiting in line for the model · ${ahead} ${ahead === 1 ? 'request' : 'requests'} ahead` : 'Waiting for the model';

/** Hover text for the waiting line: a model server on this computer or network answers one request at a time. */
export const QUEUE_HELP = 'This model’s server answers one request at a time. Yours starts as soon as the ones ahead of it are done.';

/** How much live tool output to keep per call (the backend's snapshot keeps the same tail). */
const OUTPUT_TAIL_CHARS = 30_000;

export const initialLiveState: LiveSessionState = {
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
  toolProgress: {},
  suggestion: null,
  limitWarning: null,
  runStartedAt: null,
  seq: 0,
};

export function fromSnapshot(s: SessionSnapshot, artifacts: ArtifactSummary[]): LiveSessionState {
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
    toolProgress: s.toolProgress ?? {},
    suggestion: s.suggestion ?? null,
    limitWarning: s.limitWarning ?? null,
    runStartedAt: s.runStartedAt ?? null,
    ...(s.reactions ? { reactions: s.reactions } : {}),
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

/**
 * Co-op, on a guest's computer: what its own backend says about the link to the host rather than passing on from the
 * host (the host's computer away or back, the link back after a gap, co-op ended). It carries the last number the host
 * gave, so it can't be told apart by its number: the host's own events keep the usual rule.
 */
export function fromGateway(sessionId: string, event: RunEvent): boolean {
  return event.type === 'host_away' || event.type === 'resync' || (event.type === 'presence' && event.participants.length === 0 && isCoopMirror(sessionId));
}

/** The event changes which messages make up the branch, so this window takes the backend's view of it again. */
export function needsReload(state: LiveSessionState, event: RunEvent): boolean {
  // `resync`: a co-op guest's link to the host came back after a gap, and events may have gone missing meanwhile.
  return event.type === 'compacted' || event.type === 'branch' || event.type === 'resync' || unknownParent(state, event);
}

/** A new message whose parent this window doesn't have: the conversation went on from a branch it never loaded. */
function unknownParent(state: LiveSessionState, event: RunEvent): boolean {
  if (event.type !== 'message' || !event.message.parentId || !state.messages.length) return false;
  const known = (id: string) => state.messages.some((m) => m.id === id);
  return !known(event.message.id) && !known(event.message.parentId);
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
        ...(m.role === 'tool' ? { toolOutput: {}, toolProgress: {} } : {}),
        ...(m.role === 'user' && m.author ? { typing: doneTyping(state.typing, [m.author]) } : {}),
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
    case 'status': {
      // Waiting on the person is still the same run; anything else but running ends it.
      const runStartedAt = event.runStartedAt ?? (event.status === 'running' || event.status === 'waiting' ? (state.runStartedAt ?? null) : null);
      return { ...state, session: state.session ? { ...state.session, status: event.status } : null, runStartedAt, ...(event.status !== 'running' ? { streamingMessageId: null, phase: null } : {}) };
    }
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
      return { ...state, outbox: event.items, typing: doneTyping(state.typing, event.items.map((m) => m.author)) };
    case 'compacted':
      return { ...state, context: null };
    case 'branch':
      return state;
    case 'suggestion':
      return { ...state, suggestion: event.text };
    case 'limit_warning':
      return { ...state, limitWarning: event.warning };
    case 'todos':
      return { ...state, todos: event.todos };
    case 'tasks':
      return { ...state, tasks: event.tasks };
    case 'pending':
      return { ...state, pending: event.pending };
    case 'tool_progress':
      return { ...state, toolProgress: { ...state.toolProgress, [event.callId]: event.progress } };
    case 'tool_output':
      return { ...state, toolOutput: { ...state.toolOutput, [event.callId]: ((state.toolOutput[event.callId] ?? '') + event.text).slice(-OUTPUT_TAIL_CHARS) } };
    case 'presence':
      return { ...state, participants: event.participants };
    case 'typing':
      return { ...state, typing: { ...state.typing, [event.participantId]: Date.now() } };
    case 'host_away':
      return { ...state, hostAway: event.away };
    case 'resync':
      return state;
    case 'reaction':
      return { ...state, reactions: { ...state.reactions, [event.messageId]: react(state.reactions?.[event.messageId], event.participantId, event.emoji, event.on) } };
  }
}

