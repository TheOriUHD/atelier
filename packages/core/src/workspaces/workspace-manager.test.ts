import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type Db } from '../store/db.ts';
import { users } from '../store/schema.ts';
import { hostReader, renderInstructions } from '../instructions/instructions.ts';
import { NodeWorkspaceFs } from '../fs/workspace-fs.ts';
import { codeContext } from './code-context.ts';
import { repositorySnapshot } from './git.ts';
import { gitDiff, gitStatus } from './workspace-view.ts';
import { projectRules, rememberProjectRule } from './project-rules.ts';
import { hostRunnerBinary, type RunnerClient } from './runner-client.ts';
import { WorkspaceError, WorkspaceManager, scratchName } from './workspace-manager.ts';

/** Git Bash writes `C:\\Users/me/x` for what the runner calls `C:\\Users\\me\\x`. */
const slash = (path: string) => path.replaceAll('\\', '/');

const binary = hostRunnerBinary(join(import.meta.dirname, '../../../../runner/bin'));
const built = existsSync(binary);

let db: Db;
let dir: string;
let manager: WorkspaceManager;

beforeEach(async () => {
  db = openDatabase(':memory:');
  for (const id of ['ada', 'bob']) await db.insert(users).values({ id, username: id, name: id, role: 'user', passwordHash: 'x', createdAt: 0, updatedAt: 0 });
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'atelier-ws-')));
  manager = new WorkspaceManager({ db, runnerBinary: built ? binary : null, logger: { info: () => {}, error: () => {} } });
});
afterEach(async () => {
  vi.useRealTimers();
  await manager.disposeAll();
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!built)('WorkspaceManager', () => {
  it('trusts a folder at its git top level, per user', async () => {
    execFileSync('git', ['init', '-q', dir]);
    mkdirSync(join(dir, 'packages', 'app'), { recursive: true });
    const ws = await manager.addLocal('ada', join(dir, 'packages', 'app'));
    expect(ws).toMatchObject({ kind: 'local', root: dir, available: true, deviceId: null });
    expect(await manager.addLocal('ada', dir)).toEqual(ws);
    expect(await manager.list('bob')).toEqual([]);
    await expect(manager.open('bob', ws.id)).rejects.toBeInstanceOf(WorkspaceError);
  });

  it('moves from a folder to another on the same computer: relative, home-relative and absolute paths', async () => {
    const app = join(dir, 'app');
    const api = join(dir, 'api');
    mkdirSync(app);
    mkdirSync(api);
    const from = await manager.addLocal('ada', app);
    const sibling = await manager.openFrom('ada', from.id, '../api');
    expect(sibling).toMatchObject({ kind: 'local', root: api });
    expect(sibling.id).not.toBe(from.id);
    // Moving to a folder that is already one of the person's gives that workspace back.
    expect((await manager.openFrom('ada', sibling.id, app)).id).toBe(from.id);
    await expect(manager.openFrom('ada', from.id, '../missing')).rejects.toBeInstanceOf(WorkspaceError);
    await expect(manager.openFrom('bob', from.id, '../api')).rejects.toThrow(/no folder to move from/);
  });

  it("tells the desktop about this computer's folders, however they were added, and lists them for it at start", async () => {
    const trusted: string[] = [];
    const m = new WorkspaceManager({ db, runnerBinary: binary, trusted: (root) => trusted.push(root), logger: { info: () => {}, error: () => {} } });
    const app = join(dir, 'app');
    const api = join(dir, 'api');
    mkdirSync(app);
    mkdirSync(api);
    const from = await m.addLocal('ada', app);
    // The agent moved the session: the folder was never picked, yet "Show in Finder" must open it.
    await m.openFrom('ada', from.id, api);
    expect(trusted).toEqual([app, api]);
    expect((await m.localRoots()).sort()).toEqual([api, app].sort());
    await m.disposeAll();
  });

  it('opens a runner once and keeps one shell per session', async () => {
    const ws = await manager.addLocal('ada', dir);
    const a = await manager.open('ada', ws.id);
    expect(await manager.open('ada', ws.id)).toBe(a);
    const shell = await a.shellFor('s1');
    expect(await a.shellFor('s1')).toBe(shell);
    expect(await a.shellFor('s2')).not.toBe(shell);
    const run = await a.runner.call('shell.exec', { shellId: shell, command: 'pwd' });
    expect(slash(run.output.trim())).toBe(slash(dir));
    await manager.remove('ada', ws.id);
    expect(await manager.list('ada')).toEqual([]);
  });

  it('replaces a runner that is shutting down, and its exit leaves the new one alone', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ws = await manager.addLocal('ada', dir);
    const idle = await manager.open('ada', ws.id);
    vi.advanceTimersByTime(15 * 60_000);
    // Sessions arriving while the idle runner shuts down share one new runner.
    const [a, b] = await Promise.all([manager.open('ada', ws.id), manager.open('ada', ws.id)]);
    expect(a).not.toBe(idle);
    expect(b).toBe(a);
    await (idle.runner as RunnerClient).exited;
    expect(await manager.open('ada', ws.id)).toBe(a);
    expect((await a.runner.call('fs.stat', { path: '.' })).type).toBe('dir');
  });

  it('only shuts down runners of workspaces the person removes', async () => {
    const ws = await manager.addLocal('ada', dir);
    const live = await manager.open('ada', ws.id);
    await manager.remove('bob', ws.id);
    expect((await live.runner.call('fs.stat', { path: '.' })).type).toBe('dir');
    await manager.remove('ada', ws.id);
    await expect(live.runner.call('fs.stat', { path: '.' })).rejects.toThrow(/not running/);
  });

  it('reads project permission rules, Claude Code files only when enabled', async () => {
    mkdirSync(join(dir, '.claude'));
    mkdirSync(join(dir, '.atelier'));
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test *)'], deny: ['Read(.env)'] } }));
    writeFileSync(join(dir, '.atelier', 'settings.json'), JSON.stringify({ permissions: { ask: ['Bash(git push *)'] } }));
    writeFileSync(join(dir, '.atelier', 'settings.local.json'), '{ not json');
    const ws = await manager.open('ada', (await manager.addLocal('ada', dir)).id);
    expect(await projectRules(ws, true)).toEqual({ allow: ['Bash(npm test *)'], ask: ['Bash(git push *)'], deny: ['Read(.env)'] });
    expect(await projectRules(ws, false)).toEqual({ allow: [], ask: ['Bash(git push *)'], deny: [] });
  });

  it('remembers project rules in the local layer and keeps that file out of git', async () => {
    execFileSync('git', ['init', '-q', dir]);
    mkdirSync(join(dir, '.atelier'));
    writeFileSync(join(dir, '.atelier', 'settings.local.json'), JSON.stringify({ permissions: { deny: ['Read(.env)'] }, other: 1 }));
    const ws = await manager.open('ada', (await manager.addLocal('ada', dir)).id);
    expect((await projectRules(ws, false)).allow).toEqual([]);
    await rememberProjectRule(ws, 'Bash(npm test *)');
    await rememberProjectRule(ws, 'Bash(npm test *)');
    expect(JSON.parse(readFileSync(join(dir, '.atelier', 'settings.local.json'), 'utf8'))).toEqual({ permissions: { deny: ['Read(.env)'], allow: ['Bash(npm test *)'] }, other: 1 });
    expect(await projectRules(ws, false)).toEqual({ allow: ['Bash(npm test *)'], ask: [], deny: ['Read(.env)'] });
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8').trim().split('\n').filter((l) => l === '.atelier/settings.local.json')).toHaveLength(1);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' })).toBe('');
  });

  it('reads the folder facts and loads instruction files through the runner', async () => {
    execFileSync('git', ['init', '-q', dir]);
    mkdirSync(join(dir, '.claude', 'rules'), { recursive: true });
    writeFileSync(join(dir, 'AGENTS.md'), 'Use pnpm. @docs/style.md');
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'style.md'), 'Two spaces.');
    writeFileSync(join(dir, '.claude', 'rules', 'tests.md'), 'Run vitest.');
    const config = mkdtempSync(join(tmpdir(), 'atelier-config-'));
    writeFileSync(join(config, 'AGENTS.md'), 'Global rule.');
    const ws = await manager.open('ada', (await manager.addLocal('ada', dir)).id);
    const { workspace, instructions } = await codeContext(ws, {
      host: hostReader(new NodeWorkspaceFs(), [config]),
      home: config,
      globals: [{ path: join(config, 'AGENTS.md'), kind: 'system' }],
      claudeCode: true,
      kind: 'a folder on the person\'s computer',
      scratch: false,
      additionalDirectories: [],
    });
    rmSync(config, { recursive: true, force: true });
    expect(workspace).toMatchObject({ root: dir, git: true, kind: "a folder on the person's computer" });
    expect(instructions.map((f) => f.kind)).toEqual(['system', 'project', 'project', 'rules']);
    const text = renderInstructions(instructions);
    const order = ['Global rule.', 'Use pnpm.', 'Two spaces.', 'Run vitest.'].map((t) => text.indexOf(t));
    expect(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1]!))).toBe(true);
  });
});

