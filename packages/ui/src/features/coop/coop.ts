/**
 * Co-op in the client (ARCHITECTURE §24, design/components.md › Co-op): two to four people in one session that runs on
 * its host's backend. A session page reads the co-op state once (`useCoop`) and hands it down (`CoopContext`), so the
 * header, the transcript, the waiting messages and the asks all see the same people. Outside a provider everything is
 * the solo view, as before co-op.
 *
 * The rules the UI follows are the backend's (packages/core/src/coop/rules.ts, agent/coop-turns.ts): the host decides
 * who is in and what they may do; everyone else takes part in their own messages and turns.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isCoopMirror, unescapeTags, type CoopSettings, type CoopState, type Message, type OutboxMessage, type Participant, type ParticipantRole, type PendingInteraction, type SessionSummary } from '@atelier/protocol';
import { toast } from '../../components/ui/index.ts';
import { TYPING_LAPSE_MS, isSharedSession, markHostAway, showCoopNotice, type LiveSessionState } from '../../lib/live-session.ts';
import { describeError, errorCode, rpc } from '../../lib/rpc.ts';

export const coopKey = (sessionId: string) => ['coop', sessionId] as const;

/** Sessions this window turned co-op on for (or joined) before their summary says so. */
const startedHere = new Set<string>();


/** Someone in the session as the transcript names them. */
export interface Person {
  id: string | null;
  name: string;
  avatar: string | null;
  /** The viewer. */
  me: boolean;
  /** They aren't in the session any more (or never were in this window's memory). */
  left: boolean;
}

export interface CoopView {
  sessionId: string | null;
  /** Co-op is on for the session (or this is a guest's view of one, ended or not). */
  shared: boolean;
  /** As the backend last said (`coop.state`); null while co-op is off or before it answered. */
  state: CoopState | null;
  /** The viewer's participant id; null outside co-op. */
  me: string | null;
  role: ParticipantRole;
  /** The viewer is the host (also outside co-op: a session of one's own). */
  isHost: boolean;
  hostId: string | null;
  hostName: string;
  /** Everyone in the session now, the host first. */
  people: Participant[];
  /** The host's computer can't be reached: what is sent waits for it. */
  hostAway: boolean;
  /** Co-op ended, or the viewer was removed: the session is read-only for a guest. */
  ended: boolean;
  /** Whoever wrote a message or a waiting one: an id without a match is someone who left. */
  person(id: string | null | undefined): Person;
  /** Tells the others the viewer is typing; at most every 2 s, and only where they can chat. */
  typing(): void;
}

const SOMEONE_WHO_LEFT = 'Someone who left';

const solo = (person: Person = { id: null, name: 'You', avatar: null, me: true, left: false }): CoopView => ({
  sessionId: null,
  shared: false,
  state: null,
  me: null,
  role: 'host',
  isHost: true,
  hostId: null,
  hostName: '',
  people: [],
  hostAway: false,
  ended: false,
  person: () => person,
  typing: () => {},
});

/** The view outside co-op: a session of one's own. */
export const SOLO: CoopView = solo();

export const CoopContext = createContext<CoopView>(SOLO);

/** The session's co-op view, from the page's `CoopContext`; the solo view outside one. */
export function useCoopView(): CoopView {
  return useContext(CoopContext);
}

/** Whether a session is, as far as its summary tells, a shared one for this viewer. */
export const coopHint = (session: Pick<SessionSummary, 'id' | 'coop'> | null | undefined): boolean => !!session && (!!session.coop || isCoopMirror(session.id));

/** "Ada", or "the host" when nobody said. */
const hostNameOf = (people: readonly Participant[], session: SessionSummary | null): string => people.find((p) => p.role === 'host')?.name ?? session?.coop?.hostName ?? 'the host';

const TYPING_EVERY_MS = 2000;

/**
 * The co-op view of a session page: `coop.state` (read while the session is shared, again after each `presence` event
 * and each `coop.*` call), the latest presence and who left. One per page; pass it down with `CoopContext`.
 */
