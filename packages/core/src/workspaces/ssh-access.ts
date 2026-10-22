/**
 * How Atelier reaches an SSH host (desktop): its own list of connections, and the questions ssh asks on the way (an
 * unknown host's key, a password or passphrase) put to the person instead of failing under BatchMode.
 *
 * The system `ssh` does the work. It runs with a tiny SSH_ASKPASS script that logs every prompt ssh makes and answers
 * from the environment: "no" to trusting a host key and no password, until the person has answered, which is how a
 * probe learns what it needs. A connection that goes through (`ssh … true` exits 0) is remembered for this run; later
 * connections of that host use the saved password, if any, and never prompt.
 */
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SshAnswer, SshConnection, SshConnectionInput, SshPrompt, SshTestResult } from '@atelier/protocol';
import { newId } from '../util/ids.ts';
import { SshError, sshShell, type RemoteShell } from './ssh.ts';

/** The answers a probe gets from the script: whether to trust a new host key, and a password to give. */
interface Answers {
  trust: boolean;
  password?: string | undefined;
  /** Also give the password for a local key's passphrase (the person was shown that prompt). */
  passphrase?: boolean;
}

export interface SshAccessDeps {
  /** The `ssh` command (the system's). */
  ssh: string;
  /** A folder for the askpass script and its logs (created, private). */
  dir: string;
  /** The person's connections, to find a host's port, key and saved password. */
  connections(userId: string): Promise<SshConnection[]>;
  secrets: { get(id: string): Promise<string | undefined>; set(secret: { id: string; label: string; kind: 'token'; value: string }): Promise<unknown>; delete(id: string): Promise<unknown> };
  /** Asks the person; rejects when they don't answer in time or their window can't be reached. */
  prompt(userId: string, prompt: SshPrompt): Promise<SshAnswer>;
  /** For tests: spawn instead of the system's. */
  spawn?: typeof spawn;
}

/** The secret holding a connection's saved password. Personal: never listed for admins or reachable from settings. */
export const sshSecretId = (userId: string, connectionId: string) => `ssh-user-${userId}-${connectionId}`;

const ASKPASS = `#!/bin/sh
# Atelier's answers to what ssh asks (see ssh-access.ts): log it, then answer from the environment.
printf '%s\\n--ATELIER--\\n' "$1" >> "$ATELIER_ASKPASS_LOG"
case "$1" in
  *"continue connecting"*)
    if [ "$ATELIER_ASKPASS_TRUST" = "1" ]; then echo yes; exit 0; fi
    echo no; exit 1 ;;
  "Enter passphrase for key"*)
    # A host password isn't a key's passphrase: decline, and ssh goes on to the next key and then the password.
    if [ "$ATELIER_ASKPASS_PASSPHRASE" = "1" ] && [ -n "$ATELIER_ASKPASS_PASSWORD" ]; then printf '%s\\n' "$ATELIER_ASKPASS_PASSWORD"; exit 0; fi
    exit 1 ;;
  *)
    if [ -n "$ATELIER_ASKPASS_PASSWORD" ]; then printf '%s\\n' "$ATELIER_ASKPASS_PASSWORD"; exit 0; fi
    exit 1 ;;
esac
`;

const PROBE_MS = 25_000;
/** Prompts put to the person for one connection, at most (a wrong password asked again, a host key, a code). */
const MAX_ROUNDS = 5;

interface Probe {
  code: number | null;
  stderr: string;
  /** What ssh asked, in order. */
  prompts: string[];
}

export type Classified =
  | { kind: 'hostkey'; host: string; keyType: string; fingerprint: string }
  | { kind: 'password'; prompt: string; canSave: boolean };

/** What an askpass prompt is: a new host's key, or a password, passphrase or code to give. */
export function classifyPrompt(prompt: string): Classified {
  if (/continue connecting/i.test(prompt)) {
    const host = /authenticity of host '([^']+)'/.exec(prompt)?.[1] ?? 'this host';
    const keyType = /(\w+) key fingerprint is/.exec(prompt)?.[1] ?? 'host';
    const fingerprint = /fingerprint is ((?:SHA256|MD5):\S+?)\.?\s/.exec(prompt)?.[1] ?? /((?:SHA256|MD5):[\w+/=:]+)/.exec(prompt)?.[1] ?? 'unknown';
    return { kind: 'hostkey', host, keyType, fingerprint };
  }
  const text = prompt.trim();
  // A one-time code or a question isn't something to keep.
  return { kind: 'password', prompt: text, canSave: /password|passphrase/i.test(text) && !/verification|one-time|code/i.test(text) };
}

export class SshAccess {
  /** Hosts that went through in this run, by user and host: no probe again. */
  private verified = new Map<string, RemoteShell>();
  private script: Promise<string | null> | null = null;

