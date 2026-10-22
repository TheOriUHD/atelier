/**
 * What the sidebar's Code and Cowork lists show and how: filtered by environment, sorted, then grouped by folder, by
 * the person's own groups, by date, by state, or not at all (the view options). Pure, so the lists and their tests
 * share it.
 */
import type { SessionGroup, SessionSummary, SidebarView, WorkspaceSummary } from '@atelier/protocol';
import { recentGroup } from '../lib/dates.ts';
import { sessionTitle } from '../lib/sessions.ts';
import { environmentOf, workspaceGroups, type FolderSearch } from '../features/code/workspaces.ts';

export const DEFAULT_SIDEBAR_VIEW: SidebarView = {
  status: 'active',
  environments: ['local', 'cloud', 'remote', 'ssh'],
  groupBy: 'folder',
  sortBy: 'activity',
  showEmptyGroups: false,
};

export interface ListedGroup {
  key: string;
  label: string;
  sessions: SessionSummary[];
  /** Where the group's "+" starts a session (a folder's, the "No folder" group's); null for none. */
  start: FolderSearch | null;
  /** The folder the group's sessions run in, for folder groups. */
  workspace: WorkspaceSummary | null;
  /** The person's own group: it can be renamed, collapsed and deleted. */
  custom: SessionGroup | null;
}

export interface Arranged {
  pinned: SessionSummary[];
  groups: ListedGroup[];
}

const STATES = [
  { key: 'waiting', label: 'Needs your attention', has: (s: SessionSummary) => s.status === 'waiting' },
  { key: 'running', label: 'Running', has: (s: SessionSummary) => s.status === 'running' },
  { key: 'unread', label: 'Finished', has: (s: SessionSummary) => !!s.finishedUnseen },
  { key: 'idle', label: 'Idle', has: () => true },
] as const;

/** The order a view sorts by; ties keep the newest first. */
export function sortSessions(list: readonly SessionSummary[], sortBy: SidebarView['sortBy']): SessionSummary[] {
  const byName = (a: SessionSummary, b: SessionSummary) => sessionTitle(a).localeCompare(sessionTitle(b), undefined, { sensitivity: 'base' });
  const compare =
    sortBy === 'name'
      ? (a: SessionSummary, b: SessionSummary) => byName(a, b) || b.updatedAt - a.updatedAt
      : sortBy === 'created'
        ? (a: SessionSummary, b: SessionSummary) => b.createdAt - a.createdAt
        : (a: SessionSummary, b: SessionSummary) => b.updatedAt - a.updatedAt;
  return [...list].sort(compare);
}

/** Whether the session belongs to one of the environments shown; a folder that is gone counts as this computer. */
export function inEnvironments(
  session: SessionSummary,
  workspaces: ReadonlyMap<string, WorkspaceSummary>,
  shown: SidebarView['environments'],
  thisDevice: string | undefined,
): boolean {
  if (shown.length >= 4) return true;
  const workspace = session.workspaceId ? workspaces.get(session.workspaceId) : undefined;
  return shown.includes(workspace ? environmentOf(workspace, thisDevice) : 'local');
}

export function arrangeSessions(
  sessions: readonly SessionSummary[],
  context: { view: SidebarView; workspaces: readonly WorkspaceSummary[]; groups: readonly SessionGroup[]; thisDevice: string | undefined; now?: number },
): Arranged {
  const { view, workspaces, groups, thisDevice } = context;
  const byId = new Map(workspaces.map((w) => [w.id, w]));
  const shown = sortSessions(
    sessions.filter((s) => inEnvironments(s, byId, view.environments, thisDevice)),
    view.sortBy,
  );
  const pinned = shown.filter((s) => s.pinnedAt).sort((a, b) => b.pinnedAt! - a.pinnedAt!);
  const rest = shown.filter((s) => !s.pinnedAt);
  const plain = (key: string, label: string, list: SessionSummary[]): ListedGroup => ({ key, label, sessions: list, start: null, workspace: null, custom: null });

  if (view.groupBy === 'none') return { pinned, groups: rest.length ? [plain('all', 'Recents', rest)] : [] };

  if (view.groupBy === 'date') {
    const stamp = (s: SessionSummary) => (view.sortBy === 'created' ? s.createdAt : s.updatedAt);
    const buckets = new Map<string, SessionSummary[]>();
    for (const s of rest) buckets.set(recentGroup(stamp(s), context.now), [...(buckets.get(recentGroup(stamp(s), context.now)) ?? []), s]);
    const order = [...buckets.entries()].sort(([, a], [, b]) => Math.max(...b.map(stamp)) - Math.max(...a.map(stamp)));
    return { pinned, groups: order.map(([label, list]) => plain(`date:${label}`, label, list)) };
  }

  if (view.groupBy === 'state') {
    const out = STATES.map((state) => ({ state, list: [] as SessionSummary[] }));
    for (const s of rest) out.find((o) => o.state.has(s))!.list.push(s);
    return { pinned, groups: out.filter((o) => o.list.length).map((o) => plain(`state:${o.state.key}`, o.state.label, o.list)) };
  }

  if (view.groupBy === 'custom') {
    const byGroup = new Map<string, SessionSummary[]>();
    const ungrouped: SessionSummary[] = [];
    for (const s of rest) {
      if (s.groupId && groups.some((g) => g.id === s.groupId)) byGroup.set(s.groupId, [...(byGroup.get(s.groupId) ?? []), s]);
      else ungrouped.push(s);
    }
    const listed: ListedGroup[] = groups
      .map((g) => ({ key: `group:${g.id}`, label: g.name, sessions: byGroup.get(g.id) ?? [], start: null, workspace: null, custom: g }))
      .filter((g) => g.sessions.length > 0 || view.showEmptyGroups);
    if (ungrouped.length) listed.push(plain('ungrouped', 'Ungrouped', ungrouped));
    return { pinned, groups: listed };
  }

  // By folder: the folder with the best session by the view's own order first (workspaceGroups orders by activity).
  const folders = workspaceGroups(rest, workspaces).map<ListedGroup>((g) => ({
    key: `folder:${g.workspace?.id ?? g.label}`,
    label: g.label,
    sessions: sortSessions(g.sessions, view.sortBy),
    start: g.start,
    workspace: g.workspace,
    custom: null,
  }));
  if (view.sortBy === 'name') folders.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  if (view.sortBy === 'created') folders.sort((a, b) => Math.max(...b.sessions.map((s) => s.createdAt)) - Math.max(...a.sessions.map((s) => s.createdAt)));
  return { pinned, groups: folders };
}

/** "3 selected", "All", or the one name: what the Environment row says of its choice. */
export function environmentHint(shown: SidebarView['environments']): string {
  return shown.length >= 4 ? 'All' : shown.length === 1 ? ENVIRONMENT_LABELS[shown[0]!] : `${shown.length} selected`;
}

export const ENVIRONMENT_LABELS = { local: 'Local', cloud: 'Cloud', remote: 'Remote Control', ssh: 'SSH' } as const;
