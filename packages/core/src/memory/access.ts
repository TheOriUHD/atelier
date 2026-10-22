/**
 * Whether memory and past-chat search apply to a session (ARCHITECTURE › Memory). Every memory read and write, the
 * digest in the system prompt, the tools and the background update ask `memoryFor` first, so a new kind of session
 * (a temporary chat) is handled here, from `sessions.temporary`.
 */
import type { UserPrefs } from '@atelier/protocol';
import { isSideChat } from '../agent/side-chat.ts';
import type { SessionRow } from '../sessions/session-repo.ts';
import { mayUseChatSearch, memoryAccess, NOT_TEMPORARY_SQL } from '../sessions/temporary.ts';

export interface MemoryAccess {
  /** The digest in the system prompt, MemorySearch and MemoryView. */
  read: boolean;
  /** MemoryUpdate: `free` while "Generate memory from chats" is on, `explicit` (only when the person asks) while it is off. */
  write: 'free' | 'explicit' | null;
  /** ChatSearch and ChatRead. */
  searchChats: boolean;
  /** The background update after the conversation goes idle. */
  generate: boolean;
  /** Entries about health, beliefs and the like may be read and written. */
  sensitive: boolean;
}

export const NO_MEMORY: MemoryAccess = { read: false, write: null, searchChats: false, generate: false, sensitive: false };

/** The session facts the decision depends on. */
export type MemorySessionFacts = Pick<SessionRow, 'userId' | 'mode' | 'parentSessionId' | 'overrides' | 'temporary'>;

/** Past-chat search keeps sessions by this condition (sessions aliased `s`): never a temporary chat. */
export const SEARCHABLE_SESSION_SQL = `s.${NOT_TEMPORARY_SQL}`;

/**
 * What memory a session gets. Chat and Cowork read, write and search past chats; Code works from its project's
 * instructions and gets none. Sub-agents get none; side chats may read and search but never write. Signed-out sessions
 * get none. A temporary chat writes nothing; a "start fresh" one reads nothing either (sessions/temporary.ts).
 */
export function memoryFor(session: MemorySessionFacts, prefs: Pick<UserPrefs, 'memory'>): MemoryAccess {
  if (!session.userId || session.mode === 'code') return NO_MEMORY;
  const side = isSideChat(session);
  if (session.parentSessionId && !side) return NO_MEMORY;
  const temporary = memoryAccess(session);
  if (!temporary.read) return NO_MEMORY;
  const { searchChats, generate, sensitive } = prefs.memory;
  return {
    read: true,
    write: side || !temporary.write ? null : generate ? 'free' : 'explicit',
    searchChats: searchChats && mayUseChatSearch(session),
    generate: generate && !side && temporary.write,
    sensitive,
  };
}
