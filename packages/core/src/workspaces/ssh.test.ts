import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../store/db.ts';
import { users } from '../store/schema.ts';
import { projectHooks, projectRules } from './project-rules.ts';
import { hostRunnerBinary } from './runner-client.ts';
import { bootstrapRunner, quote, remoteRun, sshConfigHosts, sshShell, type RemoteShell } from './ssh.ts';
import { WorkspaceManager } from './workspace-manager.ts';

const runnerDir = join(import.meta.dirname, '../../../../runner/bin');
const built = existsSync(hostRunnerBinary(runnerDir)) && existsSync(join(runnerDir, 'checksums.json'));

/** Stands in for ssh: skips options, takes the host, and runs the rest as a shell command here, with HOME at FAKE_SSH_HOME. */
const FAKE_SSH = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
let i = 0;
while (i < args.length && args[i].startsWith('-')) i += args[i] === '-o' ? 2 : 1;
const host = args[i++];
if (host === 'down') { process.stderr.write('ssh: connect to host down port 22: Connection refused\\n'); process.exit(255); }
const child = spawn('/bin/sh', ['-c', args.slice(i).join(' ')], { stdio: 'inherit', env: { ...process.env, HOME: process.env.FAKE_SSH_HOME } });
child.on('close', (code) => process.exit(code ?? 1));
`;

/** Stands in for `gh codespace ssh -c <name> -- <command>`: runs the command here, with HOME at FAKE_SSH_HOME. */
const FAKE_GH = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const child = spawn('/bin/sh', ['-c', args.slice(args.indexOf('--') + 1).join(' ')], { stdio: 'inherit', env: { ...process.env, HOME: process.env.FAKE_SSH_HOME } });
child.on('close', (code) => process.exit(code ?? 1));
`;

let db: Db;
let dir: string;
let home: string;
let ssh: string;
const managers: WorkspaceManager[] = [];
const manager = () => {
  const m = new WorkspaceManager({ db, runnerBinary: hostRunnerBinary(runnerDir), runnerDir, ssh, logger: { info: () => {}, error: () => {} } });
  managers.push(m);
  return m;
};

beforeEach(async () => {
  db = openDatabase(':memory:');
  await db.insert(users).values({ id: 'ada', username: 'ada', name: 'Ada', role: 'user', passwordHash: 'x', createdAt: 0, updatedAt: 0 });
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'atelier-ssh-')));
  home = join(dir, 'remote-home');
  mkdirSync(join(home, 'work', 'app', 'src'), { recursive: true });
  execFileSync('git', ['init', '-q', join(home, 'work', 'app')]);
  ssh = join(dir, 'fake-ssh.mjs');
  writeFileSync(ssh, FAKE_SSH);
  chmodSync(ssh, 0o755);
  process.env.FAKE_SSH_HOME = home;
});
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.disposeAll()));
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

