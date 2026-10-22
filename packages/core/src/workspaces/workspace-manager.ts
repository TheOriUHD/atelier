/**
 * Trusted folders and their runners (ARCHITECTURE §6). A workspace's runner starts on first use, stays
 * warm while sessions use it, and shuts down after a quiet period. Folders on this backend's machine
 * spawn the runner directly; on a server, folders live on the person's desktop device and the runner
 * is reached over its device link (§21). Sessions started with no folder get a scratch folder of their own.
 */
import { nativePath } from '../paths.ts';
import { randomBytes } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix } from 'node:path';
import { and, desc, eq, inArray, isNull, notExists } from 'drizzle-orm';
import type { WorkspaceSummary } from '@atelier/protocol';
import type { Db } from '../store/db.ts';
import { sessions, workspaces } from '../store/schema.ts';
import { newId } from '../util/ids.ts';
import type { DeviceLinks } from './device-links.ts';
import { RunnerClient } from './runner-client.ts';
import { SANDBOX_HOST, sandboxHint, sandboxWrap } from './sandbox.ts';
import { SandboxAccountError, sandboxChats } from './sandbox-accounts.ts';
import { bootstrapRunner, remoteRunnerChannel, SshError, sshShell, type RemoteShell } from './ssh.ts';
import type { Workspace } from './workspace.ts';

const IDLE_MS = 15 * 60_000;
/**
 * Where `remoteRunners` keeps an SSH host's or codespace's runner. In the server's sandbox every account logs in as its own
 * Unix user, in a home of its own, so each has a runner (and a place to find it) of its own.
 */
const remoteKey = (target: { kind: string; host: string | null; userId: string }) =>
  target.host === SANDBOX_HOST ? `${target.kind}:${target.host}:${target.userId}` : `${target.kind}:${target.host}`;

type WorkspaceRow = typeof workspaces.$inferSelect;
type Target = Pick<WorkspaceRow, 'userId' | 'kind' | 'root' | 'deviceId' | 'host'>;

/** `scratch-<YYYY-MM-DD>-<6 hex>`, dated in this machine's time zone. */
export function scratchName(now: Date, suffix = randomBytes(3).toString('hex')): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `scratch-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${suffix}`;
}

interface Live {
  workspace: Workspace;
  client: RunnerClient;
  shells: Map<string, Promise<string>>;
  idle?: ReturnType<typeof setTimeout>;
  /** Shutting down: the workspace's next use starts a new runner. */
  released?: boolean;
}

export class WorkspaceError extends Error {}

export interface WorkspaceManagerDeps {
  db: Db;
  /** The runner build for this machine; absent where this backend must not run commands (the web server). */
  runnerBinary: string | null;
  /** Desktop devices lending their runner; folders on them are workspaces where `runnerBinary` is null. */
  links?: DeviceLinks;
  /** All runner builds and their checksums, for uploading to SSH hosts (desktop). */
  runnerDir?: string | null;
  /** Where this machine's scratch folders go (`<data dir>/scratch-workspaces`), a folder per person inside. */
  scratchDir?: string | null;
  /** Where chats' sandboxes go on this machine (`<data dir>/chat-sandboxes`), when chats run them here. */
  chatSandboxDir?: string | null;
  /**
   * How to reach the server's sandbox container (SSH with the server's own key); chats' sandboxes live there. The login is
   * the account's own Unix user there, so what its commands can reach is what the operating system lets that user.
   */
  sandboxShell?(userId: string): Promise<RemoteShell>;
  /** The `ssh` program (tests substitute their own). */
  ssh?: string;
  /** How to reach a person's codespace (`gh codespace ssh` with their GitHub token). */
  codespaceShell?(userId: string, name: string): Promise<RemoteShell>;
  /**
   * Starts a codespace that went to sleep and resolves once it runs; called before a runner connects to one.
   * `waking` is called when it turns out not to be running, so sessions in its folder can say what they wait for.
   */
  codespaceWake?(userId: string, name: string, waking: () => void): Promise<void>;
  /** How to reach an SSH host (its connection's port, key, saved password, and the person's answers); plain `ssh` without. */
  sshShell?(userId: string, host: string): Promise<RemoteShell>;
  /** A codespace's folder is waiting for it to wake (true) or it came up, or failed to (false). */
  codespaceWaking?(workspaceId: string, waking: boolean): void;
  logger: { info(message: string): void; error(message: string, error?: unknown): void };
}

