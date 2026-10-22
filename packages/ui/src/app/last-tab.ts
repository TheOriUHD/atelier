import type { Mode } from '@atelier/protocol';

/** The tab (Chat or Code) the person was last in, kept in this browser or window so the next start opens there. */
const KEY = 'atelier.lastTab';

export type Tab = 'chat' | 'code';

/** Cowork belongs to the Chat tab. */
export function tabOf(mode: Mode): Tab {
  return mode === 'code' ? 'code' : 'chat';
}

export function rememberTab(tab: Tab, storage: Pick<Storage, 'setItem'> | undefined = safeStorage()): void {
  try {
    storage?.setItem(KEY, tab);
  } catch {
    // Storage can be blocked or full: the app then opens on Chat, as before.
  }
}

export function recalledTab(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): Tab {
  try {
    return storage?.getItem(KEY) === 'code' ? 'code' : 'chat';
  } catch {
    return 'chat';
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Where an app that starts on its bare home (no route in the address) should go instead: Code's home when that was the
 * tab last used. Anything else (a link to a chat, an invite, Settings on top of home) is left alone.
 */
export function startHash(hash: string, tab: Tab): string | null {
  if (tab !== 'code') return null;
  const bare = /^#?\/?(\?.*)?$/.exec(hash);
  return bare ? `#/code${bare[1] ?? ''}` : null;
}
