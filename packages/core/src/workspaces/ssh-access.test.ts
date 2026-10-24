import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SshAnswer, SshConnection, SshPrompt } from '@atelier/protocol';
import { classifyPrompt, probeSsh, runOnce, SshAccess, sshSecretId, throughShell, writeAskpass, type SshDevice } from './ssh-access.ts';

/**
 * A stand-in for ssh: it asks the way ssh does (through SSH_ASKPASS) about an unknown host's key and then a
 * password, and answers `true` and `uname -sm`. State lives in files of FAKE_DIR.
 */
const FAKE_SSH = `#!/bin/sh
host=""; batch=""; cmd=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift; case "$1" in BatchMode=*) batch="\${1#BatchMode=}";; esac ;;
    -p|-i) shift ;;
    *) if [ -z "$host" ]; then host="$1"; else cmd="$1"; fi ;;
  esac
  shift
done
if [ -f "$FAKE_DIR/changed" ]; then
  echo "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!" >&2
  echo "The fingerprint for the ED25519 key sent by the remote host is" >&2
  echo "SHA256:newnewnew." >&2
  echo "Host key verification failed." >&2
  exit 255
fi
if ! grep -qx "$host" "$FAKE_DIR/known" 2>/dev/null; then
  if [ "$batch" = "yes" ]; then echo "Host key verification failed." >&2; exit 255; fi
  name="\${host#*@}"
  answer=$("$SSH_ASKPASS" "The authenticity of host '$name (10.0.0.5)' can't be established.
ED25519 key fingerprint is SHA256:abcDEF123.
Are you sure you want to continue connecting (yes/no/[fingerprint])? ") || answer=no
  if [ "$answer" != "yes" ]; then echo "Host key verification failed." >&2; exit 255; fi
  echo "$host" >> "$FAKE_DIR/known"
fi
if [ -f "$FAKE_DIR/keyphrase" ] && [ "$batch" != "yes" ]; then
  phrase=$("$SSH_ASKPASS" "Enter passphrase for key '/home/a/.ssh/id_ed25519': ") || phrase=""
  if [ -n "$phrase" ] && [ "$phrase" = "$(cat "$FAKE_DIR/keyphrase")" ]; then [ "$cmd" = "uname -sm" ] && echo "Linux x86_64"; exit 0; fi
fi
if [ -f "$FAKE_DIR/password" ]; then
  if [ "$batch" = "yes" ]; then echo "$host: Permission denied (publickey,password)." >&2; exit 255; fi
  given=$("$SSH_ASKPASS" "$host's password: ") || { echo "Permission denied (publickey,password)." >&2; exit 255; }
  if [ "$given" != "$(cat "$FAKE_DIR/password")" ]; then echo "Permission denied, please try again." >&2; exit 255; fi
fi
case "$cmd" in
  true) exit 0 ;;
  "uname -sm") echo "Linux x86_64"; exit 0 ;;
esac
exit 0
`;

let dir: string;
let secrets: Map<string, string>;
let asked: SshPrompt[];
let answers: Partial<SshAnswer>[];

const connection: SshConnection = { id: 'c1', name: 'GPU box', host: 'alice@devbox', port: null, keyPath: null, folder: null };

/** A desktop device doing what the desktop app does: probes and tests with its own ssh (here the fake), answers from the server. */
function fakeDevice(): SshDevice & { probes: number } {
  const ssh = join(dir, 'ssh');
  const ask = join(dir, 'device-ask');
  const script = writeAskpass(ask);
  const device = {
    probes: 0,
    probe: async (_user: string, _device: string, target: Parameters<SshDevice['probe']>[2], given: Parameters<SshDevice['probe']>[3]) => {
      device.probes++;
      return probeSsh({ ssh, dir: ask }, await script, target, given);
    },
    test: async (_user: string, _device: string, target: Parameters<SshDevice['test']>[2], given: Parameters<SshDevice['test']>[3]) =>
      (await runOnce(throughShell(ssh, ask, await script, target, given), 'uname -sm')).stdout,
  };
  return device;
}