// The fake `ssh` the suite puts on PATH is a shell script, which Windows can't run as a program.
describe.skipIf(!built || process.platform === 'win32')('SSH workspaces', () => {
  it('uploads the runner once, then works in a folder on the host', async () => {
    const ws = await manager().addSsh('ada', 'devbox', '~/work/app/src');
    expect(ws).toMatchObject({ kind: 'ssh', host: 'devbox', root: join(home, 'work', 'app'), name: 'app', available: true });
    const { version } = JSON.parse(execFileSync('cat', [join(runnerDir, 'checksums.json')], { encoding: 'utf8' })) as { version: string };
    const uploaded = join(home, '.atelier', 'runner', version, 'atelier-runner');
    const firstUpload = statSync(uploaded).mtimeMs;

    // A fresh app finds the runner already there (same checksum) and doesn't upload it again.
    const second = manager();
    const live = await second.open('ada', ws.id);
    expect(statSync(uploaded).mtimeMs).toBe(firstUpload);
    const shell = await live.shellFor('s1');
    expect((await live.runner.call('shell.exec', { shellId: shell, command: 'pwd' })).output.trim()).toBe(join(home, 'work', 'app'));
    expect(live.host).toBe('devbox');
  });

  it('browses the host’s folders and makes a new one, for choosing a folder on it', async () => {
    mkdirSync(join(home, 'work', 'zeta'), { recursive: true });
    mkdirSync(join(home, 'work', '.hidden'));
    mkdirSync(join(home, 'Documents'));
    writeFileSync(join(home, 'work', 'notes.txt'), 'not a folder');
    const server = manager();
    const start = await server.browseRemote('ada', 'devbox');
    expect(start).toMatchObject({ path: home, home });
    expect(start.dirs).toEqual(['Documents', 'work']);
    // `~/…`, an absolute path and a trailing slash all land on the same folder; files and dot-folders aren't listed.
    for (const path of ['~/work', join(home, 'work'), `${join(home, 'work')}/`]) {
      expect(await server.browseRemote('ada', 'devbox', path)).toMatchObject({ path: join(home, 'work'), dirs: ['app', 'zeta'] });
    }
    await expect(server.browseRemote('ada', 'devbox', join(home, 'missing'))).rejects.toThrow(/Can't open .*missing/);

    const made = await server.createRemoteFolder('ada', 'devbox', '~/work', 'new-project');
    expect(made).toBe(join(home, 'work', 'new-project'));
    expect(statSync(made).isDirectory()).toBe(true);
    expect((await server.browseRemote('ada', 'devbox', '~/work')).dirs).toContain('new-project');
    for (const bad of ['', '..', 'a/b', 'x\0y']) await expect(server.createRemoteFolder('ada', 'devbox', '~/work', bad)).rejects.toThrow(/without slashes/);
    await expect(server.createRemoteFolder('ada', 'devbox', '~/work', 'new-project')).rejects.toThrow(/Can't create/);
  });

  it('uploads the runner again once it is gone from the host', async () => {
    const m = manager();
    const ws = await m.addSsh('ada', 'devbox', '~/work/app');
    rmSync(join(home, '.atelier'), { recursive: true });
    await expect(m.open('ada', ws.id)).rejects.toThrow(/Runner exited/);
    const live = await m.open('ada', ws.id);
    expect((await live.runner.call('fs.stat', { path: '.' })).type).toBe('dir');
  });

  it('makes a session without a folder its scratch folder under ~/.atelier on the host, outside any repository there', async () => {
    // A home folder kept in git: the scratch folder's commands still see no repository.
    execFileSync('git', ['init', '-q', home]);
    const m = manager();
    const ws = await m.addScratch('ada', 'devbox');
    expect(ws).toMatchObject({ kind: 'ssh', host: 'devbox', scratch: true, available: true });
    expect(ws.root).toBe(join(home, '.atelier', 'scratch-workspaces', 'ada', ws.name));
    expect(ws.name).toMatch(/^scratch-\d{4}-\d{2}-\d{2}-[0-9a-f]{6}$/);
    const live = await m.open('ada', ws.id);
    const shell = await live.shellFor('s1');
    expect((await live.runner.call('shell.exec', { shellId: shell, command: 'pwd; ls -A | wc -l' })).output.trim().split('\n').map((l) => l.trim())).toEqual([ws.root, '0']);
    expect((await live.runner.call('shell.exec', { shellId: shell, command: 'git rev-parse --show-toplevel' })).exitCode).not.toBe(0);
    await expect(m.addScratch('ada', 'down')).rejects.toThrow(/Connection refused/);
  });

  it('explains hosts it can’t reach and refuses odd host names', async () => {
    await expect(manager().addSsh('ada', 'down', '~/work')).rejects.toThrow(/Connection refused/);
    await expect(manager().addSsh('ada', '-oProxyCommand=evil', '~/work')).rejects.toThrow(/ssh\/config or user@host/);
    await expect(new WorkspaceManager({ db, runnerBinary: null, logger: { info: () => {}, error: () => {} } }).addSsh('ada', 'devbox', '~')).rejects.toThrow(/desktop app/);
  });
});

describe.skipIf(!built || process.platform === 'win32')('codespace workspaces', () => {
  it('reach the checkout through gh codespace ssh with the person’s token', async () => {
    const gh = join(dir, 'fake-gh.mjs');
    writeFileSync(gh, FAKE_GH);
    chmodSync(gh, 0o755);
    const shells: string[] = [];
    const woken: string[] = [];
    const server = new WorkspaceManager({
      db,
      runnerBinary: null,
      runnerDir,
      codespaceWake: async (userId, name) => void woken.push(`${userId}:${name}`),
      codespaceShell: async (userId, name) => (shells.push(`${userId}:${name}`), { command: gh, args: ['codespace', 'ssh', '-c', name, '--'], env: { GH_TOKEN: 'tok' }, label: name }),
      logger: { info: () => {}, error: () => {} },
    });
    managers.push(server);
    const ws = await server.addCodespace('ada', 'fluffy-space', join(home, 'work', 'app'));
    expect(ws).toMatchObject({ kind: 'codespace', host: 'fluffy-space', root: join(home, 'work', 'app'), available: true });
    const live = await server.open('ada', ws.id);
    expect((await live.runner.call('fs.stat', { path: '.' })).path).toBe(join(home, 'work', 'app'));
    expect(shells.every((s) => s === 'ada:fluffy-space')).toBe(true);
    // Every connection to the codespace starts by waking it (a no-op when it runs), never another one's.
    expect(woken.length).toBeGreaterThan(0);
    expect(new Set(woken)).toEqual(new Set(['ada:fluffy-space']));
    // A server never opens SSH folders, even with runner builds for codespaces.
    await expect(server.addSsh('ada', 'devbox', '~/work')).rejects.toThrow(/desktop app/);
  });

  it('are trusted only when the person agreed, one codespace at a time, and ignore their own settings and hooks until then', async () => {
    const gh = join(dir, 'fake-gh.mjs');
    writeFileSync(gh, FAKE_GH);
    chmodSync(gh, 0o755);
    const server = new WorkspaceManager({
      db,
      runnerBinary: null,
      runnerDir,
      codespaceWake: async () => {},
      codespaceShell: async (_userId, name) => ({ command: gh, args: ['codespace', 'ssh', '-c', name, '--'], env: { GH_TOKEN: 'tok' }, label: name }),
      logger: { info: () => {}, error: () => {} },
    });
    managers.push(server);
    const checkout = join(home, 'work', 'app');
    mkdirSync(join(checkout, '.atelier'));
    writeFileSync(
      join(checkout, '.atelier', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(*)'] }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'touch ran' }] }] } }),
    );

    // Added without an answer, as `workspaces.addCodespace` does for a client that didn't ask: nothing the repository says applies.
    const first = await server.addCodespace('ada', 'first-space', checkout);
    expect(first).toMatchObject({ kind: 'codespace', host: 'first-space', trusted: false });
    const live = await server.open('ada', first.id);
    expect(live.trusted).toBe(false);
    expect(await projectRules(live, false)).toEqual({ allow: [], ask: [], deny: [] });
    expect(await projectHooks(live, false)).toEqual([]);

    // Another codespace of the same repository is its own decision.
    const second = await server.addCodespace('ada', 'second-space', checkout);
    expect(second.id).not.toBe(first.id);
    expect(second.trusted).toBe(false);

    // Only the person whose folder it is can trust it.
    await expect(server.trust('bob', first.id)).rejects.toThrow(/no longer exists/);
    expect((await server.list('ada')).map((w) => w.trusted)).toEqual([false, false]);

    // The answer reaches the runner that is already up, and nothing else.
    expect(await server.trust('ada', first.id)).toMatchObject({ id: first.id, trusted: true });
    expect(live.trusted).toBe(true);
    expect(await projectRules(live, false)).toEqual({ allow: ['Bash(*)'], ask: [], deny: [] });
    expect(await projectHooks(live, false)).toHaveLength(1);
    expect((await server.open('ada', second.id)).trusted).toBe(false);
    expect(Object.fromEntries((await server.list('ada')).map((w) => [w.host, w.trusted]))).toEqual({ 'first-space': true, 'second-space': false });

    // Agreeing while adding trusts the folder that was already there, and a new one from the start.
    expect(await server.addCodespace('ada', 'second-space', checkout, true)).toMatchObject({ id: second.id, trusted: true });
    expect(await server.addCodespace('ada', 'third-space', checkout, true)).toMatchObject({ trusted: true });
    // Adding it again without an answer takes nothing back.
    expect(await server.addCodespace('ada', 'first-space', checkout)).toMatchObject({ id: first.id, trusted: true });

    // Folders on the person's own computer or an SSH host are trusted when they are added: the desktop app asked first.
    const ssh = await manager().addSsh('ada', 'devbox', '~/work/app');
    expect(ssh.trusted).toBe(true);
  });
});

describe('missing commands', () => {
  it('says what to install when gh or ssh is not on the computer', async () => {
    const shell = (command: string) => ({ command, args: [], env: {}, label: 'x' }) as unknown as RemoteShell;
    await expect(remoteRun(shell('/nonexistent/bin/gh'), 'true')).rejects.toThrow(/^Codespaces need the GitHub CLI \(gh\).*cli\.github\.com/);
    await expect(remoteRun(shell('/nonexistent/bin/ssh'), 'true')).rejects.toThrow(/^This computer has no ssh command/);
    await expect(remoteRun(shell('/nonexistent/bin/other'), 'true')).rejects.toThrow(/^Can't run \/nonexistent\/bin\/other: /);
  });
});

describe('ssh helpers', () => {
  it('quotes for the remote shell and lists configured hosts', async () => {
    expect(quote("it's here")).toBe(`'it'\\''s here'`);
    expect(sshShell('ssh', 'devbox').args.join(' ')).toContain('-o ServerAliveInterval=10 -o ServerAliveCountMax=2 devbox');
    mkdirSync(join(dir, '.ssh'));
    writeFileSync(join(dir, '.ssh', 'config'), 'Host *\n  User me\nHost gpu-box nas\n  HostName 10.0.0.5\nhost devbox.local\nHost !bad *.corp\n');
    expect(await sshConfigHosts(dir)).toEqual(['gpu-box', 'nas', 'devbox.local']);
  });
});

describe('a connection that never answers', () => {
  it('says it timed out, with what the connection printed, instead of an exit code', async () => {
    const silent: RemoteShell = { command: process.execPath, args: ['-e', 'process.stderr.write("opening tunnel"); setTimeout(() => {}, 10_000)', '--'], label: 'sleepy-space', timeoutMs: 300 };
    await expect(bootstrapRunner(silent, runnerDir)).rejects.toThrow("sleepy-space didn't answer within 0 seconds: opening tunnel");
  });
});
