import type { Mode, SessionSummary } from '@atelier/protocol';

const NOUNS: Record<Mode, string> = { chat: 'chat', work: 'task', code: 'session' };

/** What the UI calls a session: a chat, a task in Cowork, or a session in Code. */
export function sessionNoun(session: Pick<SessionSummary, 'mode'>): string {
  return NOUNS[session.mode];
}

/** Sessions are untitled until the first reply has been summarized into a title. */
export function sessionTitle(session: Pick<SessionSummary, 'title' | 'mode'>): string {
  return session.title.trim() || `New ${NOUNS[session.mode]}`;
}