describe.skipIf(!built)('scratch folders', () => {
  it('give each session without a folder a new, empty folder of its own, per person, under the data folder', async () => {
    const scratchDir = join(dir, 'data', 'scratch-workspaces');
    const m = new WorkspaceManager({ db, runnerBinary: binary, scratchDir, logger: { info: () => {}, error: () => {} } });
    const a = await m.addScratch('ada');
    const b = await m.addScratch('ada');
    const theirs = await m.addScratch('bob');
    expect(a).toMatchObject({ kind: 'local', scratch: true, deviceId: null, host: null, available: true });
    expect(a.root).toBe(join(scratchDir, 'ada', a.name));
    expect(a.name).toMatch(/^scratch-\d{4}-\d{2}-\d{2}-[0-9a-f]{6}$/);
    expect(b.root).not.toBe(a.root);
    expect(theirs.root.startsWith(join(scratchDir, 'bob', 'scratch-'))).toBe(true);
    expect(readdirSync(a.root)).toEqual([]);
    if (process.platform !== 'win32') expect(statSync(a.root).mode & 0o777).toBe(0o700);
    expect((await m.list('ada')).map((w) => w.id).sort()).toEqual([a.id, b.id].sort());
    await expect(m.open('bob', a.id)).rejects.toBeInstanceOf(WorkspaceError);
  });

  it('trust exactly the scratch folder, even inside a repository, and stay on disk when forgotten', async () => {
    execFileSync('git', ['init', '-q', dir]);
    writeFileSync(join(dir, 'secret.txt'), 'not yours');
    const m = new WorkspaceManager({ db, runnerBinary: binary, scratchDir: join(dir, 'scratch-workspaces'), logger: { info: () => {}, error: () => {} } });
    const ws = await m.addScratch('ada');
    const live = await m.open('ada', ws.id);
    expect(live.root).toBe(ws.root);
    const shell = await live.shellFor('s1');
    expect(slash((await live.runner.call('shell.exec', { shellId: shell, command: 'pwd' })).output.trim())).toBe(slash(ws.root));
    await live.runner.call('fs.write', { path: join(ws.root, 'notes.md'), content: '# Notes\n', mkdirp: true });
    await expect(live.runner.call('fs.read', { path: join(dir, 'secret.txt') })).rejects.toThrow(/outside the workspace/);
    await m.remove('ada', ws.id);
    expect(readFileSync(join(ws.root, 'notes.md'), 'utf8')).toBe('# Notes\n');
  });

  it('never take a repository around them for theirs, until the session makes one inside', async () => {
    // The data folder inside a repository, as when a home folder is kept in git.
    execFileSync('git', ['init', '-q', dir]);
    writeFileSync(join(dir, 'tracked.txt'), 'x');
    const m = new WorkspaceManager({ db, runnerBinary: binary, scratchDir: join(dir, 'data', 'scratch-workspaces'), logger: { info: () => {}, error: () => {} } });
    const live = await m.open('ada', (await m.addScratch('ada')).id);
    expect(await gitStatus(live)).toBeNull();
    expect(await gitDiff(live)).toEqual({ diff: '', truncated: false, base: null });
    expect(await repositorySnapshot(live)).toBeNull();
    const shell = await live.shellFor('s1');
    expect((await live.runner.call('shell.exec', { shellId: shell, command: 'git rev-parse --show-toplevel' })).exitCode).not.toBe(0);
    const facts = await codeContext(live, { host: hostReader(new NodeWorkspaceFs(), []), home: dir, globals: [], claudeCode: false, kind: 'a folder', scratch: true, additionalDirectories: [] });
    expect(facts.workspace).toMatchObject({ git: false, scratch: true });

    await live.runner.call('shell.exec', { shellId: shell, command: 'git init -q -b main' });
    expect((await gitStatus(live))?.branch).toBe('main');
  });

  it('keep a session to its own folder: not the data folder around it, nor another person’s scratch folder', async () => {
    // The desktop's data folder (every account's database and scratch folders) sits in ~/.atelier.
    const home = join(dir, 'home');
    const data = join(home, '.atelier', 'data');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'atelier.db'), 'every account');
    const previousHome = process.env.HOME;
    const previousProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home; // where Windows looks for a home folder
    const m = new WorkspaceManager({ db, runnerBinary: binary, scratchDir: join(data, 'scratch-workspaces'), logger: { info: () => {}, error: () => {} } });
    try {
      const theirs = await m.addScratch('bob');
      writeFileSync(join(theirs.root, 'diary.md'), 'private');
      const live = await m.open('ada', (await m.addScratch('ada')).id);
      for (const path of [join(data, 'atelier.db'), join(theirs.root, 'diary.md')]) {
        await expect(live.runner.call('fs.read', { path })).rejects.toThrow(/outside the workspace/);
      }
      expect((live.runner as RunnerClient).info.roots).toEqual([live.root, join(home, '.atelier', 'skills-cache')]);
    } finally {
      process.env.HOME = previousHome;
      if (previousProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousProfile;
      await m.disposeAll();
    }
  });

  it('become one of the person’s folders when they open one on purpose', async () => {
    const m = new WorkspaceManager({ db, runnerBinary: binary, scratchDir: join(dir, 'scratch-workspaces'), logger: { info: () => {}, error: () => {} } });
    const ws = await m.addScratch('ada');
    expect(await m.addLocal('ada', ws.root)).toMatchObject({ id: ws.id, scratch: false });
    expect((await m.list('ada'))[0]).toMatchObject({ id: ws.id, scratch: false });
  });

  it('are named by the local date and six hex digits', () => {
    expect(scratchName(new Date(2026, 0, 5, 23, 59), 'c31ade')).toBe('scratch-2026-01-05-c31ade');
    expect(scratchName(new Date())).toMatch(/^scratch-\d{4}-\d{2}-\d{2}-[0-9a-f]{6}$/);
  });
});

