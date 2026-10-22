/**
 * Remote workspaces (ARCHITECTURE §6, §9-C): a command that runs shell commands on another machine — the
 * system `ssh` (so ~/.ssh/config, ProxyJump and agents just work) or `gh codespace ssh` — runs the runner
 * there. The first connection uploads the build for that machine's OS and architecture to
 * `~/.atelier/runner/<version>/` over stdin and checks it against the bundled checksum manifest.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { processChannel, type RunnerChannel } from './runner-client.ts';

export class SshError extends Error {}

/** How to run a command over there: `<command> <...args> '<remote command>'`, with extra environment. */
export interface RemoteShell {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** For messages: the host or codespace name. */
  label: string;
  /** How long a command may take; a codespace that just woke can need more than the default. */
  timeoutMs?: number;
}

/** `ssh` that never prompts (keys and agents only) and gives up quickly on a host that doesn't answer, or stops answering. */
export const sshShell = (ssh: string, host: string): RemoteShell => ({
  command: ssh,
  args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2', host],
  label: host,
});
const TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;

interface Manifest {
  version: string;
  binaries: Record<string, { file: string; sha256: string }>;
}

/** Single-quoted for the remote POSIX shell. */
export const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Runs a command over there, optionally feeding it `stdin`. */
export function remoteRun(
  shell: RemoteShell,
  command: string,
  stdin?: Uint8Array,
  timeoutMs = shell.timeoutMs ?? TIMEOUT_MS,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(shell.command, [...shell.args, command], { windowsHide: true, env: { ...process.env, ...shell.env } });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (e) => {
      const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
      const name = shell.command.split(/[\\/]/).at(-1)?.replace(/\.exe$/i, '');
      // The person sees this where they pick the codespace: say what to install, not a spawn error.
      if (missing && name === 'gh') reject(new SshError('Codespaces need the GitHub CLI (gh) on this computer. Install it from https://cli.github.com (on a Mac: brew install gh), then try again. You don’t need to sign in to it: Atelier uses the token you connected.'));
      else if (missing && name === 'ssh') reject(new SshError('This computer has no ssh command. Install OpenSSH (it comes with macOS and Linux; on Windows turn on the OpenSSH Client feature), then try again.'));
      else reject(new SshError(`Can't run ${shell.command}: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

/**
 * Makes sure the machine has this app's runner build and returns where it is, with its home folder.
 * Uploads it only when it is missing or its checksum doesn't match.
 */
export async function bootstrapRunner(shell: RemoteShell, runnerDir: string): Promise<{ runner: string; home: string }> {
  const host = shell.label;
  const probe = await remoteRun(shell, 'uname -s; uname -m; printf "%s\\n" "$HOME"');
  if (probe.code !== 0) {
    const said = probe.stderr.trim();
    if (probe.timedOut) throw new SshError(`${host} didn't answer within ${Math.round((shell.timeoutMs ?? TIMEOUT_MS) / 1000)} seconds${said ? `: ${said}` : '.'}`);
    throw new SshError(said || `Connecting to ${host} failed (exit ${probe.code}).`);
  }
  const [system, machine, home] = probe.stdout.trim().split('\n').map((l) => l.trim());
  const os = system === 'Linux' ? 'linux' : system === 'Darwin' ? 'darwin' : null;
  const arch = machine === 'x86_64' || machine === 'amd64' ? 'amd64' : machine === 'aarch64' || machine === 'arm64' ? 'arm64' : null;
  if (!os || !arch || !home) throw new SshError(`${host} runs ${system} on ${machine}; remote workspaces need Linux or macOS on x86-64 or ARM64.`);

  const manifest = JSON.parse(await readFile(join(runnerDir, 'checksums.json'), 'utf8')) as Manifest;
  const build = manifest.binaries[`${os}-${arch}`];
  if (!build) throw new SshError(`This app has no runner build for ${os}-${arch}.`);
  const runner = `${home}/.atelier/runner/${manifest.version}/atelier-runner`;
  const sha = `(sha256sum ${quote(runner)} 2>/dev/null || shasum -a 256 ${quote(runner)} 2>/dev/null) | cut -d' ' -f1`;
  if ((await remoteRun(shell, sha)).stdout.trim() === build.sha256) return { runner, home };

  const dir = runner.slice(0, runner.lastIndexOf('/'));
  const tmp = `${runner}.${process.pid}.tmp`;
  const upload = await remoteRun(shell, `mkdir -p ${quote(dir)} && cat > ${quote(tmp)} && chmod 755 ${quote(tmp)} && mv ${quote(tmp)} ${quote(runner)}`, await readFile(join(runnerDir, build.file)), UPLOAD_TIMEOUT_MS);
  if (upload.code !== 0) throw new SshError(`Uploading the runner to ${host} failed: ${upload.stderr.trim()}`);
  if ((await remoteRun(shell, sha)).stdout.trim() !== build.sha256) throw new SshError(`The runner on ${host} doesn't match its checksum after upload.`);
  return { runner, home };
}

/** The runner over there, its stdio carried by the remote shell; `env` is set for it over there. */
export function remoteRunnerChannel(shell: RemoteShell, runner: string, roots: string[], onLog?: (line: string) => void, env: Record<string, string> = {}): RunnerChannel {
  const assignments = Object.entries(env).map(([name, value]) => `${name}=${quote(value)}`);
  const command = [...assignments, quote(runner), '--stdio', ...roots.flatMap((r) => ['--root', quote(r)])].join(' ');
  return processChannel(shell.command, [...shell.args, command], { env: { ...process.env, ...shell.env }, ...(onLog ? { onLog } : {}) });
}

/** `Host` entries from ~/.ssh/config, without patterns. */
export async function sshConfigHosts(home = homedir()): Promise<string[]> {
  const text = await readFile(join(home, '.ssh', 'config'), 'utf8').catch(() => '');
  const hosts = new Set<string>();
  for (const m of text.matchAll(/^\s*Host\s+(.+)$/gim)) for (const h of m[1]!.split(/\s+/)) if (h && !/[*?!]/.test(h)) hosts.add(h);
  return [...hosts];
}