  constructor(private readonly deps: SshAccessDeps) {}

  /** The shell for a connection: one that goes through, asking the person what ssh needs the first time. */
  async shell(userId: string, host: string): Promise<RemoteShell> {
    const key = `${userId}\0${host}`;
    const known = this.verified.get(key);
    if (known) return known;
    const connection = (await this.deps.connections(userId)).find((c) => c.host === host) ?? null;
    const shell = await this.connect(userId, connection ?? { id: '', name: host, host, port: null, keyPath: null, folder: null });
    this.verified.set(key, shell);
    return shell;
  }

  /** Forgets that a host went through (its connection's details or password changed). */
  forget(userId: string, host?: string): void {
    for (const key of [...this.verified.keys()]) if (key.startsWith(`${userId}\0`) && (!host || key.endsWith(`\0${host}`))) this.verified.delete(key);
  }

  /** Connects with what the person typed (a connection not saved yet): the same questions, then what answers. */
  async test(userId: string, input: SshConnectionInput & { id?: string }): Promise<SshTestResult> {
    const connection: SshConnection = { ...input, id: input.id ?? '' };
    try {
      const shell = await this.connect(userId, connection);
      const run = await this.run(shell, 'uname -sm');
      return { ok: true, message: run.stdout.trim() ? `Connected: ${run.stdout.trim()}.` : 'Connected.' };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  private async connect(userId: string, connection: SshConnection): Promise<RemoteShell> {
    const script = await this.askpass();
    // Windows (no sh) and a missing ssh: the plain shell, keys and agent only.
    if (!script) return this.plain(connection);
    const saved = connection.id ? await this.deps.secrets.get(sshSecretId(userId, connection.id)) : undefined;
    const answers: Answers = { trust: false, password: saved };
    let keep: string | null = null;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const probe = await this.probe(connection, script, answers);
      if (probe.code === 0) {
        if (keep && connection.id) {
          await this.deps.secrets.set({ id: sshSecretId(userId, connection.id), label: `SSH password (${connection.name})`, kind: 'token', value: keep });
        }
        return this.through(connection, script, answers);
      }
      const asked = probe.prompts.map(classifyPrompt);
      const hostkey = asked.find((a) => a.kind === 'hostkey');
      if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/.test(probe.stderr) && !hostkey) {
        throw new SshError(changedKeyMessage(connection, probe.stderr));
      }
      if (hostkey && !answers.trust) {
        const answer = await this.deps.prompt(userId, { id: newId(), kind: 'hostkey', connection: connection.name, host: hostkey.host, keyType: hostkey.keyType, fingerprint: hostkey.fingerprint });
        if (!answer.accept) throw new SshError(`${connection.name}'s host key wasn't trusted, so Atelier didn't connect.`);
        answers.trust = true;
        continue;
      }
      // An encrypted local key's passphrase is asked before the host's password: ask for the host's password when ssh got
      // that far (that's what a password host needs), for the passphrase only when nothing else was asked.
      const passwords = asked.filter((a) => a.kind === 'password');
      const wanted = passwords.find((a) => !isKeyPassphrase(a.prompt)) ?? passwords[0];
      if (wanted?.kind === 'password') {
        const answer = await this.deps.prompt(userId, {
          id: newId(),
          kind: 'password',
          connection: connection.name,
          host: connection.host,
          prompt: wanted.prompt,
          // Something was given before and refused.
          retry: answers.password !== undefined,
          canSave: wanted.canSave && !!connection.id,
        });
        if (answer.password === undefined) throw new SshError('No password was given, so Atelier didn’t connect.');
        const wasSaved = saved !== undefined && answers.password === saved;
        answers.password = answer.password;
        answers.passphrase = isKeyPassphrase(wanted.prompt);
        keep = answer.save && wanted.canSave ? answer.password : null;
        // A saved password that stopped working is forgotten (replaced once the new one goes through).
        if (wasSaved && connection.id && !keep) await this.deps.secrets.delete(sshSecretId(userId, connection.id));
        continue;
      }
      throw new SshError(failureMessage(connection, probe.stderr, probe.code));
    }
    throw new SshError(`Couldn't sign in to ${connection.name}.`);
  }

