/**
 * System notifications for Work: a task finished, failed or started waiting for the person while they were in
 * another window or app. Uses the HTML Notification API (browsers and Electron's renderer alike).
 */
import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { SessionStatus, SessionSummary, UserPrefs } from '@atelier/protocol';
import { desktop } from '../../lib/platform.ts';
import { usePrefs, useSessions } from '../../lib/queries.ts';
import { rpc } from '../../lib/rpc.ts';
import { sessionTitle } from '../../lib/sessions.ts';

export type TaskEvent = 'finished' | 'failed' | 'input';

const TITLES: Record<TaskEvent, string> = { finished: 'Cowork task finished', failed: 'Cowork task failed', input: 'Cowork task needs your input' };

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

/** Remembers each Work session's last status, so a change can be told apart from a repeat. */
export function createTaskNotifier() {
  const statuses = new Map<string, SessionStatus>();
  return {
    /** What is already known (Work recents), so a run started before this window opened still notifies when it ends. */
    seed(sessions: readonly SessionSummary[]): void {
      for (const s of sessions) if (s.mode === 'work' && !statuses.has(s.id)) statuses.set(s.id, s.status);
    },
    update(session: SessionSummary, prefs: Pick<UserPrefs, 'notifications'> | undefined, open: (sessionId: string) => void): void {
      if (session.mode !== 'work') return;
      const event = taskEvent(statuses.get(session.id), session.status);
      statuses.set(session.id, session.status);
      const wanted = event === 'input' ? prefs?.notifications.permissionNeeded : prefs?.notifications.taskFinished;
      if (!event || !wanted || document.hasFocus() || !supported() || Notification.permission !== 'granted') return;
      // One per task: a newer one (it finished after asking) replaces the older.
      const notification = new Notification(TITLES[event], { body: sessionTitle(session), tag: session.id });
      notification.onclick = () => {
        notification.close();
        focusWindow();
        open(session.id);
      };
    },
  };
}

/** Mounted once in the app shell: watches the person's Work sessions wherever they are in the app. */
export function useTaskNotifications(): void {
  const { prefs } = usePrefs();
  const navigate = useNavigate();
  const { data: tasks } = useSessions({ mode: 'work' });
  const [notifier] = useState(createTaskNotifier);
  useEffect(() => {
    if (tasks) notifier.seed(tasks);
  }, [notifier, tasks]);
  useEffect(
    () => rpc().on('sessions.changed', (session) => notifier.update(session, prefs, (sessionId) => void navigate({ to: '/work/$sessionId', params: { sessionId } }))),
    [notifier, prefs, navigate],
  );
}
