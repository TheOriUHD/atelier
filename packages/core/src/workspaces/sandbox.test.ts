import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../store/db.ts';
import { users } from '../store/schema.ts';
import { hostRunnerBinary } from './runner-client.ts';
import { sandboxHint, sandboxShell } from './sandbox.ts';
import { WorkspaceManager } from './workspace-manager.ts';

const runnerDir = join(import.meta.dirname, '../../../../runner/bin');
const built = existsSync(hostRunnerBinary(runnerDir)) && existsSync(join(runnerDir, 'checksums.json'));

/** Stands in for ssh into the sandbox: the login (`sbx000@sandbox`) decides the home folder, as it does in the container. */
const FAKE_SSH = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
let i = 0;
while (i < args.length && args[i].startsWith('-')) i += ['-o', '-i', '-p'].includes(args[i]) ? 2 : 1;
const [user] = args[i++].split('@');
const child = spawn('/bin/sh', ['-c', args.slice(i).join(' ')], { stdio: 'inherit', env: { ...process.env, HOME: process.env.FAKE_SANDBOX_HOMES + '/' + user } });
child.on('close', (code) => process.exit(code ?? 1));
`;

let dir: string;
const lastArg = (args: string[]) => args[args.length - 1];
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'atelier-sandbox-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const environment = (more: Record<string, string> = {}) => ({ ATELIER_SANDBOX_HOST: 'sandbox', ATELIER_SANDBOX_KEYS: join(dir, 'keys', 'authorized_keys'), ...more });

describe('the way into the sandbox', () => {
  it('is off without a sandbox host', () => {
    expect(sandboxShell({}, dir)).toBeNull();
  });

  it('logs each account in as its own Unix user, and tells the container which account it is', async () => {
    const shell = sandboxShell(environment(), join(dir, 'data'))!;
    const [ada, bob, again] = [await shell('ada'), await shell('bob'), await shell('ada')];
    expect(lastArg(ada.args)).toBe('sbx000@sandbox');
    expect(lastArg(bob.args)).toBe('sbx001@sandbox');
    expect(lastArg(again.args)).toBe('sbx000@sandbox');
    expect(ada.args).toEqual(expect.arrayContaining(['-p', '2222', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes']));
    // The server's key is what the container accepts; the accounts' ids are told through the same volume, out of the accounts' reach.
    expect(readFileSync(join(dir, 'keys', 'authorized_keys'), 'utf8')).toBe(readFileSync(join(dir, 'data', 'sandbox', 'id_ed25519.pub'), 'utf8'));
    expect(readFileSync(join(dir, 'keys', 'accounts', 'sbx000'), 'utf8')).toBe('ada\n');
    expect(readFileSync(join(dir, 'keys', 'accounts', 'sbx001'), 'utf8')).toBe('bob\n');
    expect(JSON.parse(readFileSync(join(dir, 'data', 'sandbox', 'slots.json'), 'utf8')).accounts).toEqual({ ada: 0, bob: 1 });
  });

  it('keeps an account on its user after a restart of the server', async () => {
    const first = sandboxShell(environment(), join(dir, 'data'))!;
    await first('ada');
    await first('bob');
    const restarted = sandboxShell(environment(), join(dir, 'data'))!;
    expect(lastArg((await restarted('bob')).args)).toBe('sbx001@sandbox');
    expect(lastArg((await restarted('cy')).args)).toBe('sbx002@sandbox');
  });

  it('uses the one user ATELIER_SANDBOX_USER names, for everybody, when a sandbox of your own has no account users', async () => {
    const shell = sandboxShell(environment({ ATELIER_SANDBOX_USER: 'dev', ATELIER_SANDBOX_PORT: '2200' }), join(dir, 'data'))!;
    expect(lastArg((await shell('ada')).args)).toBe('dev@sandbox');
    expect(lastArg((await shell('bob')).args)).toBe('dev@sandbox');
    expect((await shell('bob')).args).toEqual(expect.arrayContaining(['-p', '2200']));
    expect(existsSync(join(dir, 'data', 'sandbox', 'slots.json'))).toBe(false);
    expect(existsSync(join(dir, 'keys', 'accounts'))).toBe(false);
  });

  it('says what to do when every user is taken, or the setting is wrong', async () => {
    const small = sandboxShell(environment({ ATELIER_SANDBOX_SLOTS: '1' }), join(dir, 'data'))!;
    await small('ada');
    await expect(small('bob')).rejects.toThrow(/no free account left \(all 1 are taken\)/);
    const wrong = sandboxShell(environment({ ATELIER_SANDBOX_SLOTS: 'lots' }), join(dir, 'data2'))!;
    await expect(wrong('ada')).rejects.toThrow(/ATELIER_SANDBOX_SLOTS must be a whole number/);
  });

  it('cannot tell the container who is who without the keys volume, so it refuses rather than share a user', async () => {
    const shell = sandboxShell({ ATELIER_SANDBOX_HOST: 'sandbox' }, join(dir, 'data'))!;
    await expect(shell('ada')).rejects.toThrow(/ATELIER_SANDBOX_KEYS/);
  });

  it('points at a sandbox that is older than the server when a login is refused', () => {
    expect(sandboxHint('Permission denied (publickey).')).toMatch(/Permission denied.*docker compose pull && docker compose up -d.*docker compose logs sandbox/);
    expect(sandboxHint('Connection refused')).toBe('Connection refused');
  });
});

describe.skipIf(!built || process.platform === 'win32')('chats in the sandbox, per account', () => {
  let db: Db;
  let homes: string;
  const managers: WorkspaceManager[] = [];
  const manager = () => {
    writeFileSync(join(dir, 'fake-ssh.mjs'), FAKE_SSH);
    chmodSync(join(dir, 'fake-ssh.mjs'), 0o755);
    process.env.FAKE_SANDBOX_HOMES = homes;
    const shell = sandboxShell(environment({ ATELIER_SSH: join(dir, 'fake-ssh.mjs') }), join(dir, 'data'))!;
    const m = new WorkspaceManager({ db, runnerBinary: null, runnerDir, sandboxShell: shell, logger: { info: () => {}, error: () => {} } });
    managers.push(m);
    return m;
  };
  beforeEach(async () => {
    db = openDatabase(':memory:');
    for (const id of ['ada', 'bob']) await db.insert(users).values({ id, username: id, name: id, role: 'user', passwordHash: 'x', createdAt: 0, updatedAt: 0 });
    homes = join(dir, 'homes');
    for (const user of ['sbx000', 'sbx001']) mkdirSync(join(homes, user), { recursive: true });
  });
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.disposeAll()));
    db.$client.close();
  });

  it('runs each account in a login, a home and a runner of its own', async () => {
    const m = manager();
    expect(m.chatSandboxes).toBe(true);
    const ada = await m.addChatSandbox('ada');
    const bob = await m.addChatSandbox('bob');
    const { version } = JSON.parse(readFileSync(join(runnerDir, 'checksums.json'), 'utf8')) as { version: string };
    for (const [user, folder, account] of [['sbx000', ada, 'ada'], ['sbx001', bob, 'bob']] as const) {
      // This runner is uploaded to the account's own home (the container's accounts can't read each other's) and rooted in its own chats/.
      expect(existsSync(join(homes, user, '.atelier', 'runner', version, 'atelier-runner'))).toBe(true);
      expect(folder.root.startsWith(join(homes, user, 'chats', account) + '/chat-')).toBe(true);
      expect(statSync(folder.root).isDirectory()).toBe(true);
      expect(folder).toMatchObject({ scratch: true, host: 'sandbox' });
    }
    const [inAda, inBob] = [await m.open('ada', ada.id), await m.open('bob', bob.id)];
    expect(inAda.home).toBe(join(homes, 'sbx000'));
    expect(inBob.home).toBe(join(homes, 'sbx001'));
    expect(inAda.sandbox).toEqual({ confined: true });
    const shell = await inBob.shellFor('s1');
    expect((await inBob.runner.call('shell.exec', { shellId: shell, command: 'echo "$HOME"' })).output.trim()).toBe(join(homes, 'sbx001'));
    // The account that isn't theirs can't open the folder either.
    await expect(m.open('bob', ada.id)).rejects.toThrow();
  });

  it('says so, in its own words, when the sandbox has no user left for an account', async () => {
    writeFileSync(join(dir, 'fake-ssh.mjs'), FAKE_SSH);
    chmodSync(join(dir, 'fake-ssh.mjs'), 0o755);
    process.env.FAKE_SANDBOX_HOMES = homes;
    const shell = sandboxShell(environment({ ATELIER_SSH: join(dir, 'fake-ssh.mjs'), ATELIER_SANDBOX_SLOTS: '1' }), join(dir, 'data'))!;
    const m = new WorkspaceManager({ db, runnerBinary: null, runnerDir, sandboxShell: shell, logger: { info: () => {}, error: () => {} } });
    managers.push(m);
    await m.addChatSandbox('ada');
    await expect(m.addChatSandbox('bob')).rejects.toThrow(/^The sandbox has no free account left \(all 1 are taken\)/);
  });

  it('keeps using the account’s user and runner for a chat made earlier, from a new run of the server', async () => {
    const first = manager();
    const ada = await first.addChatSandbox('ada');
    await first.addChatSandbox('bob');
    await first.disposeAll();
    const second = manager();
    const live = await second.open('ada', ada.id);
    expect(live.home).toBe(join(homes, 'sbx000'));
    expect(live.root).toBe(ada.root);
  });
});
