import { describe, expect, it } from 'vitest';
import type { SessionGroup, SessionSummary, WorkspaceSummary } from '@atelier/protocol';
import { DEFAULT_SIDEBAR_VIEW, arrangeSessions, environmentHint, sortSessions } from './sidebar-view.ts';

const NOW = new Date(2026, 9, 15, 12).getTime();
const DAY = 86_400_000;

const session = (title: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id: title,
  mode: 'code',
  workspaceId: 'w1',
  permissionMode: null,
  title,
  projectId: null,
  model: null,
  effort: null,
  connectorsOff: [],
  research: false,
  status: 'idle',
  pinnedAt: null,
  createdAt: 0,
  updatedAt: NOW,
  ...extra,
});
const workspace = (id: string, extra: Partial<WorkspaceSummary> = {}): WorkspaceSummary => ({
  id,
  kind: 'local',
  name: id,
  root: `/work/${id}`,
  host: null,
  deviceId: null,
  available: true,
  scratch: false,
  lastUsedAt: 1,
  ...extra,
});
const group = (id: string, name: string): SessionGroup => ({ id, name, collapsed: false, createdAt: 0 });
const labels = (g: { label: string; sessions: SessionSummary[] }[]) => g.map((x) => [x.label, x.sessions.map((s) => s.title)]);
const arrange = (sessions: SessionSummary[], view: Partial<typeof DEFAULT_SIDEBAR_VIEW>, groups: SessionGroup[] = [], workspaces = [workspace('w1'), workspace('w2')]) =>
  arrangeSessions(sessions, { view: { ...DEFAULT_SIDEBAR_VIEW, ...view }, workspaces, groups, thisDevice: 'me', now: NOW });

describe('sorting', () => {
  const list = [session('b', { createdAt: 3, updatedAt: 10 }), session('A', { createdAt: 1, updatedAt: 30 }), session('c', { createdAt: 2, updatedAt: 20 })];
  it('by name (ignoring case), creation or last activity', () => {
    expect(sortSessions(list, 'name').map((s) => s.title)).toEqual(['A', 'b', 'c']);
    expect(sortSessions(list, 'created').map((s) => s.title)).toEqual(['b', 'c', 'A']);
    expect(sortSessions(list, 'activity').map((s) => s.title)).toEqual(['A', 'c', 'b']);
  });
});

describe('arranging the list', () => {
  const all = [
    session('Pinned', { pinnedAt: 5, workspaceId: 'w2' }),
    session('Fix build', { updatedAt: NOW - 1000, groupId: 'g1', status: 'waiting' }),
    session('Docs', { updatedAt: NOW - 2 * DAY, workspaceId: 'w2', groupId: 'g1', finishedUnseen: true }),
    session('Old', { updatedAt: NOW - 60 * DAY, status: 'running' }),
  ];
  const groups = [group('g1', 'Aperture'), group('g2', 'Empty')];

  it('pins first, then groups by folder, the folder of the latest activity on top', () => {
    const { pinned, groups: g } = arrange(all, {});
    expect(pinned.map((s) => s.title)).toEqual(['Pinned']);
    expect(labels(g)).toEqual([
      ['w1', ['Fix build', 'Old']],
      ['w2', ['Docs']],
    ]);
  });

  it('groups by the person’s own groups, ungrouped last, and shows empty ones only when asked', () => {
    expect(labels(arrange(all, { groupBy: 'custom' }, groups).groups)).toEqual([
      ['Aperture', ['Fix build', 'Docs']],
      ['Ungrouped', ['Old']],
    ]);
    expect(arrange(all, { groupBy: 'custom', showEmptyGroups: true }, groups).groups.map((x) => x.label)).toEqual(['Aperture', 'Empty', 'Ungrouped']);
    expect(arrange(all, { groupBy: 'custom' }, groups).groups[0]!.custom?.id).toBe('g1');
  });

  it('groups by date and by state', () => {
    expect(arrange(all, { groupBy: 'date' }).groups.map((x) => x.label)).toEqual(['Today', expect.stringMatching(/\w+ \d+/), 'Older']);
    expect(labels(arrange(all, { groupBy: 'state' }).groups)).toEqual([
      ['Needs your attention', ['Fix build']],
      ['Running', ['Old']],
      ['Finished', ['Docs']],
    ]);
  });

  it('lists everything together when not grouped', () => {
    expect(labels(arrange(all, { groupBy: 'none', sortBy: 'name' }).groups)).toEqual([['Recents', ['Docs', 'Fix build', 'Old']]]);
  });

  it('keeps only the environments shown; a removed folder counts as this computer', () => {
    const ws = [workspace('w1'), workspace('w2', { kind: 'ssh', host: 'box' }), workspace('w3', { kind: 'codespace' })];
    const sessions = [session('a', { workspaceId: 'w1' }), session('b', { workspaceId: 'w2' }), session('c', { workspaceId: 'w3' }), session('d', { workspaceId: 'gone' })];
    expect(labels(arrange(sessions, { groupBy: 'none', environments: ['ssh'] }, [], ws).groups)).toEqual([['Recents', ['b']]]);
    expect(labels(arrange(sessions, { groupBy: 'none', environments: ['local'] }, [], ws).groups)).toEqual([['Recents', ['a', 'd']]]);
    expect(environmentHint(['local', 'cloud', 'remote', 'ssh'])).toBe('All');
    expect(environmentHint(['ssh'])).toBe('SSH');
    expect(environmentHint(['local', 'ssh'])).toBe('2 selected');
  });
});