export class WorkspaceManager {
  private live = new Map<string, Promise<Live>>();
  /** A runner rooted at `/` per SSH host the folder browser is using, shut down when it has been idle a while. */
  private browsers = new Map<string, { client: Promise<RunnerClient>; timer: ReturnType<typeof setTimeout> }>();

  /** Where each SSH host or codespace keeps this app's runner, found (or uploaded) once per machine. */
  private remoteRunners = new Map<string, Promise<{ runner: string; home: string }>>();

  constructor(private readonly deps: WorkspaceManagerDeps) {}

  /** Whether folders on this backend's own machine can be used. */
  get hostsLocal(): boolean {
    return this.deps.runnerBinary !== null;
  }

  async list(userId: string): Promise<WorkspaceSummary[]> {
    const rows = await this.deps.db.select().from(workspaces).where(eq(workspaces.userId, userId)).orderBy(desc(workspaces.lastUsedAt)).all();
    return rows.map((r) => this.summary(r));
  }

  /**
   * Trusts a folder; inside a git repository the repository's top level becomes the root. The folder is on
   * this backend's machine, or (on a server) on `deviceId`, the desktop the request came from.
   */
  async addLocal(userId: string, path: string, deviceId: string | null = null): Promise<WorkspaceSummary> {
    const device = this.deps.runnerBinary ? null : deviceId;
    if (!this.deps.runnerBinary && !(device && this.deps.links?.online(userId, device))) {
      throw new WorkspaceError('This server does not run commands on its own machine. Open the desktop app to add a folder on your computer.');
    }
    const root = await this.topLevel({ userId, kind: 'local', root: path, deviceId: device, host: null });
    const sameMachine = device ? eq(workspaces.deviceId, device) : isNull(workspaces.deviceId);
    const existing = await this.deps.db.select().from(workspaces).where(and(eq(workspaces.userId, userId), eq(workspaces.root, root), sameMachine, isNull(workspaces.host))).get();
    // Opening a scratch folder on purpose makes it one of the person's folders.
    if (existing?.scratch) await this.deps.db.update(workspaces).set({ scratch: false }).where(eq(workspaces.id, existing.id));
    if (existing) return this.summary({ ...existing, scratch: false });
    return this.insert({ userId, kind: 'local', root, deviceId: device, host: null });
  }

