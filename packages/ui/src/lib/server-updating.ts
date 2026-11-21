/**
 * The server told its apps it is restarting into a new version (`server.updating`). For the next minute or so an
 * unreachable server is an update in progress, not a failure: the screens say so calmly (auth-gate.tsx) instead of
 * "Can't reach the server". Kept in session storage as well, so a page reloaded during the restart still knows.
 */
const KEY = 'atelier.serverUpdating';
/** How long after the notice a missing server still counts as installing: the restart takes seconds, a pull is done already. */
export const UPDATING_WINDOW_MS = 90_000;
/** The notice that says so: one at a time, replaced and dismissed by this id. */
export const UPDATING_TOAST_ID = 'server-updating';

interface Notice {
  until: number;
  version: string | null;
}

let memory: Notice | null = null;

export function markServerUpdating(version: string | null, now = Date.now()): void {
  memory = { until: now + UPDATING_WINDOW_MS, version };
  try {
    sessionStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    // No storage (private mode): the page that saw the event still knows.
  }
}

export function clearServerUpdating(): void {
  memory = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // See above.
  }
}

/** The version the server is installing (null when it didn't say), or undefined when no update is in progress. */
export function serverUpdating(now = Date.now()): { version: string | null } | undefined {
  let notice = memory;
  if (!notice) {
    try {
      const stored = sessionStorage.getItem(KEY);
      notice = stored ? (JSON.parse(stored) as Notice) : null;
    } catch {
      notice = null;
    }
  }
  if (!notice || typeof notice.until !== 'number' || notice.until < now) return undefined;
  return { version: typeof notice.version === 'string' ? notice.version : null };
}

/** The words for it, as a notice and on the screen shown while the server is away. */
export const updatingWords = (version: string | null): string => `Atelier is installing an update${version ? ` (${version})` : ''}. This page reconnects in a moment.`;
