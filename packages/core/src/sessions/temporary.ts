/**
 * Temporary chats (ARCHITECTURE §"Temporary chats"): the one place that says whether a session is temporary and what
 * that allows. `sessions.temporary` is the single source of truth: null for ordinary sessions, otherwise the mode the
 * person had chosen when it started. Sub-agents and side chats inherit their parent's value (SessionRepo.create).
 *
 * - `private` (the default): the model may use the person's memory and instructions; nothing is written to memory and
 *   the chat stays out of every list and search.
 * - `fresh`: as `private`, and the model also gets nothing personal: no memory, no personal instructions or name, no
 *   project, no search over past chats. Admin instructions and safeguards stay.
 */
import { isNull, type SQL } from 'drizzle-orm';
import type { TemporaryMode } from '@atelier/protocol';
import { sessions } from '../store/schema.ts';

export type { TemporaryMode };

type Flagged = { temporary: TemporaryMode | null };

/** Temporary sessions are deleted once nobody has them open, and in any case after this long without activity. */
export const TEMPORARY_MAX_IDLE_MS = 24 * 3600_000;

export function isTemporary(session: Flagged): boolean {
  return session.temporary !== null;
}

/** How private a temporary session is; null for an ordinary one. */
export function temporaryMode(session: Flagged): TemporaryMode | null {
  return session.temporary;
}

/** Whether the model may see who the person is: memory, personal instructions, their name, project context. */
export function usesPersonalContext(session: Flagged): boolean {
  return session.temporary !== 'fresh';
}

/** What a session may do with the person's memory: read it (`fresh` may not), write it (no temporary chat may). */
export function memoryAccess(session: Flagged): { read: boolean; write: boolean } {
  return { read: usesPersonalContext(session), write: !isTemporary(session) };
}

/** Whether search over past chats (and the model's chat-search tools) may run from this session. */
export function mayUseChatSearch(session: Flagged): boolean {
  return usesPersonalContext(session);
}

/** Drizzle condition for queries over history: lists, search, recents, counts, exports. */
export function notTemporary(): SQL {
  return isNull(sessions.temporary);
}

/** The same condition for raw SQL over `sessions` (alias it as needed: `${alias}.temporary IS NULL`). */
export const NOT_TEMPORARY_SQL = 'temporary IS NULL';
