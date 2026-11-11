import type { ControllerEvent } from '@atelier/protocol';
import type { LinkProblem } from '@atelier/core/device';

/** Messages between the Electron main process and the utility process (embedded backend or server relay). */
export type BackendRequest =
  | { kind: 'req'; id: number; op: 'encrypt'; value: string }
  | { kind: 'req'; id: number; op: 'decrypt'; value: string }
  | { kind: 'req'; id: number; op: 'chatgptChat'; operation: 'status' | 'open' | 'hide' | 'disconnect' | 'models' | 'start' | 'poll' | 'stop'; value: string }
  /** Computer use for a session (`method` of ControllerMethods, or `available`); main answers JSON. */
  | { kind: 'req'; id: number; op: 'computer'; sessionId: string; method: string; params: unknown }
  /** Atelier for Chrome (`method` of BrowserMethods); main answers JSON. */
  | { kind: 'req'; id: number; op: 'browser'; method: string; params: unknown };

export type MainResponse = { kind: 'res'; id: number; ok: true; value: string } | { kind: 'res'; id: number; ok: false; error: string };

export type MainToBackend =
  | MainResponse
  /** A renderer connection, signed in with the stored token if any; the MessagePort travels in the transfer list. */
  | { kind: 'connect'; token?: string }
  /** `range` is the request's `Range` header: only that part is read and sent back. */
  | { kind: 'blob'; id: number; sha256: string; range?: string }
  /** Server mode: the current sign-in for the device link (null when signed out). */
  | { kind: 'token'; token: string | null }
  /** Server mode: the person changed what this computer lends the server (`lending.json`). */
  | { kind: 'lending' }
  /** Server mode: the person opened "Import from Claude Code" here, so the server may read its connectors for a while. */
  | { kind: 'importing' }
  /** Local mode: the person passed the OS account check (Touch ID), so the screen lock is removed. */
  | { kind: 'removeScreenLock' }
  /** Local mode: the person held Esc in a session using the computer, or took the mouse back. */
  | { kind: 'computerEvent'; sessionId: string; event: ControllerEvent }
  | { kind: 'shutdown' };

export type BackendToMain =
  | BackendRequest
  | { kind: 'ready' }
  /** Server mode: why the server can't be reached (null: it can). */
  | { kind: 'link'; problem: LinkProblem | null }
  /** The built-in backend made a folder on this machine one of the person's (the agent moved a session there): main trusts it too. */
  | { kind: 'trusted'; root: string }
  /** Co-op (ARCHITECTURE §24): the sessions with a room open on this computer, which keep it awake for the guests. */
  | { kind: 'coop-awake'; sessionIds: string[] }
  /** `size` is the whole file's, which `bytes` is all or a range of. */
  | { kind: 'blob'; id: number; found: true; bytes: Uint8Array<ArrayBuffer>; mime: string; size: number }
  | { kind: 'blob'; id: number; found: false };

/** Menu commands forwarded to the renderer. */
export type MenuCommand = 'new-chat' | 'new-temporary-chat' | 'join-coop' | 'settings' | 'toggle-sidebar' | 'command-palette' | 'lock';
