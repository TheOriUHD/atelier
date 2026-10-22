import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SANDBOX_CHATS, SANDBOX_HOME, SANDBOX_HOMES, SandboxAccountError, SandboxAccounts, sandboxChats, sandboxSlots, sandboxUserName } from './sandbox-accounts.ts';

let dir: string;
let file: string;
let published: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atelier-slots-'));
  file = join(dir, 'data', 'sandbox', 'slots.json');
  published = join(dir, 'keys', 'accounts');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the sandbox’s accounts', () => {
  it('give each account a Unix user of its own and the same one every time', async () => {
    const accounts = new SandboxAccounts(file, published);
    const ada = await accounts.userFor('ada');
    const bob = await accounts.userFor('bob');
    expect([ada, bob]).toEqual(['sbx000', 'sbx001']);
    expect(await accounts.userFor('ada')).toBe(ada);
    expect(await accounts.userFor('bob')).toBe(bob);
  });

  it('keep the assignments across restarts, and never give a taken slot to a second account', async () => {
    expect(await new SandboxAccounts(file, published).userFor('ada')).toBe('sbx000');
    expect(await new SandboxAccounts(file, published).userFor('bob')).toBe('sbx001');
    const later = new SandboxAccounts(file, published);
    expect(await later.userFor('cy')).toBe('sbx002');
    expect(await later.userFor('ada')).toBe('sbx000');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, accounts: { ada: 0, bob: 1, cy: 2 } });
  });

  it('give distinct slots to accounts that arrive together', async () => {
    const accounts = new SandboxAccounts(file, published);
    const ids = Array.from({ length: 40 }, (_, i) => `account-${i}`);
    const users = await Promise.all(ids.map((id) => accounts.userFor(id)));
    expect(new Set(users).size).toBe(ids.length);
    expect(users).toEqual(ids.map((_, i) => sandboxUserName(i)));
  });

  it('tell the container which account a user is for, where the accounts themselves can’t read it', async () => {
    const accounts = new SandboxAccounts(file, published);
    await accounts.userFor('ada');
    await accounts.userFor('bob');
    expect(readFileSync(join(published, 'sbx000'), 'utf8')).toBe('ada\n');
    expect(readFileSync(join(published, 'sbx001'), 'utf8')).toBe('bob\n');
    if (process.platform !== 'win32') {
      expect(statSync(published).mode & 0o077).toBe(0);
      expect(statSync(join(published, 'sbx000')).mode & 0o077).toBe(0);
    }
  });

  it('are kept on disk before the container is told, so a restart can’t hand the slot to someone else', async () => {
    mkdirSync(join(dir, 'keys'), { recursive: true });
    // A file where the folder for the container's copy should be makes telling fail.
    writeFileSync(published, 'in the way');
    const accounts = new SandboxAccounts(file, published);
    await expect(accounts.userFor('ada')).rejects.toThrow();
    expect(JSON.parse(readFileSync(file, 'utf8')).accounts).toEqual({ ada: 0 });
    rmSync(published);
    expect(await new SandboxAccounts(file, published).userFor('ada')).toBe('sbx000');
    expect(readFileSync(join(published, 'sbx000'), 'utf8')).toBe('ada\n');
  });

  it('say when the pool is used up, and what to do about it', async () => {
    const accounts = new SandboxAccounts(file, published, 2);
    await accounts.userFor('ada');
    await accounts.userFor('bob');
    await expect(accounts.userFor('cy')).rejects.toThrow(/no free account left \(all 2 are taken\).*ATELIER_SANDBOX_SLOTS/);
    // Those who have one keep it.
    expect(await accounts.userFor('bob')).toBe('sbx001');
    expect(existsSync(join(published, 'sbx002'))).toBe(false);
  });

  it('refuse an account whose slot is beyond the pool the container has', async () => {
    await new SandboxAccounts(file, published, 10).userFor('ada');
    const bob = await new SandboxAccounts(file, published, 10).userFor('bob');
    expect(bob).toBe('sbx001');
    writeFileSync(file, JSON.stringify({ version: 1, accounts: { ada: 0, bob: 5 } }));
    await expect(new SandboxAccounts(file, published, 3).userFor('bob')).rejects.toThrow(/number 5, beyond ATELIER_SANDBOX_SLOTS \(3\)/);
  });

  it('refuse ids a folder can’t safely be named for (the container makes chats/<id> as root)', async () => {
    const accounts = new SandboxAccounts(file, published);
    for (const id of ['', '..', '../x', 'a/b', 'a b', 'x\n', 'a'.repeat(65), '.hidden']) await expect(accounts.userFor(id)).rejects.toBeInstanceOf(SandboxAccountError);
    expect(existsSync(file)).toBe(false);
    expect(await accounts.userFor('7d9f1c3e-2b4a-4c1d-9e8f-0a1b2c3d4e5f')).toBe('sbx000');
  });

  it('never replace a file they can’t read with an empty one', async () => {
    mkdirSync(join(dir, 'data', 'sandbox'), { recursive: true });
    for (const broken of ['not json', '{"version":2,"accounts":{}}', '{"version":1,"accounts":{"ada":0,"bob":0}}', '{"version":1,"accounts":{"ada":-1}}', '{"version":1,"accounts":{"../x":0}}']) {
      writeFileSync(file, broken);
      await expect(new SandboxAccounts(file, published).userFor('cy')).rejects.toThrow(/can't be used/);
      expect(readFileSync(file, 'utf8')).toBe(broken);
    }
  });

  it('need a place to tell the container which account is which', async () => {
    await expect(new SandboxAccounts(file, null).userFor('ada')).rejects.toThrow(/ATELIER_SANDBOX_KEYS/);
    expect(existsSync(file)).toBe(false);
  });
});

