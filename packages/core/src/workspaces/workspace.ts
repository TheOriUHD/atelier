/**
 * A workspace as the tools see it (ARCHITECTURE §6): a folder on some machine, reached through that
 * machine's runner. Local workspaces spawn the runner directly; a desktop device in server mode or an SSH
 * host relays the same JSON-RPC, so tools never know which.
 */
import type { RunnerClient } from './runner-client.ts';

/** The part of a runner connection tools use. */
export type RunnerCalls = Pick<RunnerClient, 'call' | 'on'>;

export interface Workspace {
  id: string;
  /** Where it lives, when known: this computer (or a device's), an SSH host, or a codespace. */
  kind?: 'local' | 'ssh' | 'codespace';
  /** The desktop device it lives on (server mode); null on this backend's own machine. */
  deviceId: string | null;
  /** The SSH host it lives on; null otherwise. */
  host: string | null;
  /** A chat's sandbox (commands run under fixed rules, no prompts); `confined` when they can't reach past its folder. */
  sandbox?: { confined: boolean };
  /**
   * The person answered "Trust this workspace?" (the workspaces row's `trusted`, refreshed by every `open`). Anything absent
   * counts as untrusted: see `isTrusted`.
   */
  trusted?: boolean;
  /** Absolute path of the primary root on the runner's machine (the git toplevel or the chosen folder). */
  root: string;
  /** Facts from the runner's `initialize`. */
  home: string;
  os: string;
  shell: string;
  pathSep: string;
  runner: RunnerCalls;
  /** The session's persistent Bash shell (`shell.open` on first use; cwd carries over between commands). */
  shellFor(sessionId: string): Promise<string>;
}

/**
 * Whether what the folder brings itself may apply: its settings files (permission rules and hooks), instruction files,
 * skills, commands and agents. An untrusted workspace still works (files, commands the person approves), it just isn't
 * configured by its own contents. Fails closed: a workspace that doesn't say is untrusted.
 */
export const isTrusted = (ws: Pick<Workspace, 'trusted'>): boolean => ws.trusted === true;

/** Whether the workspace is on the backend's own machine (not a device's or an SSH host's). */
export const onThisMachine = (ws: Pick<Workspace, 'deviceId' | 'host'>) => !ws.deviceId && !ws.host;