  /** `ssh … true` with the askpass script answering from `answers`; what it asked and how it ended. */
  private async probe(connection: SshConnection, script: string, answers: Answers): Promise<Probe> {
    const log = join(this.deps.dir, `askpass-${newId()}.log`);
    const spawnIt = this.deps.spawn ?? spawn;
    const args = ['-o', 'BatchMode=no', '-o', 'ConnectTimeout=10', '-o', 'NumberOfPasswordPrompts=1', '-o', 'StrictHostKeyChecking=ask', ...target(connection), 'true'];
    const child = spawnIt(this.deps.ssh, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...askpassEnv(script, log, answers) } });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), PROBE_MS);
    const code = await new Promise<number | null>((resolve) => {
      child.on('error', (e) => {
        stderr += e.message;
        resolve(null);
      });
      child.on('close', (c) => resolve(c));
    });
    clearTimeout(timer);
    const logged = await readFile(log, 'utf8').catch(() => '');
    await rm(log, { force: true });
    return { code, stderr, prompts: logged.split('--ATELIER--\n').map((p) => p.trim()).filter(Boolean) };
  }

  /** The shell the runner uses once a probe went through: no prompts, the password (if any) answered from the environment. */
  private through(connection: SshConnection, script: string, answers: Answers): RemoteShell {
    const base = this.plain(connection);
    if (answers.password === undefined) return base;
    return {
      ...base,
      args: ['-o', 'BatchMode=no', ...base.args.filter((a, i, all) => !(a === 'BatchMode=yes' || (a === '-o' && all[i + 1] === 'BatchMode=yes')))],
      env: askpassEnv(script, join(this.deps.dir, 'askpass-runtime.log'), { trust: false, password: answers.password, passphrase: !!answers.passphrase }),
    };
  }

  /** BatchMode ssh to the connection's host: keys and agent only, never a prompt. */
  private plain(connection: SshConnection): RemoteShell {
    const shell = sshShell(this.deps.ssh, connection.host);
    const options = shell.args.slice(0, -1);
    return { ...shell, args: [...options, ...target(connection)], label: connection.name };
  }

  private async run(shell: RemoteShell, command: string): Promise<{ stdout: string }> {
    const spawnIt = this.deps.spawn ?? spawn;
    const child = spawnIt(shell.command, [...shell.args, command], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...shell.env } });
    let stdout = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    await new Promise<void>((resolve) => {
      child.on('error', () => resolve());
      child.on('close', () => resolve());
    });
    return { stdout };
  }

  /** The askpass script, written once; null where there is no `sh` to run it. */
  private askpass(): Promise<string | null> {
    this.script ??= (async () => {
      if (process.platform === 'win32') return null;
      await mkdir(this.deps.dir, { recursive: true, mode: 0o700 });
      const path = join(this.deps.dir, 'askpass.sh');
      await writeFile(path, ASKPASS, { mode: 0o700 });
      await chmod(path, 0o700);
      return path;
    })().catch(() => null);
    return this.script;
  }
}

/** ssh's destination arguments for a connection: port, key and host. */
function target(connection: SshConnection): string[] {
  return [...(connection.port ? ['-p', String(connection.port)] : []), ...(connection.keyPath ? ['-i', expandHome(connection.keyPath)] : []), connection.host];
}

const expandHome = (path: string) => (path.startsWith('~/') ? join(process.env.HOME ?? '', path.slice(2)) : path);

function askpassEnv(script: string, log: string, answers: Answers): Record<string, string> {
  return {
    SSH_ASKPASS: script,
    SSH_ASKPASS_REQUIRE: 'force',
    // Older ssh only uses askpass with a DISPLAY set and no terminal.
    DISPLAY: process.env.DISPLAY || ':0',
    ATELIER_ASKPASS_LOG: log,
    ATELIER_ASKPASS_TRUST: answers.trust ? '1' : '0',
    ATELIER_ASKPASS_PASSWORD: answers.password ?? '',
    ATELIER_ASKPASS_PASSPHRASE: answers.passphrase ? '1' : '0',
  };
}

const isKeyPassphrase = (prompt: string) => /^Enter passphrase for key/i.test(prompt);

function changedKeyMessage(connection: SshConnection, stderr: string): string {
  const fingerprint = /fingerprint for the \w+ key sent by the remote host is\s+(\S+?)\.?\s/i.exec(stderr)?.[1];
  return (
    `${connection.name}'s host key changed since it was last trusted${fingerprint ? ` (it is now ${fingerprint})` : ''}. ` +
    `That can be a reinstalled server, or someone in between. If you know why, remove the old key with \`ssh-keygen -R ${connection.host}\` and connect again.`
  );
}

function failureMessage(connection: SshConnection, stderr: string, code: number | null): string {
  const text = stderr.trim().split('\n').filter((l) => !/^Warning: Permanently added/.test(l)).slice(-2).join(' ');
  if (/Permission denied/i.test(text)) return `${connection.name} refused the sign-in (${text}). Check the user name, the key or the password.`;
  if (/Could not resolve hostname|Connection refused|timed out|No route to host/i.test(text)) return `Can't reach ${connection.name}: ${text}`;
  return text || `Connecting to ${connection.name} failed (exit ${code ?? 'none'}).`;
}