export function useCoop(live: Pick<LiveSessionState, 'session' | 'participants' | 'hostAway'>): CoopView {
  const session = live.session;
  const sessionId = session?.id ?? null;
  const qc = useQueryClient();
  const hinted = coopHint(session) || (!!sessionId && startedHere.has(sessionId));
  const query = useQuery({
    queryKey: coopKey(sessionId ?? ''),
    queryFn: () => rpc().call('coop.state', { sessionId: sessionId! }),
    enabled: !!sessionId && !session?.temporary && hinted,
    retry: false,
    staleTime: 30_000,
  });
  const presence = live.participants;
  const away = live.hostAway;
  // Someone came, went, changed their part, the host's settings changed or the host's computer came back: read the
  // whole state again.
  useEffect(() => {
    if ((presence || away !== undefined) && sessionId) void qc.invalidateQueries({ queryKey: coopKey(sessionId) });
  }, [presence, away, sessionId, qc]);
  // A turn started or ended: a track may have started, finished or been merged meanwhile.
  const status = session?.status;
  useEffect(() => {
    if (status && sessionId) void qc.invalidateQueries({ queryKey: [...coopKey(sessionId), 'tracks'] });
  }, [status, sessionId, qc]);

  // Everyone this window has seen, so a message from someone who left during the session still names them.
  const seen = useRef(new Map<string, Participant>());
  const state = query.data ?? null;
  const lastTyped = useRef(0);
  useEffect(() => {
    for (const p of [...(state?.participants ?? []), ...(presence ?? [])]) seen.current.set(p.id, p);
  }, [state, presence]);

  return useMemo(() => {
    if (!sessionId || session?.temporary) return SOLO;
    const people = presence ?? state?.participants ?? [];
    const role: ParticipantRole = state?.role ?? session?.coop?.role ?? (isCoopMirror(sessionId) ? 'editor' : 'host');
    const isHost = role === 'host';
    // The host's co-op is on while the backend has a room; a guest's view stays (read-only once it ended).
    const shared = isHost ? !!state && !state.ended : true;
    if (!shared) return SOLO;
    const me = state?.me ?? null;
    const hostId = people.find((p) => p.role === 'host')?.id ?? (isHost ? me : null);
    // A guest who is no longer among the people (removed, or the host ended co-op) is out.
    const out = !isHost && !!presence && !!me && !presence.some((p) => p.id === me);
    const view: CoopView = {
      sessionId,
      shared,
      state,
      me,
      role,
      isHost,
      hostId,
      hostName: hostNameOf(people, session),
      people,
      // The latest word wins: the event (or a call that failed for it) over the state read before.
      hostAway: !isHost && !out && (away ?? !!state?.hostAway),
      ended: !!state?.ended || !!session?.coop?.ended || out,
      person: (id) => {
        // A message without an author is the host's (from before co-op, or the host's own).
        const key = id ?? hostId;
        const p = key ? (people.find((q) => q.id === key) ?? state?.participants.find((q) => q.id === key) ?? seen.current.get(key)) : undefined;
        if (!p) return { id: key ?? null, name: key && key === me ? 'You' : SOMEONE_WHO_LEFT, avatar: null, me: !!key && key === me, left: true };
        return { id: p.id, name: p.name, avatar: p.avatar, me: p.id === me, left: !people.some((q) => q.id === p.id) };
      },
      typing: () => {
        if (role === 'viewer' || !me) return;
        const now = Date.now();
        if (now - lastTyped.current < TYPING_EVERY_MS) return;
        lastTyped.current = now;
        void rpc().call('coop.typing', { sessionId }).catch(() => undefined);
      },
    };
    return view;
  }, [sessionId, session, state, presence, away]);
}

/**
 * A failed call's message as a toast, except the host's computer being away (`host_away`): that is no error, the
 * message box's banner says it calmly.
 */
export function reportError(sessionId: string | null | undefined, error: unknown): void {
  if (errorCode(error) === 'host_away') {
    if (sessionId) markHostAway(sessionId);
    return;
  }
  // What a shared session refuses (a model someone may not use, a part they don't have) says so above the box.
  if (errorCode(error) === 'invalid_request' && sessionId && isSharedSession(sessionId)) {
    showCoopNotice(sessionId, describeError(error).message);
    return;
  }
  toast.error(describeError(error).message);
}

/** Whether a failed call failed because the host's computer is away. */
export const hostAwayError = (error: unknown): boolean => errorCode(error) === 'host_away';

/** After a `coop.*` call: the state it returned, or a fresh read. */
export function useCoopActions(sessionId: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: coopKey(sessionId) });
  const put = (state: CoopState) => {
    startedHere.add(sessionId);
    qc.setQueryData(coopKey(sessionId), state);
    void refresh();
    return state;
  };
  return {
    refresh,
    start: () => rpc().call('coop.start', { sessionId }).then(put),
    invite: () => rpc().call('coop.invite', { sessionId }).finally(refresh),
    add: (userIds: string[], role: 'editor' | 'viewer') => rpc().call('coop.add', { sessionId, userIds, role }).then(put),
    admit: (knockId: string, allow: boolean) => rpc().call('coop.admit', { sessionId, knockId, allow }).finally(refresh),
    settings: (settings: Partial<CoopSettings>) => rpc().call('coop.settings', { sessionId, settings }).then(put),
    participant: (participantId: string, patch: { role?: 'editor' | 'viewer'; trusted?: boolean }) => rpc().call('coop.participant', { sessionId, participantId, ...patch }).then(put),
    remove: (participantId: string) => rpc().call('coop.remove', { sessionId, participantId }).finally(refresh),
    models: (models: 'host' | 'own', model: string | null) => rpc().call('coop.models', { sessionId, models, model }).then(put),
    lend: (lend: boolean) => rpc().call('coop.lend', { sessionId, lend }),
    navigate: (on: boolean) => rpc().call('coop.navigate', { sessionId, on }).then(put),
    leave: () => rpc().call('coop.leave', { sessionId }).finally(refresh),
    end: () =>
      rpc()
        .call('coop.end', { sessionId })
        .then((ok) => {
          startedHere.delete(sessionId);
          qc.setQueryData(coopKey(sessionId), null);
          return ok;
        }),
  };
}

