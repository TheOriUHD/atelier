/**
 * Chat sandboxes (ARCHITECTURE §6): a scratch folder per chat where the model clones, reads and runs things under fixed
 * rules instead of permission prompts. On a server they live in the separate sandbox container, reached over SSH like
 * any host (so the server still never runs commands on its own machine), each account as a Unix user of its own
 * (`sandbox-accounts.ts`); in the desktop app's own backend they are folders on this computer, and on macOS the runner,
 * with everything it starts, runs inside the system sandbox.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { SandboxAccounts, sandboxSlots } from './sandbox-accounts.ts';
import type { RemoteShell } from './ssh.ts';

/** The `host` of workspaces in the server's sandbox container. */
export const SANDBOX_HOST = 'sandbox';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** Where a person's secrets and Atelier's own data live: never readable from a sandbox. */
const PRIVATE = [
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  '.kube',
  '.docker',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.config/gh',
  '.config/gcloud',
  '.atelier',
  'Library/Keychains',
  'Library/Cookies',
  'Library/Application Support/Atelier',
  'Library/Application Support/Google/Chrome',
  'Library/Application Support/Firefox',
  'Library/Application Support/Arc',
  'Library/Safari',
  'Library/Mail',
  'Library/Messages',
];

const quoted = (path: string) => `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * The macOS sandbox profile for a chat's folder: anything may run and read the system, but writes go only to the folder
 * and temporary folders, and the person's secrets and Atelier's data can't be read. The folder itself is allowed last,
 * since it lives inside Atelier's data folder.
 */
export function macosProfile(root: string, home: string): string {
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write* (require-not (require-any',
    `  (subpath ${quoted(root)}) (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "/dev")))) `,
    `(deny file-read* file-write* ${PRIVATE.map((p) => `(subpath ${quoted(join(home, p))})`).join(' ')})`,
    // Resolving the folder's path looks at each folder above it (metadata only: no listing, no contents). The runner
    // keeps downloaded skills in the skills cache and opens it at start.
    `(allow file-read-metadata (subpath ${quoted(join(home, '.atelier'))}))`,
    `(allow file-read* file-write* (subpath ${quoted(join(home, '.atelier', 'skills-cache'))}))`,
    `(allow file-read* file-write* (subpath ${quoted(root)}))`,
  ].join('\n');
}

/**
 * The server's way into its sandbox container, when one is configured (`ATELIER_SANDBOX_HOST`, set by the compose file):
 * SSH with a key the server makes once in its data folder, whose public half it writes where the container reads its
 * authorized keys (`ATELIER_SANDBOX_KEYS`). Null without a sandbox.
 *
 * The login is per account: the container has a Unix user for each account (`SandboxAccounts` gives one out, for good),
 * so what an account's commands can reach is decided by the operating system. `ATELIER_SANDBOX_USER` turns that off: every
 * account then logs in as that one user, for a sandbox you built yourself that has no such users.
 */
export function sandboxShell(env: Record<string, string | undefined>, dataDir: string): ((userId: string) => Promise<RemoteShell>) | null {
  const host = env.ATELIER_SANDBOX_HOST;
  if (!host) return null;
  const dir = join(dataDir, 'sandbox');
  const key = join(dir, 'id_ed25519');
  const shared = env.ATELIER_SANDBOX_USER?.trim() || null;
  let accounts: SandboxAccounts | null = null;
  let ready: Promise<void> | null = null;
  const prepare = async () => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (!existsSync(key)) await promisify(execFile)('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'atelier-server', '-f', key]);
    const published = env.ATELIER_SANDBOX_KEYS;
    if (published) {
      await mkdir(dirname(published), { recursive: true });
      await writeFile(published, await readFile(`${key}.pub`, 'utf8'));
    }
  };
  return async (userId) => {
    ready ??= prepare().catch((error: unknown) => {
      ready = null;
      throw error;
    });
    await ready;
    accounts ??= shared ? null : new SandboxAccounts(join(dir, 'slots.json'), env.ATELIER_SANDBOX_KEYS ? join(dirname(env.ATELIER_SANDBOX_KEYS), 'accounts') : null, sandboxSlots(env.ATELIER_SANDBOX_SLOTS));
    const user = shared ?? (await accounts!.userFor(userId));
    return {
      command: env.ATELIER_SSH ?? 'ssh',
      args: [
        '-i', key,
        '-o', 'IdentitiesOnly=yes',
        '-o', 'BatchMode=yes',
        // The container's host key is new whenever it is recreated, and it is only reachable on the compose network.
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'LogLevel=ERROR',
        '-o', 'ConnectTimeout=10',
        '-o', 'ServerAliveInterval=10',
        '-p', env.ATELIER_SANDBOX_PORT ?? '2222',
        `${user}@${host}`,
      ],
      label: 'the sandbox',
    };
  };
}

/**
 * What a refused login to the sandbox most likely means, added to the error: the server's account users aren't in the
 * container, which is then an older image than the server (the two are updated together: `docker compose pull && docker
 * compose up -d`), or the container found the account's user already given to another account (its log says so).
 */
export function sandboxHint(message: string): string {
  return /permission denied|publickey/i.test(message)
    ? `${message} (If the sandbox container was not updated with the server, update both: docker compose pull && docker compose up -d. Otherwise see docker compose logs sandbox.)`
    : message;
}

/** How to start a sandbox's runner on this machine: inside the macOS sandbox, or null where there is none. */
export function sandboxWrap(root: string, home: string, platform = process.platform): { command: string; args: string[] } | null {
  if (platform !== 'darwin' || !existsSync(SANDBOX_EXEC)) return null;
  return { command: SANDBOX_EXEC, args: ['-p', macosProfile(root, home)] };
}
