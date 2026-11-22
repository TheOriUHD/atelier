/**
 * System notifications: a conversation's turn finished, failed or started waiting for the person (a question or a
 * permission) while they were in another window or app. Every conversation counts: Code, Cowork tasks and chats.
 * Co-op (ARCHITECTURE §24): a shared session's question notifies only the person it is for (`coop.waitingOnYou`), on
 * the host's computer and in a session they joined alike; someone knocking on the host's session notifies the host, as
 * a notification in the background and a toast in front, wherever they are in the app.
 * Uses the HTML Notification API (browsers and Electron's renderer alike; on Windows the desktop app registers its app
 * id, without which the toasts don't show).
 */
import { useEffect, useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { SessionStatus, SessionSummary, UserPrefs } from '@atelier/protocol';
import { SESSION_ROUTE } from '../../app/navigation.ts';
import { toast } from '../../components/ui/index.ts';
import { openCoopPanel } from '../coop/coop.ts';
import { desktop } from '../../lib/platform.ts';
import { usePrefs, useSessions } from '../../lib/queries.ts';
import { rpc } from '../../lib/rpc.ts';
import { sessionTitle } from '../../lib/sessions.ts';
import { useUnifiedChat } from '../../lib/unified-chat.ts';

export type TaskEvent = 'finished' | 'failed' | 'input';

const TITLES: Record<TaskEvent, string> = { finished: 'Cowork task finished', failed: 'Cowork task failed', input: 'Cowork task needs your input' };
/** Chat and Cowork in one: a chat that worked as a task (it has a folder or its sandbox). */
const CHAT_TITLES: Record<TaskEvent, string> = { finished: 'Task finished', failed: 'Task failed', input: 'Task needs your input' };
const CODE_TITLES: Record<TaskEvent, string> = { finished: 'Code session finished', failed: 'Code session failed', input: 'Code session needs your input' };
/** A chat's reply, a quick question's included. */
const REPLY_TITLES: Record<TaskEvent, string> = { finished: 'Reply finished', failed: 'Reply failed', input: 'Chat needs your input' };

function titles(s: Pick<SessionSummary, 'mode' | 'workspaceId'>, unified: boolean): Record<TaskEvent, string> {
  if (s.mode === 'code') return CODE_TITLES;
  if (s.mode === 'work') return unified ? CHAT_TITLES : TITLES;
  return unified && s.workspaceId ? CHAT_TITLES : REPLY_TITLES;
}

/** What a status change means to the person: the run ended, failed, or now waits on a question or permission. */
export function taskEvent(previous: SessionStatus | undefined, next: SessionStatus): TaskEvent | null {
  if (previous === 'running' && next === 'waiting') return 'input';
  if (previous !== 'running' && previous !== 'waiting') return null;
  return next === 'idle' ? 'finished' : next === 'error' ? 'failed' : null;
}

const supported = () => typeof Notification !== 'undefined';

export function notificationsBlocked(): boolean {
  return supported() && Notification.permission === 'denied';
}

/**
 * Asks for permission once, while the person wants notifications. Browsers only ask from a click or key press,
 * so this runs when they start a Work task or turn the setting on, never on page load.
 */
export function askToNotify(prefs: Pick<UserPrefs, 'notifications'>): void {
  const { taskFinished, permissionNeeded } = prefs.notifications;
  if (supported() && Notification.permission === 'default' && (taskFinished || permissionNeeded)) void Notification.requestPermission();
}

function focusWindow(): void {
  if (desktop) desktop.focusWindow();
  else window.focus();
}

/** Someone asking to come into the host's session: what to tell the host, and what to do when they answer. */
export interface Knock {
  sessionId: string;
  id: string;
  name: string;
  title: string;
}

/**
 * Remembers each conversation's last status, so a change can be told apart from a repeat; in co-op also whether its
 * question was the person's and who knocked. `knocked` hears each new knock (the in-app toast, wherever the person is).
 */
export function createTaskNotifier(unified = false, knocked?: (knock: Knock, open: (sessionId: string) => void) => void) {
  const statuses = new Map<string, SessionStatus>();
  const mine = new Map<string, boolean>();
  const knocks = new Map<string, Set<string>>();
  const show = (title: string, body: string, tag: string, sessionId: string, open: (sessionId: string) => void) => {
    const notification = new Notification(title, { body, tag });
    notification.onclick = () => {
      notification.close();
      focusWindow();
      open(sessionId);
    };
  };
  const allowed = () => !document.hasFocus() && supported() && Notification.permission === 'granted';
  /** New knocks on the host's session: a toast where the person is, a notification when they are elsewhere. */
  const newKnocks = (session: SessionSummary, prefs: Pick<UserPrefs, 'notifications'> | undefined, open: (sessionId: string) => void) => {
    const now = session.coop?.role === 'host' ? (session.coop.knocking ?? []) : [];
    const before = knocks.get(session.id) ?? new Set<string>();
    knocks.set(session.id, new Set(now.map((k) => k.id)));
    for (const k of now) {
      if (before.has(k.id)) continue;
      const knock = { sessionId: session.id, id: k.id, name: k.name, title: sessionTitle(session) };
      knocked?.(knock, open);
      if (prefs?.notifications.permissionNeeded !== false && allowed()) show(`${k.name} wants to join`, `${knock.title}: compare the four emoji, then let them in.`, `coop-knock:${k.id}`, session.id, open);
    }
  };
  return {
    /** What is already known (the recents), so a run started before this window opened still notifies when it ends. */
    seed(sessions: readonly SessionSummary[]): void {
      for (const s of sessions) {
        if (!statuses.has(s.id)) statuses.set(s.id, s.status);
        if (!mine.has(s.id)) mine.set(s.id, !!s.coop?.waitingOnYou);
        if (!knocks.has(s.id)) knocks.set(s.id, new Set((s.coop?.knocking ?? []).map((k) => k.id)));
      }
    },
    update(session: SessionSummary, prefs: Pick<UserPrefs, 'notifications'> | undefined, open: (sessionId: string) => void): void {
      const previous = statuses.get(session.id);
      statuses.set(session.id, session.status);
      // Co-op: a question is the person's when its approver is them (a backend that says so); someone else's isn't.
      const coop = session.coop?.waitingOnYou !== undefined;
      const wasMine = mine.get(session.id) ?? false;
      mine.set(session.id, !!session.coop?.waitingOnYou);
      let event = taskEvent(previous, session.status);
      if (coop && event === 'input') event = null;
      if (coop && !wasMine && session.coop?.waitingOnYou) event = 'input';
      newKnocks(session, prefs, open);
      const wanted = event === 'input' ? prefs?.notifications.permissionNeeded : prefs?.notifications.taskFinished;
      if (!event || !wanted || !allowed()) return;
      // One per task: a newer one (it finished after asking) replaces the older.
      show(titles(session, unified)[event], sessionTitle(session), session.id, session.id, open);
    },
  };
}

/** Mounted once in the app shell: watches the person's conversations wherever they are in the app. */
export function useTaskNotifications(enabled = true): void {
  const { prefs } = usePrefs();
  const navigate = useNavigate();
  const unified = useUnifiedChat();
  const { data: tasks } = useSessions({ mode: 'work' });
  const { data: chats } = useSessions({ mode: 'chat' });
  const { data: code } = useSessions({ mode: 'code' });
  // A knock while the person is in the app: a toast that takes them to it, its Co-op panel open (the session's own page
  // shows the same toast, by the same id, with the emoji).
  const notifier = useMemo(
    () =>
      createTaskNotifier(unified, (knock, open) =>
        toast(`${knock.name} wants to join`, {
          id: `coop-knock:${knock.id}`,
          description: knock.title,
          duration: 15_000,
          action: { label: 'Review', onClick: () => (openCoopPanel(knock.sessionId), open(knock.sessionId)) },
        }),
      ),
    [unified],
  );
  useEffect(() => {
    if (!enabled) return;
    for (const list of [tasks, chats, code]) if (list) notifier.seed(list);
  }, [notifier, tasks, chats, code, enabled]);
  useEffect(
    () => (enabled ? rpc().on('sessions.changed', (session) => notifier.update(session, prefs, (sessionId) => void navigate({ to: SESSION_ROUTE[session.mode], params: { sessionId } }))) : undefined),
    [notifier, prefs, navigate, enabled],
  );
}
