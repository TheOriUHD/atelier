import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../store/db.ts';
import { users } from '../store/schema.ts';
import { branches, checkout, commit, GitError, push, revertPatch, stage } from './git.ts';
import { hostRunnerBinary } from './runner-client.ts';
import type { Workspace } from './workspace.ts';
import { WorkspaceManager } from './workspace-manager.ts';
import { gitDiff, gitStatus } from './workspace-view.ts';

const binary = hostRunnerBinary(join(import.meta.dirname, '../../../../runner/bin'));
const built = existsSync(binary);

let db: Db;
let dir: string;
let remote: string;
let manager: WorkspaceManager;
let ws: Workspace;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Setup', '-c', 'user.email=setup@example.com', ...args], { cwd, encoding: 'utf8' });

beforeEach(async () => {
  if (!built) return;
  db = openDatabase(':memory:');
  await db.insert(users).values({ id: 'ada', username: 'ada', name: 'Ada', role: 'user', passwordHash: 'x', createdAt: 0, updatedAt: 0 });
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'atelier-git-')));
  remote = realpathSync(mkdtempSync(join(tmpdir(), 'atelier-remote-')));
  git(remote, 'init', '-q', '--bare');
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# Demo\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'remote', 'add', 'origin', remote);
  manager = new WorkspaceManager({ db, runnerBinary: binary, logger: { info: () => {}, error: () => {} } });
  ws = await manager.open('ada', (await manager.addLocal('ada', dir)).id);
});
afterEach(async () => {
  if (!built) return;
  await manager.disposeAll();
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(remote, { recursive: true, force: true });
});

describe.skipIf(!built)('git bar', () => {
  it('switches branches, stages, commits as the chosen author and pushes', async () => {
    expect(await branches(ws)).toEqual({ current: 'main', branches: ['main'], lastCommit: 'init', defaultBranch: 'main' });
    await checkout(ws, 'feature/notes', true);
    expect(await branches(ws)).toEqual({ current: 'feature/notes', branches: ['feature/notes', 'main'], lastCommit: 'init', defaultBranch: 'main' });

    writeFileSync(join(dir, 'notes.md'), 'hello\n');
    await stage(ws, ['notes.md'], true);
    expect((await gitStatus(ws))?.files).toEqual([{ path: 'notes.md', status: 'added', staged: true }]);
    await stage(ws, ['notes.md'], false);
    expect((await gitStatus(ws))?.files).toEqual([{ path: 'notes.md', status: 'untracked', staged: false }]);
    await stage(ws, ['notes.md'], true);

    const hash = await commit(ws, 'Add notes', { name: 'Ada Lovelace', email: 'ada@example.com' });
    expect(git(dir, 'log', '-1', '--format=%h %an <%ae> %s')).toBe(`${hash} Ada Lovelace <ada@example.com> Add notes\n`);
    await expect(commit(ws, 'Again', { name: 'Ada', email: 'ada@example.com' })).rejects.toThrow(/nothing to commit|no changes added/);

    expect((await gitStatus(ws))?.upstream).toBeNull();
    await push(ws);
    expect(git(remote, 'branch', '--format=%(refname:short)')).toContain('feature/notes');
    expect((await gitStatus(ws))?.upstream).toEqual({ ahead: 0, behind: 0 });
  });

  it('unstages in a repository without commits', async () => {
    rmSync(join(dir, '.git'), { recursive: true, force: true });
    git(dir, 'init', '-q', '-b', 'main');
    await stage(ws, ['README.md'], true);
    await stage(ws, ['README.md'], false);
    expect((await gitStatus(ws))?.files).toEqual([{ path: 'README.md', status: 'untracked', staged: false }]);
    expect((await branches(ws)).lastCommit).toBeNull();
  });

  it('rejects a staged hunk from the index as well', async () => {
    writeFileSync(join(dir, 'README.md'), '# Demo\n\nMore.\n');
    git(dir, 'add', 'README.md');
    const { diff } = await gitDiff(ws);
    await revertPatch(ws, diff);
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('# Demo\n');
    expect((await gitStatus(ws))?.files).toEqual([]);
  });

  it('rejects one hunk and keeps the others, for tracked and new files', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(dir, 'list.txt'), `${lines.join('\n')}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'list');
    const changed = lines.map((l, i) => (i === 1 ? 'line 2 (early edit)' : i === 27 ? 'line 28 (late edit)' : l));
    writeFileSync(join(dir, 'list.txt'), `${changed.join('\n')}\n`);
    writeFileSync(join(dir, 'new.txt'), 'brand new\n');

    const { diff } = await gitDiff(ws);
    const file = diff.slice(diff.indexOf('diff --git a/list.txt'), diff.indexOf('diff --git a/new.txt'));
    const header = file.slice(0, file.indexOf('@@'));
    const hunks = file.slice(header.length).split(/(?=^@@ )/m);
    expect(hunks).toHaveLength(2);
    await revertPatch(ws, header + hunks[1]);
    expect(readFileSync(join(dir, 'list.txt'), 'utf8')).toContain('line 2 (early edit)');
    expect(readFileSync(join(dir, 'list.txt'), 'utf8')).not.toContain('late edit');

    await revertPatch(ws, diff.slice(diff.indexOf('diff --git a/new.txt')));
    expect(existsSync(join(dir, 'new.txt'))).toBe(false);
    await expect(revertPatch(ws, diff)).rejects.toThrow(/one file header/);
  });

  it('diffs and rejects a file whose name isn’t ASCII', async () => {
    writeFileSync(join(dir, 'café.txt'), 'one\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'café');
    writeFileSync(join(dir, 'café.txt'), 'two\n');
    const { diff } = await gitDiff(ws);
    expect(diff).toContain('diff --git a/café.txt b/café.txt');
    await revertPatch(ws, diff);
    expect(readFileSync(join(dir, 'café.txt'), 'utf8')).toBe('one\n');
  });

  it('refuses option-like branch names and explains git failures', async () => {
    await expect(checkout(ws, '--orphan', true)).rejects.toBeInstanceOf(GitError);
    await expect(checkout(ws, 'missing', false)).rejects.toThrow(/missing/);
  });
});