describe('WorkspaceManager on a server', () => {
  it('refuses folders on its own machine', async () => {
    const server = new WorkspaceManager({ db, runnerBinary: null, logger: { info: () => {}, error: () => {} } });
    expect(server.hostsLocal).toBe(false);
    await expect(server.addLocal('ada', dir)).rejects.toThrow(/does not run commands/);
    await expect(server.addScratch('ada')).rejects.toThrow(/desktop app/);
  });
});

describe.skipIf(!built)('a chat sandbox on this computer', () => {
  it('is a new folder per chat under the chat sandboxes folder, left out of the person’s folders', async () => {
    const sandboxes = join(dir, 'chat-sandboxes');
    const local = new WorkspaceManager({ db, runnerBinary: binary, chatSandboxDir: sandboxes, logger: { info: () => {}, error: () => {} } });
    try {
      expect(local.chatSandboxes).toBe(true);
      const one = await local.addChatSandbox('ada');
      const two = await local.addChatSandbox('ada');
      expect(one.root).not.toBe(two.root);
      expect(slash(one.root)).toContain('/chat-sandboxes/ada/chat-');
      expect(one.scratch).toBe(true);
      expect(readdirSync(join(sandboxes, 'ada'))).toHaveLength(2);
      const ws = await local.open('ada', one.id);
      expect(ws.sandbox).toEqual({ confined: process.platform === 'darwin' });
      const shell = await ws.shellFor('s1');
      const inside = await ws.runner.call('shell.exec', { shellId: shell, command: 'echo hi > note.txt && cat note.txt' });
      expect(inside.output.trim()).toBe('hi');
      if (process.platform === 'darwin') {
        // The macOS sandbox keeps writes to the folder (and temp folders): nothing can be made in the home folder.
        const probe = join(homedir(), `.atelier-sandbox-probe-${process.pid}`);
        try {
          const outside = await ws.runner.call('shell.exec', { shellId: shell, command: `echo x > ${JSON.stringify(probe)}` });
          expect(outside.exitCode).not.toBe(0);
          expect(existsSync(probe)).toBe(false);
        } finally {
          rmSync(probe, { force: true });
        }
      }
    } finally {
      await local.disposeAll();
    }
  });

  it('is offered only where chats can have one', () => {
    expect(new WorkspaceManager({ db, runnerBinary: null, chatSandboxDir: join(dir, 'x'), logger: { info: () => {}, error: () => {} } }).chatSandboxes).toBe(false);
    expect(manager.chatSandboxes).toBe(false);
  });
});