  /**
   * The subfolders of `path` on an SSH host (its home folder by default), for the remote folder browser. Hidden folders
   * are left out. The listing is read through a runner rooted at `/`, kept for a minute while the dialog is used.
   */
  async browseRemote(userId: string, host: string, path?: string): Promise<{ path: string; home: string; dirs: string[] }> {
    const target = this.sshTarget(userId, host);
    const { home } = await this.remoteRunner(target);
    const wanted = (path?.trim() || home).replace(/^~(?=\/|$)/, home);
    const dir = posix.normalize(posix.isAbsolute(wanted) ? wanted : posix.join(home, wanted)).replace(/(.)\/+$/, '$1');
    const client = await this.browser(userId, host);
    try {
      const { entries } = await client.call('fs.list', { path: dir, depth: 1, respectGitignore: false });
      const dirs = entries.filter((e) => e.type === 'dir' && !e.name.startsWith('.')).map((e) => e.name).sort((a, b) => a.localeCompare(b));
      return { path: dir, home, dirs };
    } catch (e) {
      throw new WorkspaceError(`Can't open ${dir} on ${host}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Makes the folder `name` inside `parent` on an SSH host (one level; the name can't hold a slash). */
  async createRemoteFolder(userId: string, host: string, parent: string, name: string): Promise<string> {
    const clean = name.trim();
    if (!clean || clean === '.' || clean === '..' || /[\\/\0]/.test(clean)) throw new WorkspaceError('Use a folder name without slashes.');
    const target = this.sshTarget(userId, host);
    const { home } = await this.remoteRunner(target);
    const base = posix.normalize(parent.replace(/^~(?=\/|$)/, home));
    if (!posix.isAbsolute(base)) throw new WorkspaceError('The folder to create it in must be an absolute path.');
    const path = posix.join(base, clean);
    const client = await this.browser(userId, host);
    try {
      await client.call('fs.mkdir', { path, recursive: false });
    } catch (e) {
      throw new WorkspaceError(`Can't create ${path} on ${host}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return path;
  }

  private browser(userId: string, host: string): Promise<RunnerClient> {
    const key = `${userId}\0${host}`;
    let entry = this.browsers.get(key);
    if (entry) clearTimeout(entry.timer);
    else {
      const client = this.connect({ ...this.sshTarget(userId, host), root: '/' });
      entry = { client, timer: undefined as never };
      client.catch(() => this.browsers.delete(key));
    }
    entry.timer = setTimeout(() => {
      this.browsers.delete(key);
      void entry!.client.then((c) => c.shutdown()).catch(() => undefined);
    }, 60_000);
    entry.timer.unref?.();
    this.browsers.set(key, entry);
    return entry.client;
  }

  /**
   * The folder a session moves to from its workspace: a path on the same computer or SSH host. `~/` starts in the home
   * folder and a relative path in the folder it leaves. The folder must exist; like opening it, this trusts it.
   */
  async openFrom(userId: string, workspaceId: string, path: string): Promise<WorkspaceSummary> {
    const row = await this.deps.db.select().from(workspaces).where(and(eq(workspaces.userId, userId), eq(workspaces.id, workspaceId))).get();
    if (!row) throw new WorkspaceError('This session has no folder to move from.');
    if (row.kind === 'codespace') throw new WorkspaceError('A codespace is one repository. Open another one from the folder menu (Cloud › Open a repository…).');
    if (row.deviceId) throw new WorkspaceError("This folder is on another computer; open folders there in that computer's desktop app.");
    if (row.host) {
      const { home } = await this.remoteRunner(this.sshTarget(userId, row.host));
      const full = path.replace(/^~(?=\/|$)/, home);
      return this.addSsh(userId, row.host, posix.isAbsolute(full) ? posix.normalize(full) : posix.join(row.root, full));
    }
    const full = path.replace(/^~(?=[\\/]|$)/, homedir());
    return this.addLocal(userId, isAbsolute(full) ? full : join(row.root, full));
  }

  /** Trusts a folder on an SSH host (desktop); `~/` paths start in the host's home folder. */
  async addSsh(userId: string, host: string, path: string): Promise<WorkspaceSummary> {
    const target = this.sshTarget(userId, host);
    const { home } = await this.remoteRunner(target);
    return this.addRemote({ ...target, root: path.replace(/^~(?=\/|$)/, home) });
  }

  /**
   * A new, empty folder for one session started with no folder: `scratch-workspaces/<user>/scratch-<date>-<hex>` in
   * this machine's data folder or, with `sshHost`, in the host's `~/.atelier`. Its runner is rooted at exactly that
   * folder (never at a repository around it). Deleting the session leaves it on disk.
   */
  async addScratch(userId: string, sshHost?: string): Promise<WorkspaceSummary> {
    const name = scratchName(new Date());
    if (sshHost) {
      const target = this.sshTarget(userId, sshHost);
      const atelier = `${(await this.remoteRunner(target)).home}/.atelier`;
      const root = `${atelier}/scratch-workspaces/${userId}/${name}`;
      // ~/.atelier exists once the runner is there; a runner rooted at it makes the folder, then stops.
      const probe = await this.connect({ ...target, root: atelier }).catch((e: unknown) => {
        throw new WorkspaceError(`Can't reach ${sshHost}: ${e instanceof Error ? e.message : String(e)}`);
      });
      try {
        await probe.call('fs.mkdir', { path: root, recursive: true });
      } finally {
        await probe.shutdown();
      }
      return this.insert({ ...target, root, scratch: true });
    }
    if (!this.deps.runnerBinary || !this.deps.scratchDir) throw new WorkspaceError('Sessions without a folder need the desktop app running on this computer.');
    const parent = join(this.deps.scratchDir, userId);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const dir = join(parent, name);
    await mkdir(dir, { mode: 0o700 });
    return this.insert({ userId, kind: 'local', root: await realpath(dir), deviceId: null, host: null, scratch: true });
  }

  /** Whether chats get a sandbox here: the server's sandbox container, or this machine for the desktop's own backend. */
  get chatSandboxes(): boolean {
    return !!this.deps.sandboxShell || (!!this.deps.runnerBinary && !!this.deps.chatSandboxDir);
  }

  /**
   * A chat's sandbox: a new, empty folder in the server's sandbox container (`chats/<user>/<name>`, in a folder only the
   * account's own Unix user there can enter) or in this machine's data folder (`chat-sandboxes/<user>/<name>`). Kept
   * when the chat goes.
   */
  async addChatSandbox(userId: string): Promise<WorkspaceSummary> {
    const name = scratchName(new Date()).replace(/^scratch-/, 'chat-');
    if (this.deps.sandboxShell) {
      if (!this.deps.runnerDir) throw new WorkspaceError('This server has no runner builds for its sandbox.');
      const target = { userId, kind: 'ssh' as const, deviceId: null, host: SANDBOX_HOST };
      const found = await this.remoteRunner(target).catch((e: unknown) => {
        const said = e instanceof Error ? e.message : String(e);
        throw new WorkspaceError(e instanceof SandboxAccountError ? said : `The sandbox can't be reached: ${said}`);
      });
      const chats = sandboxChats(userId, found.home);
      const root = `${chats.dir}/${name}`;
      const probe = await this.connect({ ...target, root: chats.from }).catch((e: unknown) => {
        // With account users the sandbox makes the account's folder from what the server told it through the keys volume.
        const hint = chats.from === chats.dir ? ' (The sandbox makes each account’s folder from what the server tells it through the sandbox-keys volume: both containers must mount it. See docker compose logs sandbox.)' : '';
        throw new WorkspaceError(`The sandbox can't be reached: ${e instanceof Error ? e.message : String(e)}${hint}`);
      });
      try {
        await probe.call('fs.mkdir', { path: root, recursive: true });
      } finally {
        await probe.shutdown();
      }
      return this.insert({ ...target, root, scratch: true, sandbox: true });
    }
    if (!this.deps.runnerBinary || !this.deps.chatSandboxDir) throw new WorkspaceError('Chats here have no sandbox.');
    const parent = join(this.deps.chatSandboxDir, userId);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const dir = join(parent, name);
    await mkdir(dir, { mode: 0o700 });
    return this.insert({ userId, kind: 'local', root: await realpath(dir), deviceId: null, host: null, scratch: true, sandbox: true });
  }

  private sshTarget(userId: string, host: string) {
    if (!this.deps.runnerBinary || !this.deps.runnerDir) throw new WorkspaceError('SSH workspaces need the desktop app.');
    if (!/^[\w.@:-]+$/.test(host) || host.startsWith('-')) throw new WorkspaceError('Use a host from ~/.ssh/config or user@host.');
    return { userId, kind: 'ssh' as const, deviceId: null, host };
  }

  /**
   * A codespace's checkout as a workspace; its runner is uploaded on first use. It is trusted only when `trust` says the
   * person answered "Trust this workspace?" (for this codespace: another one of the same repository asks again); until then
   * the checkout's own settings, hooks and instruction files are ignored (see `isTrusted`).
   */
  async addCodespace(userId: string, name: string, root: string, trust = false): Promise<WorkspaceSummary> {
    if (!this.deps.runnerDir || !this.deps.codespaceShell) throw new WorkspaceError('This app has no runner builds to put into a codespace.');
    return this.addRemote({ userId, kind: 'codespace', deviceId: null, host: name, root }, trust);
  }

  private async addRemote(target: Target, trusted = true): Promise<WorkspaceSummary> {
    const root = await this.topLevel(target);
    const existing = await this.deps.db.select().from(workspaces).where(and(eq(workspaces.userId, target.userId), eq(workspaces.host, target.host!), eq(workspaces.root, root))).get();
    if (existing) return trusted && !existing.trusted ? this.markTrusted(existing) : this.summary(existing);
    return this.insert({ ...target, root, trusted });
  }

  /** The person answered "Trust this workspace?" with yes: its own settings, hooks and instruction files apply from now on. */
  async trust(userId: string, id: string): Promise<WorkspaceSummary> {
    const row = await this.deps.db.select().from(workspaces).where(and(eq(workspaces.userId, userId), eq(workspaces.id, id))).get();
    if (!row) throw new WorkspaceError('This workspace no longer exists.');
    return row.trusted ? this.summary(row) : this.markTrusted(row);
  }

  private async markTrusted(row: WorkspaceRow): Promise<WorkspaceSummary> {
    await this.deps.db.update(workspaces).set({ trusted: true }).where(eq(workspaces.id, row.id));
    // A runner already up serves the next call as a trusted workspace.
    const live = await this.live.get(row.id)?.catch(() => null);
    if (live) live.workspace.trusted = true;
    return this.summary({ ...row, trusted: true });
  }

  async remove(userId: string, id: string): Promise<void> {
    const removed = await this.deps.db.delete(workspaces).where(and(eq(workspaces.userId, userId), eq(workspaces.id, id))).returning();
    if (removed.length) await this.releaseCurrent(id);
  }

  /**
   * Forgets those of these scratch folders that no session uses any more (their last session was deleted). The
   * folders stay on disk. Returns whether any went.
   */
  async forgetScratch(userId: string, ids: readonly (string | null)[]): Promise<boolean> {
    const wanted = [...new Set(ids.filter((id) => id !== null))];
    if (!wanted.length) return false;
    const { db } = this.deps;
    const unused = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.userId, userId), eq(workspaces.scratch, true), inArray(workspaces.id, wanted), notExists(db.select({ id: sessions.id }).from(sessions).where(eq(sessions.workspaceId, workspaces.id)))))
      .all();
    for (const { id } of unused) await this.remove(userId, id);
    return unused.length > 0;
  }

  /** The running workspace for a session's tools. Throws when it isn't the user's or can't be reached. */
  async open(userId: string, id: string): Promise<Workspace> {
    const row = await this.deps.db.select().from(workspaces).where(and(eq(workspaces.userId, userId), eq(workspaces.id, id))).get();
    if (!row) throw new WorkspaceError('This workspace no longer exists.');
    if (!this.reachable(row)) throw new WorkspaceError(`${row.name} is on a device that isn't connected.`);
    await this.deps.db.update(workspaces).set({ lastUsedAt: Date.now() }).where(eq(workspaces.id, id));
    const live = await this.running(row);
    // Trust can change while the runner stays up (the person answers the question later): every open sees the row's.
    live.workspace.trusted = row.trusted;
    this.touch(live);
    return live.workspace;
  }

  async disposeAll(): Promise<void> {
    for (const { client, timer } of this.browsers.values()) {
      clearTimeout(timer);
      void client.then((c) => c.shutdown()).catch(() => undefined);
    }
    this.browsers.clear();
    await Promise.all([...this.live.keys()].map((id) => this.releaseCurrent(id)));
  }

  /**
   * The workspace's runner. Callers arriving together share one start (and its failure); a runner that
   * exited or is shutting down is replaced once, by whichever caller notices first.
   */
  private async running(row: WorkspaceRow): Promise<Live> {
    const pending = this.live.get(row.id);
    const current = pending && (await pending);
    if (current?.client.alive && !current.released) return current;
    if (this.live.get(row.id) === pending) this.live.delete(row.id);
    let next = this.live.get(row.id);
    if (!next) {
      const started = (next = this.start(row));
      this.live.set(row.id, started);
      // A runner forgets only its own entry: by the time it fails or exits, a newer one may have replaced it.
      const forget = () => void (this.live.get(row.id) === started && this.live.delete(row.id));
      void started.then((live) => live.client.exited.then(forget), forget);
    }
    return next;
  }

  private async start(row: WorkspaceRow): Promise<Live> {
    const client = await this.connect(row);
    const shells = new Map<string, Promise<string>>();
    const info = client.info;
    const workspace: Workspace = {
      id: row.id,
      kind: row.kind as Workspace['kind'],
      deviceId: row.deviceId,
      host: row.host,
      trusted: row.trusted,
      // The server's container holds nothing but sandboxes; here only the macOS sandbox keeps commands to the folder.
      ...(row.sandbox ? { sandbox: { confined: row.host === SANDBOX_HOST || (!row.host && sandboxWrap(row.root, homedir()) !== null) } } : {}),
      root: info.roots[0] ?? row.root,
      home: info.home,
      os: info.os,
      shell: info.shell,
      pathSep: info.pathSep,
      runner: client,
      shellFor: (sessionId) => {
        let shell = shells.get(sessionId);
        if (!shell) {
          shell = client.call('shell.open', { cwd: workspace.root }).then((r) => r.shellId);
          shells.set(sessionId, shell);
          shell.catch(() => shells.delete(sessionId));
        }
        return shell;
      },
    };
    return { workspace, client, shells };
  }

  /**
   * A runner rooted at `root`: spawned here, on the device over its link, or on the SSH host or codespace. Git never
   * looks above a scratch folder, in the runner and every command it starts: a repository around it (a home folder
   * kept in git) isn't the session's.
   */
  private async connect(target: Target & { scratch?: boolean; sandbox?: boolean }): Promise<RunnerClient> {
    const { userId, root, deviceId, host } = target;
    if (deviceId) return RunnerClient.connect(await this.deps.links!.open(userId, deviceId, root));
    const onLog = (line: string) => this.deps.logger.info(`runner ${basename(root)}: ${line}`);
    const env: Record<string, string> = target.scratch ? { GIT_CEILING_DIRECTORIES: (host ? posix.dirname : dirname)(root) } : {};
    if (!host) {
      const wrap = target.sandbox ? sandboxWrap(root, homedir()) : null;
      return RunnerClient.spawn({ binaryPath: this.deps.runnerBinary!, roots: [root], env: { ...process.env, ...env }, onLog, ...(wrap ? { wrap } : {}) });
    }
    // A codespace sleeps after its idle timeout: wake it, so coming back to a session just works.
    if (target.kind === 'codespace' && this.deps.codespaceWake) {
      const id = (target as { id?: string }).id;
      let woke = false;
      try {
        await this.deps.codespaceWake(userId, host, () => {
          woke = true;
          if (id) this.deps.codespaceWaking?.(id, true);
        });
      } finally {
        if (woke && id) this.deps.codespaceWaking?.(id, false);
      }
    }
    const found = this.remoteRunner(target);
    try {
      return await RunnerClient.connect(remoteRunnerChannel(await this.remoteShell(target), (await found).runner, [root], onLog, env));
    } catch (error) {
      // The runner may be gone from the host (cleaned up, or a codespace recreated with the same name): look again next time.
      if (this.remoteRunners.get(remoteKey(target)) === found) this.remoteRunners.delete(remoteKey(target));
      throw error;
    }
  }

  private remoteShell(target: Pick<WorkspaceRow, 'userId' | 'kind' | 'host'>): Promise<RemoteShell> {
    if (target.kind === 'codespace') return this.deps.codespaceShell!(target.userId, target.host!);
    if (target.host === SANDBOX_HOST && this.deps.sandboxShell) return this.deps.sandboxShell(target.userId);
    return this.deps.sshShell ? this.deps.sshShell(target.userId, target.host!) : Promise.resolve(sshShell(this.deps.ssh ?? 'ssh', target.host!));
  }

  private remoteRunner(target: Pick<WorkspaceRow, 'userId' | 'kind' | 'host'>): Promise<{ runner: string; home: string }> {
    const key = remoteKey(target);
    let found = this.remoteRunners.get(key);
    if (!found) {
      found = this.remoteShell(target).then((shell) => bootstrapRunner(shell, this.deps.runnerDir!));
      // A sandbox that doesn't know the account's user is usually one that wasn't updated with the server.
      if (target.host === SANDBOX_HOST) found = found.catch((e: unknown) => Promise.reject(e instanceof SshError && !(e instanceof SandboxAccountError) ? new SshError(sandboxHint(e.message), { cause: e }) : e));
      this.remoteRunners.set(key, found);
      // A failed attempt (host down, key not loaded, codespace stopped) is tried again next time.
      found.catch(() => this.remoteRunners.delete(key));
    }
    return found;
  }

  /** The folder's git top level (or the folder) as its runner sees it. */
  private async topLevel(target: Target): Promise<string> {
    const probe = await this.connect(target).catch((e: unknown) => {
      throw new WorkspaceError(`Can't open ${target.root}: ${e instanceof Error ? e.message : String(e)}`);
    });
    let root = probe.info.roots[0] ?? target.root;
    try {
      const git = await probe.call('proc.exec', { argv: ['git', 'rev-parse', '--show-toplevel'], cwd: root, timeoutMs: 5000 });
      if (git.exitCode === 0 && git.stdout.trim()) root = git.stdout.trim();
    } catch {
      // Not a git repository, or git is missing: the chosen folder is the root.
    } finally {
      await probe.shutdown();
    }
    // Git writes `C:/Users/me/app`; a folder of this computer is kept the way it is written here, one way for every route.
    return target.host || target.deviceId ? root : nativePath(root);
  }

  private async insert(fields: Target & { scratch?: boolean; sandbox?: boolean; trusted?: boolean }): Promise<WorkspaceSummary> {
    const now = Date.now();
    const row: WorkspaceRow = { id: newId(), name: basename(fields.root) || fields.root, scratch: false, sandbox: false, trusted: true, createdAt: now, lastUsedAt: now, ...fields };
    await this.deps.db.insert(workspaces).values(row);
    return this.summary(row);
  }

  private reachable(r: WorkspaceRow): boolean {
    if (r.deviceId) return !!this.deps.links?.online(r.userId, r.deviceId);
    if (r.kind === 'codespace') return !!this.deps.codespaceShell;
    if (r.host === SANDBOX_HOST && r.sandbox) return !!this.deps.sandboxShell;
    return r.host ? !!this.deps.runnerBinary : this.hostsLocal;
  }

  private touch(live: Live): void {
    clearTimeout(live.idle);
    live.idle = setTimeout(() => void this.release(live), IDLE_MS);
    live.idle.unref?.();
  }

  /** Shuts this runner down; whoever uses the workspace next gets a new one. */
  private async release(live: Live): Promise<void> {
    live.released = true;
    clearTimeout(live.idle);
    await live.client.shutdown().catch((e: unknown) => this.deps.logger.error('runner shutdown failed', e));
  }

  private async releaseCurrent(id: string): Promise<void> {
    const live = await this.live.get(id)?.catch(() => null);
    if (live) await this.release(live);
  }

  private summary(r: WorkspaceRow): WorkspaceSummary {
    return { id: r.id, kind: r.kind, name: r.name, root: r.root, deviceId: r.deviceId, host: r.host, available: this.reachable(r), scratch: r.scratch, trusted: r.trusted, lastUsedAt: r.lastUsedAt };
  }
}
