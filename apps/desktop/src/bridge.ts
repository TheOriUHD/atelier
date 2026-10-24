import type { LinkProblem } from './link-problem.ts';

/** Messages between the Electron main process and the utility process (embedded backend or server relay). */
export type BackendRequest =
  | { kind: 'req'; id: number; op: 'encrypt'; value: string }
  | { kind: 'req'; id: number; op: 'decrypt'; value: string }
  | { kind: 'req'; id: number; op: 'chatgptChat'; operation: 'status' | 'open' | 'hide' | 'disconnect' | 'models' | 'start' | 'poll' | 'stop'; value: string };

export type MainResponse = { kind: 'res'; id: number; ok: true; value: string } | { kind: 'res'; id: number; ok: false; error: string };

export type MainToBackend =
  | MainResponse
  /** A renderer connection, signed in with the stored token if any; the MessagePort travels in the transfer list. */
  | { kind: 'connect'; token?: string }
  | { kind: 'blob'; id: number; sha256: string }
  /** Server mode: the current sign-in for the device link (null when signed out). */
  | { kind: 'token'; token: string | null }
  /** Server mode: the person changed what this computer lends the server (`lending.json`). */
  | { kind: 'lending' }
  /** Local mode: the person passed the OS account check (Touch ID), so the screen lock is removed. */
  | { kind: 'removeScreenLock' }
  | { kind: 'shutdown' };

export type BackendToMain =
  | BackendRequest
  | { kind: 'ready' }
  /** Server mode: why the server can't be reached (null: it can). */
  | { kind: 'link'; problem: LinkProblem | null }
  | { kind: 'blob'; id: number; found: true; bytes: Uint8Array<ArrayBuffer>; mime: string }
  | { kind: 'blob'; id: number; found: false };

/** Menu commands forwarded to the renderer. */
export type MenuCommand = 'new-chat' | 'new-temporary-chat' | 'settings' | 'toggle-sidebar' | 'command-palette' | 'lock';