function access(connections: SshConnection[] = [connection], device?: SshDevice) {
  return new SshAccess({
    ...(device ? { device } : {}),
    ssh: join(dir, 'ssh'),
    dir: join(dir, 'ask'),
    connections: async () => connections,
    secrets: {
      get: async (id) => secrets.get(id),
      set: async (s) => void secrets.set(s.id, s.value),
      delete: async (id) => void secrets.delete(id),
    },
    prompt: async (_user, prompt) => {
      asked.push(prompt);
      const next = answers.shift();
      if (!next) throw new Error('nobody answered');
      return { id: prompt.id, ...next };
    },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atelier-sshaccess-'));
  writeFileSync(join(dir, 'ssh'), FAKE_SSH);
  chmodSync(join(dir, 'ssh'), 0o755);
  process.env.FAKE_DIR = dir;
  secrets = new Map();
  asked = [];
  answers = [];
});
afterEach(() => {
  delete process.env.FAKE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('prompts', () => {
  it('tells a new host’s key from a password, passphrase or code', () => {
    expect(classifyPrompt("The authenticity of host 'devbox (10.0.0.5)' can't be established.\nED25519 key fingerprint is SHA256:abcDEF123.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ")).toEqual({
      kind: 'hostkey',
      host: 'devbox (10.0.0.5)',
      keyType: 'ED25519',
      fingerprint: 'SHA256:abcDEF123',
    });
    expect(classifyPrompt("alice@devbox's password: ")).toMatchObject({ kind: 'password', canSave: true });
    expect(classifyPrompt("Enter passphrase for key '/Users/a/.ssh/id_ed25519': ")).toMatchObject({ kind: 'password', canSave: true });
    expect(classifyPrompt('Verification code: ')).toMatchObject({ kind: 'password', canSave: false });
  });
});

// The fake `ssh` the suite puts on PATH is a shell script, which Windows can't run as a program.
describe.skipIf(process.platform === 'win32')('SshAccess', () => {
  it('asks to trust a new host key once, with its fingerprint, and goes on when it is trusted', async () => {
    answers.push({ accept: true });
    const ssh = access();
    const shell = await ssh.shell('u1', 'alice@devbox');
    expect(asked).toEqual([{ id: expect.any(String), kind: 'hostkey', connection: 'GPU box', host: 'devbox (10.0.0.5)', keyType: 'ED25519', fingerprint: 'SHA256:abcDEF123' }]);
    expect(shell.label).toBe('GPU box');
    expect(readFileSync(join(dir, 'known'), 'utf8')).toBe('alice@devbox\n');
    // Remembered for this run, and known to ssh from now on: no questions.
    expect(await ssh.shell('u1', 'alice@devbox')).toBe(shell);
    expect((await access().shell('u1', 'alice@devbox')).label).toBe('GPU box');
    expect(asked).toHaveLength(1);
  });

  it('does not connect when the host key is not trusted', async () => {
    answers.push({ accept: false });
    await expect(access().shell('u1', 'alice@devbox')).rejects.toThrow(/host key wasn't trusted/);
    expect(() => readFileSync(join(dir, 'known'), 'utf8')).toThrow();
  });

  it('asks for a password, again when it is wrong, and keeps it when asked to', async () => {
    writeFileSync(join(dir, 'known'), 'alice@devbox\n');
    writeFileSync(join(dir, 'password'), 'hunter2');
    answers.push({ password: 'wrong' }, { password: 'hunter2', save: true });
    const ssh = access();
    await ssh.shell('u1', 'alice@devbox');
    expect(asked.map((p) => (p.kind === 'password' ? p.retry : null))).toEqual([false, true]);
    expect(secrets.get(sshSecretId('u1', 'c1'))).toBe('hunter2');
    // A fresh run signs in with the kept password, without asking.
    asked.length = 0;
    const later = await access().shell('u1', 'alice@devbox');
    expect(asked).toEqual([]);
    expect(later.env?.ATELIER_ASKPASS_PASSWORD).toBe('hunter2');
  });

  it('asks for the host password, not a local key passphrase: unknown key, trust, password, saved, then no prompts', async () => {
    writeFileSync(join(dir, 'password'), 'hunter2');
    writeFileSync(join(dir, 'keyphrase'), 'key-secret');
    answers.push({ accept: true }, { password: 'hunter2', save: true });
    const shell = await access().shell('u1', 'alice@devbox');
    expect(asked.map((p) => p.kind)).toEqual(['hostkey', 'password']);
    expect(asked[1]).toMatchObject({ prompt: "alice@devbox's password:", retry: false, canSave: true });
    expect(secrets.get(sshSecretId('u1', 'c1'))).toBe('hunter2');
    expect(shell.env?.ATELIER_ASKPASS_PASSPHRASE).toBe('0');
    asked.length = 0;
    await access().shell('u1', 'alice@devbox');
    expect(asked).toEqual([]);
  });

  it('forgets a kept password that stopped working', async () => {
    writeFileSync(join(dir, 'known'), 'alice@devbox\n');
    writeFileSync(join(dir, 'password'), 'new-one');
    secrets.set(sshSecretId('u1', 'c1'), 'old-one');
    answers.push({ password: 'new-one', save: false });
    await access().shell('u1', 'alice@devbox');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ kind: 'password', retry: true });
    expect(secrets.has(sshSecretId('u1', 'c1'))).toBe(false);
  });

  it('explains a changed host key and offers no way to accept it', async () => {
    writeFileSync(join(dir, 'known'), 'alice@devbox\n');
    writeFileSync(join(dir, 'changed'), '');
    await expect(access().shell('u1', 'alice@devbox')).rejects.toThrow(/host key changed.*SHA256:newnewnew.*ssh-keygen -R alice@devbox/);
    expect(asked).toEqual([]);
  });

  it('tests a connection that is not saved yet, and reports what it found', async () => {
    answers.push({ accept: true });
    const result = await access().test('u1', { name: 'New', host: 'bob@other', port: 2222, keyPath: null, folder: null });
    expect(result).toEqual({ ok: true, message: 'Connected: Linux x86_64.' });
    answers.push({ accept: false });
    expect(await access().test('u1', { name: 'Other', host: 'carol@third', port: null, keyPath: null, folder: null })).toMatchObject({ ok: false, message: expect.stringMatching(/wasn't trusted/) });
  });
});

describe('SSH through a desktop device', () => {
  it('probes on the device and asks here, keeping a password the person wants kept', async () => {
    writeFileSync(join(dir, 'password'), 'hunter2');
    answers.push({ accept: true }, { password: 'hunter2', save: true });
    const device = fakeDevice();
    const ssh = access([connection], device);
    const got = await ssh.onDevice('ada', 'laptop', 'alice@devbox');
    expect(asked.map((p) => p.kind)).toEqual(['hostkey', 'password']);
    expect(got).toEqual({ connection: { name: 'GPU box', host: 'alice@devbox', port: null, keyPath: null }, answers: { trust: true, password: 'hunter2', passphrase: false } });
    expect(secrets.get(sshSecretId('ada', 'c1'))).toBe('hunter2');
    // Once through, the same host on the same device isn't probed again.
    await ssh.onDevice('ada', 'laptop', 'alice@devbox');
    expect(device.probes).toBe(3);
  });

  it('tests a connection from the device', async () => {
    answers.push({ accept: true });
    const result = await access([connection], fakeDevice()).test('ada', { name: 'GPU box', host: 'alice@devbox', port: 2200, keyPath: '~/.ssh/box', folder: null }, 'laptop');
    expect(result).toEqual({ ok: true, message: 'Connected: Linux x86_64.' });
  });

  it('refuses a key file the device couldn’t use, and needs a device to go through', async () => {
    const odd = { ...connection, keyPath: 'keys/box' };
    expect(await access([odd], fakeDevice()).test('ada', odd, 'laptop')).toMatchObject({ ok: false, message: expect.stringContaining('full path') });
    await expect(access([connection]).onDevice('ada', 'laptop', 'alice@devbox')).rejects.toThrow(/desktop app/);
  });
});
