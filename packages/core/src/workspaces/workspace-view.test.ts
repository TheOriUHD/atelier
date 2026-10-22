import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../store/db.ts';
import { users } from '../store/schema.ts';
import { hostRunnerBinary } from './runner-client.ts';
import { TerminalManager } from './terminals.ts';
import type { Workspace } from './workspace.ts';
import { WorkspaceManager } from './workspace-manager.ts';
import { findFiles, gitDiff, gitStatus, grepFiles, listDir, parseStatus, readFile } from './workspace-view.ts';

const binary = hostRunnerBinary(join(import.meta.dirname, '../../../../runner/bin'));
const built = existsSync(binary);

let db: Db;
let dir: string;
let manager: WorkspaceManager;
let ws: Workspace;
const sh = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: dir });

beforeEach(async () => {
  if (!built) return;
  db = openDatabase(':memory:');
  await db.insert(users).values({ id: 'ada', username: 'ada', name: 'Ada', role: 'user', passwordHash: 'x', createdAt: 0, updatedAt: 0 });
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'atelier-view-')));
  manager = new WorkspaceManager({ db, runnerBinary: binary, logger: { info: () => {}, error: () => {} } });
  sh('init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, '.gitignore'), 'dist/\n');
  writeFileSync(join(dir, 'README.md'), '# Demo\n');
  ws = await manager.open('ada', (await manager.addLocal('ada', dir)).id);
});
afterEach(async () => {
  if (!built) return;
  await manager.disposeAll();
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!built)('workspace view', () => {
  it('lists one level, folders first, without .git or ignored files', async () => {
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'logo.bin'), Buffer.from([0, 1, 2, 3]));
    expect((await listDir(ws, '')).map((e) => `${e.kind}:${e.path}`)).toEqual(['dir:src', 'file:.gitignore', 'file:logo.bin', 'file:README.md']);
    expect((await listDir(ws, 'src')).map((e) => e.path)).toEqual(['src/a.ts']);
    expect(await readFile(ws, 'src/a.ts')).toMatchObject({ content: 'export const a = 1;\n', truncated: false });
    expect((await readFile(ws, 'logo.bin')).content).toBeNull();
    await expect(listDir(ws, '..')).rejects.toThrow(/outside/);
  });

  it('finds files for @-mentions, names first, ignored files left out', async () => {
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'app.js'), '');
    writeFileSync(join(dir, 'src', 'app.ts'), '');
    mkdirSync(join(dir, 'docs', 'app'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'app', 'guide.md'), '');
    writeFileSync(join(dir, 'src', 'wrapper.ts'), '');
    expect(await findFiles(ws, 'APP')).toEqual(['src/app.ts', 'src/wrapper.ts', 'docs/app/guide.md']);
    expect(await findFiles(ws, 'readme')).toEqual(['README.md']);
  });

  it('reports git status and diffs against HEAD, untracked files included', async () => {
    expect((await gitDiff(ws)).diff).toContain('+export const a = 1;'); // no commits yet: against the empty tree
    sh('add', '.');
    sh('commit', '-q', '-m', 'init');
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(dir, 'notes.md'), 'new file\n');
    writeFileSync(join(dir, 'staged.ts'), 'x\n');
    sh('add', 'staged.ts');

    expect(await gitStatus(ws)).toEqual({
      branch: 'main',
      upstream: null,
      files: [
        { path: 'src/a.ts', status: 'modified', staged: false },
        { path: 'staged.ts', status: 'added', staged: true },
        { path: 'notes.md', status: 'untracked', staged: false },
      ],
    });
    const { diff } = await gitDiff(ws);
    expect(diff).toContain('-export const a = 1;\n+export const a = 2;');
    expect(diff).toContain('+++ b/notes.md');
    expect((await gitDiff(ws, 'notes.md')).diff).not.toContain('a.ts');
    expect((await gitDiff(ws)).base).toBe('HEAD');

    // Staged: only what was added to the index, against HEAD.
    const staged = await gitDiff(ws, undefined, 'staged');
    expect(staged.diff).toContain('+++ b/staged.ts');
    expect(staged.diff).not.toContain('a.ts');
    expect(staged.diff).not.toContain('notes.md');
  });

  it('diffs a branch against where it left the default branch', async () => {
    sh('add', '.');
    sh('commit', '-q', '-m', 'init');
    sh('switch', '-q', '-c', 'feature');
    writeFileSync(join(dir, 'README.md'), '# Demo\n\nCommitted on the branch\n');
    sh('commit', '-q', '-am', 'feature work');
    sh('switch', '-q', 'main');
    sh('commit', '-q', '--allow-empty', '-m', 'main moved on');
    sh('switch', '-q', 'feature');
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 3;\n');

    const fromBase = await gitDiff(ws, undefined, 'base');
    expect(fromBase.base).toBe('main');
    expect(fromBase.diff).toContain('+Committed on the branch');
    expect(fromBase.diff).toContain('+export const a = 3;');
    expect((await gitDiff(ws)).diff).not.toContain('Committed on the branch');
  });

  it('searches file contents for what was typed, not a pattern', async () => {
    writeFileSync(join(dir, 'src', 'b.ts'), 'const price = a.b + 1; // (approx)\nconst other = 2;\n');
    expect(await grepFiles(ws, 'a.b + 1')).toEqual({ matches: [{ path: 'src/b.ts', line: 1, text: 'const price = a.b + 1; // (approx)' }], truncated: false });
    expect((await grepFiles(ws, 'EXPORT')).matches).toEqual([]);
    expect((await grepFiles(ws, 'export')).matches).toEqual([{ path: 'src/a.ts', line: 1, text: 'export const a = 1;' }]);
  });

  it('runs a terminal for the connection that opened it', async () => {
    const owner = {};
    let output = '';
    const exits: string[] = [];
    const terminals = new TerminalManager<object>({ data: (_o, _id, data) => (output += data), exit: (_o, id) => exits.push(id) });
    const id = await terminals.open(owner, 'ada', ws, { cols: 80, rows: 24 });
    await terminals.write(owner, id, 'echo "hi-$((40+2))"\r');
    for (let i = 0; i < 200 && !output.includes('hi-42'); i++) await new Promise((r) => setTimeout(r, 20));
    expect(output).toContain('hi-42');
    await expect(terminals.write({}, id, 'x')).rejects.toThrow(/closed/);
    await terminals.closeAll();
    await expect(terminals.write(owner, id, 'x')).rejects.toThrow(/closed/);
  });
});

describe('parseStatus', () => {
  it('reads how far the branch is ahead of and behind its upstream', () => {
    const out = ['# branch.oid abc', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1', ''].join('\0');
    expect(parseStatus(out)).toEqual({ branch: 'main', upstream: { ahead: 2, behind: 1 }, files: [] });
  });

  it('reads renames, conflicts and a detached HEAD', () => {
    const out = ['# branch.oid abc', '# branch.head (detached)', '2 R. N... 100644 100644 100644 aaa bbb R100 new name.ts', 'old.ts', 'u UU N... 100644 100644 100644 100644 a b c both.ts', '? new dir/x.md', ''].join('\0');
    expect(parseStatus(out)).toEqual({
      branch: null,
      upstream: null,
      files: [
        { path: 'new name.ts', status: 'renamed', staged: true },
        { path: 'both.ts', status: 'conflicted', staged: false },
        { path: 'new dir/x.md', status: 'untracked', staged: false },
      ],
    });
  });
});
