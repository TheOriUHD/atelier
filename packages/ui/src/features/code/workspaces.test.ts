import { describe, expect, it } from 'vitest';
import type { SessionSummary, WorkspaceSummary } from '@atelier/protocol';
import { NO_FOLDER, environmentOf, initialChoice, initialWorkspace, recentWorkspaces, workspaceGroups } from './workspaces.ts';

const ws = (id: string, lastUsedAt: number, available = true): WorkspaceSummary => ({
  id,
  kind: 'local',
  name: id.toUpperCase(),
  root: `/work/${id}`,
  host: null,
  deviceId: null,
  available,
  scratch: false,
  lastUsedAt,
});
const scratch = (id: string, lastUsedAt: number, host: string | null = null): WorkspaceSummary => ({
  ...ws(id, lastUsedAt),
  name: `scratch-2026-10-14-${id}`,
  root: `/data/scratch-workspaces/u1/scratch-2026-10-14-${id}`,
  scratch: true,
  ...(host ? { kind: 'ssh' as const, host } : {}),
});

const session = (id: string, workspaceId: string | null, updatedAt: number): SessionSummary => ({
  id,
  mode: 'code',
  workspaceId,
  permissionMode: null,
  title: id,
  projectId: null,
  model: null,
  effort: null,
  connectorsOff: [],
  research: false,
  status: 'idle',
  pinnedAt: null,
  createdAt: 0,
  updatedAt,
});

describe('workspace picking', () => {
  const list = [ws('a', 1), ws('b', 3), ws('c', 2, false)];

  it('lists folders most recently used first', () => {
    expect(recentWorkspaces(list).map((w) => w.id)).toEqual(['b', 'c', 'a']);
  });

  it('starts in the requested folder when its machine is online, else the most recent one that is', () => {
    expect(initialWorkspace(list, 'a')?.id).toBe('a');
    expect(initialWorkspace(list, 'c')?.id).toBe('b');
    expect(initialWorkspace(list, undefined)?.id).toBe('b');
    expect(initialWorkspace([ws('c', 2, false)], undefined)).toBeUndefined();
  });
});

describe('initialChoice', () => {
  const folder = (w: WorkspaceSummary) => ({ kind: 'folder', workspace: w });
  const none = { kind: 'none', host: null };

  it('starts with no folder before the first folder, and after a session that had none', () => {
    expect(initialChoice([], undefined, null)).toEqual(none);
    expect(initialChoice([ws('a', 1), scratch('s1', 5)], undefined, null)).toEqual(none);
    expect(initialChoice([ws('a', 6), scratch('s1', 5)], undefined, null)).toEqual(folder(ws('a', 6)));
  });

  it('takes the folder asked for, or no folder, and never a scratch folder by its id', () => {
    const list = [ws('a', 1), ws('b', 3), scratch('s1', 5)];
    expect(initialChoice(list, 'a', null)).toEqual(folder(ws('a', 1)));
    expect(initialChoice([ws('a', 6), ...list.slice(1)], NO_FOLDER, null)).toEqual(none);
    expect(initialChoice([ws('a', 1), ws('b', 7)], 'gone', null)).toEqual(folder(ws('b', 7)));
  });

  it('keeps to the person’s folders where there is no “no folder”', () => {
    const list = [ws('a', 1), scratch('s1', 5)];
    expect(initialChoice(list, undefined, undefined)).toEqual(folder(ws('a', 1)));
    expect(initialChoice(list, NO_FOLDER, undefined)).toEqual(folder(ws('a', 1)));
    expect(initialChoice([], undefined, undefined)).toBeUndefined();
  });

  it('makes the scratch folder on the SSH host it is given', () => {
    expect(initialChoice([scratch('s1', 5, 'devbox')], undefined, 'devbox')).toEqual({ kind: 'none', host: 'devbox' });
  });
});

describe('initialChoice after /clear', () => {
  it('goes on in the scratch folder asked for by id, while a plain home starts a new one', () => {
    const list = [ws('a', 1), scratch('s1', 5)];
    expect(initialChoice(list, 's1', null)).toEqual({ kind: 'folder', workspace: scratch('s1', 5) });
    expect(initialChoice(list, undefined, null)).toEqual({ kind: 'none', host: null });
  });
});

describe('environmentOf', () => {
  it('tells this computer’s folders from other computers’, codespaces and SSH hosts', () => {
    expect(environmentOf(ws('a', 0), undefined)).toBe('local');
    expect(environmentOf({ ...ws('a', 0), deviceId: 'mac' }, 'mac')).toBe('local');
    expect(environmentOf({ ...ws('a', 0), deviceId: 'pc' }, 'mac')).toBe('remote');
    expect(environmentOf({ ...ws('a', 0), deviceId: 'pc' }, undefined)).toBe('remote');
    expect(environmentOf({ ...ws('a', 0), kind: 'codespace', host: 'cs' }, 'mac')).toBe('cloud');
    expect(environmentOf({ ...ws('a', 0), kind: 'ssh', host: 'box' }, 'mac')).toBe('ssh');
  });
});

describe('workspaceGroups', () => {
  it('makes one group per folder by latest activity, and puts sessions without one under Ungrouped', () => {
    const groups = workspaceGroups(
      [session('s1', 'a', 10), session('s2', 'b', 30), session('s3', 'a', 40), session('s4', 'gone', 5), session('s5', null, 1)],
      [ws('a', 0), ws('b', 0)],
    );
    expect(groups.map((g) => [g.label, g.sessions.map((s) => s.id)])).toEqual([
      ['A', ['s3', 's1']],
      ['B', ['s2']],
      ['Ungrouped', ['s4', 's5']],
    ]);
    expect(groups[0]!.workspace?.id).toBe('a');
    expect(groups[2]!.workspace).toBeNull();
  });

  it('puts every session started with no folder in one “No folder” group, wherever its scratch folder is', () => {
    const groups = workspaceGroups(
      [session('s1', 'x1', 50), session('s2', 'a', 40), session('s3', 'x2', 30), session('s4', 'x3', 20)],
      [ws('a', 0), scratch('x1', 0), scratch('x2', 0), scratch('x3', 0, 'devbox')],
    );
    expect(groups.map((g) => [g.label, g.scratch, g.workspace?.id ?? null, g.sessions.map((s) => s.id)])).toEqual([
      ['No folder', true, null, ['s1', 's3', 's4']],
      ['A', false, 'a', ['s2']],
    ]);
  });

  it('starts a group’s new session in its folder while online, or with no folder where its latest session ran', () => {
    const start = (sessions: SessionSummary[], workspaces: WorkspaceSummary[]) => workspaceGroups(sessions, workspaces).map((g) => [g.label, g.start]);
    // The latest no-folder session ran on this computer: no host, so the home starts on this computer.
    expect(start([session('s1', 'x1', 50), session('s2', 'x2', 40)], [scratch('x1', 0), scratch('x2', 0, 'devbox')])).toEqual([['No folder', { workspace: NO_FOLDER }]]);
    expect(start([session('s1', 'x2', 50), session('s2', 'x1', 40)], [scratch('x1', 0), scratch('x2', 0, 'devbox')])).toEqual([['No folder', { workspace: NO_FOLDER, host: 'devbox' }]]);
    expect(start([session('s1', 'a', 2), session('s2', 'b', 1), session('s3', null, 0)], [ws('a', 0), ws('b', 0, false)])).toEqual([
      ['A', { workspace: 'a' }],
      ['B', null],
      ['Ungrouped', null],
    ]);
  });
});
