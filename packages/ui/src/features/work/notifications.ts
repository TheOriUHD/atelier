/**
 * System notifications: a conversation's turn finished, failed or started waiting for the person (a question or a
 * permission) while they were in another window or app. Every conversation counts: Code, Cowork tasks and chats.
 * Uses the HTML Notification API (browsers and Electron's renderer alike; on Windows the desktop app registers its app
 * id, without which the toasts don't show).
 */
import { useEffect, useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { SessionStatus, SessionSummary, UserPrefs } from '@atelier/protocol';
import { SESSION_ROUTE } from '../../app/navigation.ts';
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

/** Remembers each conversation's last status, so a change can be told apart from a repeat. */
export function createTaskNotifier(unified = false) {
  const statuses = new Map<string, SessionStatus>();
  return {
    /** What is already known (the recents), so a run started before this window opened still notifies when it ends. */
    seed(sessions: readonly SessionSummary[]): void {
      for (const s of sessions) if (!statuses.has(s.id)) statuses.set(s.id, s.status);
    },
    update(session: SessionSummary, prefs: Pick<UserPrefs, 'notifications'> | undefined, open: (sessionId: string) => void): void {
      const event = taskEvent(statuses.get(session.id), session.status);
      statuses.set(session.id, session.status);
      const wanted = event === 'input' ? prefs?.notifications.permissionNeeded : prefs?.notifications.taskFinished;
      if (!event || !wanted || document.hasFocus() || !supported() || Notification.permission !== 'granted') return;
      // One per task: a newer one (it finished after asking) replaces the older.
      const notification = new Notification(titles(session, unified)[event], { body: sessionTitle(session), tag: session.id });
      notification.onclick = () => {
        notification.close();
        focusWindow();
        open(session.id);
      };
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
  const notifier = useMemo(() => createTaskNotifier(unified), [unified]);
  useEffect(() => {
    if (!enabled) return;
    for (const list of [tasks, chats, code]) if (list) notifier.seed(list);
  }, [notifier, tasks, chats, code, enabled]);
  useEffect(
    () => (enabled ? rpc().on('sessions.changed', (session) => notifier.update(session, prefs, (sessionId) => void navigate({ to: SESSION_ROUTE[session.mode], params: { sessionId } }))) : undefined),
    [notifier, prefs, navigate, enabled],
  );
}
