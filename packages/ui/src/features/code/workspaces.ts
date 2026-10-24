import type { SessionSummary, WorkspaceSummary } from '@atelier/protocol';

/** How the header and the picker name a folder: SSH folders as `host:path`. */
export function workspaceLabel(w: WorkspaceSummary): string {
  return w.kind === 'ssh' ? `${w.host}:${w.root}` : w.name;
}

/** Where a home's folders are: this computer, a codespace, another computer of the person's (lent over the device link) or an SSH host. */
export type Environment = 'local' | 'cloud' | 'remote' | 'ssh';

/**
 * A folder's environment; `thisDevice` is the desktop app's own device (none in the browser). An SSH host reached from
 * another of the person's computers is that computer's (Remote Control): it goes through it.
 */
export function environmentOf(w: WorkspaceSummary, thisDevice: string | undefined): Environment {
  if (w.kind === 'codespace') return 'cloud';
  if (w.deviceId && w.deviceId !== thisDevice) return 'remote';
  return w.kind === 'ssh' ? 'ssh' : 'local';
}

/** Most recently used first. */
export function recentWorkspaces(list: readonly WorkspaceSummary[]): WorkspaceSummary[] {
  return [...list].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

/** The folder a new session starts in: the one asked for while its machine is online, else the most recent that is. */
export function initialWorkspace(list: readonly WorkspaceSummary[], requested: string | undefined): WorkspaceSummary | undefined {
  const usable = recentWorkspaces(list).filter((w) => w.available);
  return usable.find((w) => w.id === requested) ?? usable[0];
}

/** The folder a home asks for (`?workspace=none`) to start with no folder: each session then gets a new scratch folder. */
export const NO_FOLDER = 'none';

/**
 * What a new session starts in: a folder (one of the person's, or a scratch folder asked for by id, as `/clear` does
 * to go on in the same one), or no folder (a new scratch folder, on `host` for SSH).
 */
export type FolderChoice = { kind: 'folder'; workspace: WorkspaceSummary } | { kind: 'none'; host: string | null };

/** A home's search: the folder to start in (or `NO_FOLDER`) and, with `NO_FOLDER`, the SSH host; none is this computer. */
export interface FolderSearch {
  workspace?: string;
  host?: string;
  /** One of the person's sidebar groups: the new session is filed under it. */
  group?: string;
}

/**
 * What a new session starts in, from one environment's folders, scratch folders included: the folder asked for while
 * its machine is online (a scratch folder too), or no folder (`NO_FOLDER`); else what the latest session there used
 * (no folder after a scratch folder), and no folder before the first. `scratchHost` is where no folder makes its
 * scratch folders: null for this computer, an SSH host, or undefined where there is no "no folder" (then only the
 * person's folders count).
 */
export function initialChoice(list: readonly WorkspaceSummary[], requested: string | undefined, scratchHost: string | null | undefined): FolderChoice | undefined {
  const none = scratchHost === undefined ? undefined : ({ kind: 'none', host: scratchHost } as const);
  if (requested === NO_FOLDER && none) return none;
  const usable = recentWorkspaces(list).filter((w) => w.available && (none || !w.scratch));
  const asked = usable.find((w) => w.id === requested);
  if (asked) return { kind: 'folder', workspace: asked };
  const latest = usable[0];
  return !latest || latest.scratch ? none : { kind: 'folder', workspace: latest };
}

export interface SessionGroup {
  label: string;
  /** The folder the group's sessions run in; null for "No folder" and "Ungrouped" (no folder, or one that was removed). */
  workspace: WorkspaceSummary | null;
  /** "No folder": the sessions started with no folder, each in its own scratch folder. */
  scratch: boolean;
  /**
   * Where the group's "+" starts a session: in its folder while that is online, or with no folder where the group's
   * latest session ran (this computer or its SSH host); null for "Ungrouped".
   */
  start: FolderSearch | null;
  sessions: SessionSummary[];
}

/**
 * Code and Cowork sessions by folder, the folder with the latest activity on top; those started with no folder share
 * one "No folder" group, and those whose folder is unknown go under "Ungrouped".
 */
export function workspaceGroups(sessions: readonly SessionSummary[], workspaces: readonly WorkspaceSummary[]): SessionGroup[] {
  const byId = new Map(workspaces.map((w) => [w.id, w]));
  const groups = new Map<string, SessionGroup>();
  for (const s of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const found = (s.workspaceId && byId.get(s.workspaceId)) || null;
    const scratch = !!found?.scratch;
    const workspace = scratch ? null : found;
    const key = scratch ? NO_FOLDER : (workspace?.id ?? '');
    let group = groups.get(key);
    if (!group) {
      // Sessions come newest first, so the first one decides where the group's "+" starts.
      const start = found?.scratch ? { workspace: NO_FOLDER, ...(found.host ? { host: found.host } : {}) } : workspace?.available ? { workspace: workspace.id } : null;
      group = { label: scratch ? 'No folder' : (workspace?.name ?? 'Ungrouped'), workspace, scratch, start, sessions: [] };
      groups.set(key, group);
    }
    group.sessions.push(s);
  }
  return [...groups.values()];
}