describe('the sandbox’s pool size', () => {
  it('is 256 unless ATELIER_SANDBOX_SLOTS says otherwise', () => {
    expect(sandboxSlots(undefined)).toBe(256);
    expect(sandboxSlots('')).toBe(256);
    expect(sandboxSlots('12')).toBe(12);
    expect(sandboxSlots(' 9999 ')).toBe(9999);
    for (const bad of ['0', '-1', '10000', 'many', '1.5', '1e3']) expect(() => sandboxSlots(bad)).toThrow(/ATELIER_SANDBOX_SLOTS/);
  });
});

describe('where an account’s chat folders go', () => {
  it('is the account’s own folder under chats/ when it logs in as its own user, and its home’s chats/ for one shared login', () => {
    expect(sandboxChats('ada', `${SANDBOX_HOMES}/sbx003`)).toEqual({ dir: `${SANDBOX_CHATS}/ada`, from: `${SANDBOX_CHATS}/ada` });
    expect(sandboxChats('ada', '/home/sandbox')).toEqual({ dir: '/home/sandbox/chats/ada', from: '/home/sandbox' });
    expect(sandboxChats('ada', '/home/dev')).toEqual({ dir: '/home/dev/chats/ada', from: '/home/dev' });
  });

  it('names the user the way the image creates them', () => {
    expect([sandboxUserName(0), sandboxUserName(7), sandboxUserName(255), sandboxUserName(1000)]).toEqual(['sbx000', 'sbx007', 'sbx255', 'sbx1000']);
  });
});

/** The image’s files are shell and config, tested for real on a container; this keeps them in step with the names above. */
describe('the sandbox image', () => {
  const files = join(import.meta.dirname, '../../../../apps/server/sandbox');
  const read = (name: string) => readFileSync(join(files, name), 'utf8');
  const dockerfile = readFileSync(join(import.meta.dirname, '../../../../apps/server/Dockerfile'), 'utf8');

  it('creates the users and folders the server expects', () => {
    const start = read('atelier-sandbox');
    expect(start).toContain(`vol=${SANDBOX_HOME}\n`);
    expect(start).toContain('first=20000');
    expect(start).toContain('slots=${ATELIER_SANDBOX_SLOTS:-256}');
    expect(start).toContain("printf 'sbx%03d'");
    // The homes are u/<user>, the chat folders chats/<account id>.
    expect(start).toContain('%s/u/%s:/bin/bash');
    expect(SANDBOX_HOMES).toBe(`${SANDBOX_HOME}/u`);
    expect(SANDBOX_CHATS).toBe(`${SANDBOX_HOME}/chats`);
    const keys = read('atelier-sandbox-keys');
    expect(keys).toContain(`vol=${SANDBOX_HOME}\n`);
    expect(keys).toContain('"$vol/u/$user"');
    expect(keys).toContain('chats=$vol/chats/$account');
    expect(keys).toContain('"$keys/accounts/$user"');
    // A user stays with the account it was first told for.
    expect(keys).toContain('"$vol/.slots/$user"');
    expect(start).toContain('.slots');
    expect(keys).toContain('sbx[0-9][0-9][0-9] | sbx[0-9][0-9][0-9][0-9]');
  });

  it('logs in only the accounts’ users, as them, with the keys the server publishes, and the files are in the image', () => {
    const sshd = read('sshd_config');
    expect(sshd).toMatch(/^AllowUsers sbx\*$/m);
    expect(sshd).toMatch(/^PermitRootLogin no$/m);
    expect(sshd).toMatch(/^PasswordAuthentication no$/m);
    expect(sshd).toMatch(/^UsePAM no$/m);
    expect(sshd).toMatch(/^AuthorizedKeysFile none$/m);
    expect(sshd).toMatch(/^AuthorizedKeysCommand \/usr\/local\/sbin\/atelier-sandbox-keys %u$/m);
    expect(sshd).toMatch(/^AuthorizedKeysCommandUser root$/m);
    for (const forwarding of ['AllowTcpForwarding', 'AllowAgentForwarding', 'X11Forwarding', 'PermitTunnel', 'PermitUserEnvironment', 'PermitUserRC']) expect(sshd).toMatch(new RegExp(`^${forwarding} no$`, 'm'));
    expect(dockerfile).toContain('apps/server/sandbox/atelier-sandbox-keys /usr/local/sbin/atelier-sandbox-keys');
    expect(dockerfile).toContain('apps/server/sandbox/atelier-sandbox /usr/local/bin/atelier-sandbox');
    expect(dockerfile).toContain('apps/server/sandbox/sshd_config /etc/atelier-sandbox/sshd_config');
    expect(dockerfile).toContain('CMD ["atelier-sandbox"]');
  });

  it('runs as root (sshd needs it to become the account’s user), has no privileged program that would let a login become another user, and no sudo', () => {
    const stage = dockerfile.slice(dockerfile.indexOf('AS sandbox'), dockerfile.indexOf('AS updater'));
    expect(stage).not.toMatch(/^USER /m);
    expect(stage).toContain('strip-privileges.py');
    expect(stage).not.toMatch(/\bsudo\b/);
    expect(read('strip-privileges.py')).toContain('sys.exit(1)');
  });
});