/** A user message that is only Atelier's own notes (a roster note, a hook's feedback), not anyone's words. */
const onlyNotes = (m: Message) => m.parts.length > 0 && m.parts.every((p) => p.type === 'context');

/**
 * Whom the latest turn is (or was) for: the reply's own author when it says, else the author of the person's message
 * that opened it, else the host's.
 */
export function turnOwner(messages: readonly Message[], hostId: string | null): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'assistant' && m.author) return m.author;
    if (m.role === 'user' && m.kind === 'normal' && !onlyNotes(m)) return m.author ?? hostId;
  }
  return hostId;
}

/** Whether the viewer wrote a waiting message (one without an author is the host's). */
export const wroteIt = (item: OutboxMessage, coop: Pick<CoopView, 'me' | 'hostId' | 'shared'>): boolean => !coop.shared || (item.author ?? coop.hostId) === coop.me;

/**
 * Whether the viewer may answer what the run waits on: whoever owns what is at risk approves it (`approver`, the host when
 * it names nobody), and a guest the host trusts may answer the host's.
 */
export function mayAnswer(pending: Pick<PendingInteraction, 'approver'>, coop: CoopView): boolean {
  if (!coop.shared) return true;
  const approver = pending.approver ?? coop.hostId;
  if (!approver || approver === coop.me) return true;
  const me = coop.people.find((p) => p.id === coop.me);
  return !!me?.trusted && coop.role !== 'viewer' && approver === coop.hostId;
}

/** "Ben is typing…", "Ben and Cy are typing…", "3 people are typing…" for the others typing now; null for nobody. */
export function typingLine(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return `${names.length} people are typing…`;
}

/** The others who typed in the last 5 s, re-checked as each lapses. */
export function useTypingNames(typing: Record<string, number> | undefined, coop: CoopView): string[] {
  // The clock moves when one lapses; an event newer than it is fresh until then.
  const [now, setNow] = useState(() => Date.now());
  const fresh = Object.entries(typing ?? {}).filter(([id, at]) => id !== coop.me && now - at < TYPING_LAPSE_MS);
  const next = fresh.length ? Math.min(...fresh.map(([, at]) => at + TYPING_LAPSE_MS)) : null;
  useEffect(() => {
    if (next === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()) + 20);
    return () => clearTimeout(timer);
  }, [next]);
  if (!coop.shared) return [];
  return fresh.map(([id]) => coop.person(id)).filter((p) => !p.left).map((p) => p.name);
}

/** The time now, again every `ms` (null: only once). */
export function useNow(ms: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (ms === null) return;
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** "4:12": minutes and seconds left until `at`, never below 0:00. */
export function countdown(at: number, now: number): string {
  const s = Math.max(0, Math.ceil((at - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "Expires in 24 h", "Expires in 40 min", "Expires in under a minute". */
export function expiresIn(at: number, now: number): string {
  const min = Math.floor((at - now) / 60_000);
  if (min >= 60) return `Expires in ${Math.round(min / 60)} h`;
  if (min >= 1) return `Expires in ${min} min`;
  return at > now ? 'Expires in under a minute' : 'Expired';
}

/** "Ada’s": a name's possessive. */
export const possessive = (name: string): string => `${name}’s`;

/** Today's use of the host's models by this guest: "12 of 50 today", "$0.40 of $2.00 today". */
export function sharedUseLine(state: CoopState): string | null {
  const used = state.sharedUse;
  if (!used) return null;
  const s = state.settings;
  const parts = [
    s.sharedRequestsPerDay !== null ? `${used.requests} of ${s.sharedRequestsPerDay} today` : `${used.requests} ${used.requests === 1 ? 'request' : 'requests'} today`,
    ...(s.sharedSpendPerDayUsd !== null ? [`$${used.spentUsd.toFixed(2)} of $${s.sharedSpendPerDayUsd.toFixed(2)}`] : []),
  ];
  return parts.join(' · ');
}

/** A navigator's note in an Edit's or Write's result: `<navigator name="Ben">…</navigator>` (escaped by the backend). */
export interface NavigatorNote {
  name: string;
  text: string;
}

/** The navigator's notes in a tool result's text, and the text without them. */
export function navigatorNotes(text: string): { notes: NavigatorNote[]; rest: string } {
  const notes: NavigatorNote[] = [];
  const rest = text.replace(/<navigator name="([^"]*)">\n?([\s\S]*?)\n?<\/navigator>/g, (_, name: string, body: string) => {
    notes.push({ name: unescapeTags(name), text: unescapeTags(body).trim() });
    return '';
  });
  return { notes, rest: rest.trim() };
}
