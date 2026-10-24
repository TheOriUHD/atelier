/**
 * The whole app backend, shared by the Electron utility process and the web server. `platform`
 * injects the only surface-specific pieces; everything else is identical on desktop and web.
 */
import { homedir } from 'node:os';
import { z } from 'zod';
import { dirname, join, posix } from 'node:path';
import {
  ADMIN_PROCEDURES,
  APP,
  DEVICE_LINK_PROTOCOL,
  SshProbe,
  type DeviceService,
  appError,
  chatGptPlanLabel,
  contract,
  effectiveSafeguards,
  LOCKED_PROCEDURES,
  PROVIDER_LABELS,
  PUBLIC_PROCEDURES,
  parseModelRef,
  serveRpc,
  sessionEffort,
  type AppContract,
  type Handlers,
  type McpServerStatus,
  type ModelInfo,
  type Usage,
  type PermissionMode,
  type RpcServerConnection,
  type SafeguardCategories,
  type SessionSummary,
  type Settings,
  type SettingsSnapshot,
  type SshAnswer,
  type SshConnectionView,
  type Transport,
  type UserSummary,
} from '@atelier/protocol';
import { AccountError, AccountService, type Authenticated, type ClientInfo } from '../accounts/account-service.ts';
import { DeviceRepo, toDeviceSummary } from '../accounts/device-repo.ts';
import { Passkeys } from '../accounts/passkeys.ts';
import { PrefsRepo, PrefsValidationError } from '../accounts/prefs-repo.ts';
import { ScreenLock, ScreenLockError } from '../accounts/screen-lock.ts';
import { importClaudeCode } from '../mcp/import.ts';
import { McpManager } from '../mcp/manager.ts';
import { connectorContext } from '../permissions/engine.ts';
import { hostRunnerBinary } from '../workspaces/runner-client.ts';
import { codeContext } from '../workspaces/code-context.ts';
import { claudeUserSettings, projectHooks, projectRules, rememberProjectRule, type ProjectSettings } from '../workspaces/project-rules.ts';
import { isTrusted, onThisMachine, type Workspace } from '../workspaces/workspace.ts';
import { WorkspaceError, WorkspaceManager } from '../workspaces/workspace-manager.ts';
import { TerminalManager } from '../workspaces/terminals.ts';
import { sandboxShell } from '../workspaces/sandbox.ts';
import { SshError, sshConfigHosts } from '../workspaces/ssh.ts';
import { SshAccess, sshSecretId } from '../workspaces/ssh-access.ts';
import * as git from '../workspaces/git.ts';
import { DeviceLinkError, DeviceLinks, type LinkSocket } from '../workspaces/device-links.ts';
import { findFiles, gitDiff, gitStatus, grepFiles, listDir, readFile as readWorkspaceFile, sessionDiff } from '../workspaces/workspace-view.ts';
import { FileBytesError, fileBytes } from '../workspaces/file-bytes.ts';
import { ChatService, type ExtensionCatalog } from '../agent/chat-service.ts';
import { LoopLimitError } from '../agent/loops.ts';
import { sessionUsage, statsSummary, usageSummary } from '../usage/usage.ts';
import { GitHub, GitHubError } from '../cloud/github.ts';
import { Codespaces } from '../cloud/codespaces.ts';
import { collectUnusedBlobs, conversationIds, deleteConversations, exportAll } from '../privacy/privacy.ts';
import { Checkpoints } from '../checkpoints/checkpoints.ts';
import { ArtifactRepo } from '../artifacts/artifact-repo.ts';
import { FileRepo } from '../files/file-repo.ts';
import { canExtractText } from '../files/text-extract.ts';
import { NodeWorkspaceFs } from '../fs/workspace-fs.ts';
import { hostReader, instructionGlobals } from '../instructions/instructions.ts';
import { discoverSkills, type ExtensionSource } from '../extensions/skills.ts';
import { discoverCommands } from '../extensions/commands.ts';
import { discoverAgents } from '../extensions/agents.ts';
import { claudeCodePlugins, pluginHooks, pluginSources } from '../extensions/plugins.ts';
import { installedSkills, installSkills, uninstallSkill, type InstallTarget } from '../extensions/skill-install.ts';
import { InstallError } from '../extensions/github.ts';
import { atelierPlugins, browseMarketplace, installPlugin, uninstallPlugin, type PluginTarget } from '../extensions/marketplaces.ts';
import { hostFs, projectRoots, watchHost, workspaceFs } from '../extensions/sources.ts';
import { RequestInspector } from '../developer/inspector.ts';
import { plainHttpFetch } from '../providers/plain-http.ts';
import { loadTemplateOverrides } from '../prompts/templates.ts';
import { ProjectRepo } from '../projects/project-repo.ts';
import { createAdapter } from '../providers/index.ts';
import { ProviderRegistry } from '../providers/registry.ts';
import type { ProviderFetch } from '../providers/types.ts';
import { isPersonalSecret, SecretStore, type Cipher } from '../secrets/secret-store.ts';
import { createExcerptReader } from '../search/excerpt.ts';
import { resolveSearchConfig, SearchService } from '../search/service.ts';
import { ChatGptAuth } from '../providers/chatgpt-auth.ts';
import { CopilotAuth } from '../providers/copilot-auth.ts';
import { OpenRouterConnect } from '../providers/openrouter-auth.ts';
import { costOf, listPrice } from '../providers/prices.ts';
import { GroupRepo } from '../sessions/group-repo.ts';
import { SessionRepo, connectorsOff } from '../sessions/session-repo.ts';
import { TEMPORARY_MAX_IDLE_MS } from '../sessions/temporary.ts';
import { SettingsService, SettingsValidationError } from '../settings/settings-service.ts';
import { BlobStore } from '../store/blobs.ts';
import { MemoryEditingOffError, MemoryInvalidError, MemoryNotFoundError, MemoryService, ModelChoiceError } from '../memory/memory-service.ts';
import { openDatabase } from '../store/db.ts';
import { ServerUpdateError, serverUpdatesFromEnv, type ServerUpdates } from '../server-updates/server-updates.ts';
import { usageEvents, users } from '../store/schema.ts';
import { newId } from '../util/ids.ts';
import { getAt, leafPaths } from '../util/json-path.ts';
import { interpolate, secretRefs } from '../util/interpolate.ts';

export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  error(message: string, error?: unknown): void;
}

export interface Platform {
  surface: 'desktop' | 'web';
  /** Global config dir: `~/.atelier` on desktop, `/data` on the server. */
  configDir: string;
  /** Database and blob storage. */
  dataDir: string;
  cipher: Cipher;
  env: Record<string, string | undefined>;
  logger: Logger;
  /** Network access for provider adapters; wrapped for the request inspector. */
  fetch?: ProviderFetch;
  chatgptChat?: import('../providers/chatgpt-chat.ts').ChatGptChatPort;
  /**
   * Network access that looks like a browser's, for search engines' result pages: the desktop passes Chromium's own
   * stack (Node's `fetch` is treated as a bot by some engines). Plain `fetch` when absent.
   */
  webFetch?: ProviderFetch;
  /** Required to create the first account (servers print it to their log); absent when the owner is local. */
  setupToken?: string;
  /** Directory with the runner builds, when this backend may run commands on its own machine (desktop). */
  runnerDir?: string;
  /** The server's own version and updates (Settings › Admin › Server); built from `env` on the web surface when absent. */
  serverUpdates?: ServerUpdates | null;
}

/** Who is on the other end of a transport, as far as the surface can tell before any RPC. */
export interface ConnectOptions {
  /** Bearer token from a cookie, header or the desktop's secure storage. */
  token?: string;
  client: ClientInfo;
  /** Web: the origin the client reached this server at, where connectors' OAuth sign-ins come back to. */
  origin?: string;
}

export interface Backend {
  connect(transport: Transport, options: ConnectOptions): () => void;
  /** Resolves a bearer token for HTTP routes (blob downloads); null when it isn't a valid sign-in. */
  authenticate(token: string): Promise<Authenticated | null>;
  accounts: AccountService;
  /** Passkey sign-in and registration ceremonies, for the web server's routes. */
  passkeys: Passkeys;
  /**
   * A desktop device lending its runner over the device link (ARCHITECTURE §21). Null when the token isn't a
   * usable sign-in; otherwise where the socket's text frames and its close go.
   */
  linkDevice(socket: LinkSocket, token: string, device: { id: string; name: string; platform: string }): Promise<{ receive(text: string): void; closed(): void } | null>;
  /** Ends a sign-in and signs out every connection using it (HTTP logout on the web). */
  logout(sessionId: string): Promise<void>;
  /** "Run on this computer": turns the screen lock off after the desktop verified the person's OS account. */
  removeScreenLock(): Promise<void>;
  /**
   * The web server's `/oauth/callback`: finishes a connector's OAuth sign-in, or connecting OpenRouter. `userId` is
   * whose sign-in the request's cookie carries, if any. Returns why it failed, or null.
   */
  finishSignIn(params: URLSearchParams, userId: string | null): Promise<string | null>;
  readBlob(sha256: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string } | undefined>;
  dispose(): Promise<void>;
}

interface Connection {
  rpc: RpcServerConnection<AppContract>;
  subscriptions: Set<string>;
  client: ClientInfo;
  /** Resolves once the connect-time token has been checked. */
  ready: Promise<void>;
  auth: Authenticated | null;
  /** Set when a desktop app registered the device this connection comes from. */
  deviceId: string | null;
  origin: string | undefined;
}

/** What a server takes from its people's desktop devices (ARCHITECTURE §21, device services). */
const SERVER_DEVICE_SERVICES: readonly DeviceService[] = ['runner', 'scratch', 'ssh'];

export async function createBackend(platform: Platform): Promise<Backend> {
  const db = openDatabase(join(platform.dataDir, 'atelier.db'));
  const blobs = new BlobStore(db, join(platform.dataDir, 'blobs'));
  const fs = new NodeWorkspaceFs();
  const settings = new SettingsService(fs, platform.configDir);
  await settings.load();
  settings.watch();
  const secrets = new SecretStore(db, platform.cipher);
  const httpFetch = platform.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const sessions = new SessionRepo(db);
  const groups = new GroupRepo(db);
  const artifacts = new ArtifactRepo(db);
  const files = new FileRepo(db, blobs);
  const projects = new ProjectRepo(db);
  let promptOverrides = await loadTemplateOverrides(fs, join(platform.configDir, 'prompts'));

  const accounts = new AccountService(db, () => settings.effective.server.signup);
  // The desktop app's own backend has one person and is reachable only through the app's MessagePorts, not a socket.
  const local = platform.surface === 'desktop' && !platform.setupToken;
  const screenLock = new ScreenLock(join(platform.dataDir, 'screen-lock.json'));
  if (local) await screenLock.load();
  // A device coming or going changes which of its user's workspaces are available, and what its windows offer.
  const links = new DeviceLinks((userId) => {
    emitToUser(userId, 'devices.changed', {});
    void workspaceManager
      .list(userId)
      .then((list) => emitToUser(userId, 'workspaces.changed', list))
      .catch((e: unknown) => platform.logger.error('workspace update broadcast failed', e));
  });
  const github = new GitHub({ fetch: httpFetch, secrets, clientId: () => settings.effective.cloud.github.clientId ?? null });
  const codespaces = new Codespaces({ fetch: httpFetch, github, ...(platform.env.ATELIER_GH ? { gh: platform.env.ATELIER_GH } : {}) });
  const sandboxReach = sandboxShell(platform.env, platform.dataDir);
  const workspaceManager = new WorkspaceManager({
    db,
    // Only the desktop runs folders on its own machine (and reaches SSH hosts); a server's runner builds go to codespaces.
    runnerBinary: platform.surface === 'desktop' && platform.runnerDir ? hostRunnerBinary(platform.runnerDir) : null,
    runnerDir: platform.runnerDir ?? null,
    scratchDir: join(platform.dataDir, 'scratch-workspaces'),
    // Chats' sandboxes: in the server's sandbox container, or on this computer for the desktop's own backend.
    ...(platform.surface === 'web' ? (sandboxReach ? { sandboxShell: sandboxReach } : {}) : { chatSandboxDir: join(platform.dataDir, 'chat-sandboxes') }),
    sshShell: (userId, host) => sshAccess.shell(userId, host),
    deviceSsh: (userId, deviceId, host) => sshAccess.onDevice(userId, deviceId, host),
    codespaceShell: (userId, name) => codespaces.shell(userId, name),
    codespaceWake: async (userId, name, waking) => void (await codespaces.wake(userId, name, waking)),
    codespaceWaking: (workspaceId, waking) => void chat.workspaceWaking(workspaceId, waking),
    links,
    logger: platform.logger,
  });
  const terminals = new TerminalManager<Connection>({
    data: (owner, terminalId, data) => owner.rpc.emit('terminals.data', { terminalId, data }),
    exit: (owner, terminalId, code) => owner.rpc.emit('terminals.exit', { terminalId, code }),
  });
  const prefs = new PrefsRepo(db);
  // Questions an SSH connection puts to the person (a new host's key, a password): shown in their windows, answered by id.
  const sshWaiting = new Map<string, { userId: string; resolve(answer: SshAnswer): void; reject(error: Error): void }>();
  const sandboxesMaking = new Map<string, Promise<Workspace>>();
  // On a server, SSH hosts are reached from the person's desktop: its ssh probes there, the questions are asked here.
  const throughDevice = <T>(asked: Promise<unknown>, parse: (value: unknown) => T): Promise<T> =>
    asked.then(parse, (e: unknown) => Promise.reject(e instanceof DeviceLinkError ? new SshError(e.message) : e));
  const sshAccess = new SshAccess({
    ssh: platform.env.ATELIER_SSH ?? 'ssh',
    dir: join(platform.dataDir, 'ssh'),
    device: {
      probe: (userId, deviceId, connection, answers) => throughDevice(links.request(userId, deviceId, { op: 'ssh.probe', connection, answers }, 60_000), (v) => SshProbe.parse(v)),
      test: (userId, deviceId, connection, answers) => throughDevice(links.request(userId, deviceId, { op: 'ssh.test', connection, answers }, 60_000), (v) => z.string().parse(v)),
    },
    connections: async (userId) => (await prefs.get(userId)).ssh.connections,
    secrets: { get: (id) => secrets.get(id), set: (secret) => secrets.set(secret), delete: (id) => secrets.delete(id) },
    prompt: (userId, prompt) =>
      new Promise<SshAnswer>((resolve, reject) => {
        const timer = setTimeout(() => {
          sshWaiting.delete(prompt.id);
          emitToUser(userId, 'ssh.promptClosed', { id: prompt.id });
          reject(new Error('Nobody answered the connection prompt in time.'));
        }, 5 * 60_000);
        sshWaiting.set(prompt.id, {
          userId,
          resolve: (answer) => (clearTimeout(timer), resolve(answer)),
          reject: (error) => (clearTimeout(timer), reject(error)),
        });
        emitToUser(userId, 'ssh.prompt', prompt);
      }),
  });
  const devices = new DeviceRepo(db);
  const passkeys = new Passkeys(db, accounts);

  const connections = new Set<Connection>();
  type Events = AppContract['events'];
  type EventPayload = Parameters<RpcServerConnection<AppContract>['emit']>[1] & object;
  const isAdmin = (c: Connection) => c.auth?.user.role === 'admin';
  const emitWhere = <E extends keyof Events & string>(pick: (c: Connection) => boolean, event: E, payload: EventPayload) => {
    for (const c of connections) if (c.auth && pick(c)) {
      if (event === 'sessions.changed') {
        const summary = payload as SessionSummary;
        void sessions.getRow(summary.id).then(async (row) => {
          if (row && await canAccessSession(row, c)) c.rpc.emit(event, payload as never);
          else c.rpc.emit('sessions.removed', { id: summary.id });
        }).catch((error: unknown) => platform.logger.error('session access check failed', error));
      } else c.rpc.emit(event, payload as never);
    }
  };
  /** Events about one user's data go to that user's connections only. */
  const emitToUser = <E extends keyof Events & string>(userId: string | null, event: E, payload: EventPayload) => emitWhere((c) => c.auth?.user.id === userId, event, payload);

  /**
   * Regular users see which providers exist and the model defaults, never URLs, headers or key references. Of the
   * safeguards they see only what applies to them: on with what it covers, or off with nothing. The switch for
   * everyone, the categories while they don't apply and the helpline text are the admin's.
   */
  const publicSettings = (snapshot: SettingsSnapshot, user: UserSummary): SettingsSnapshot => {
    const effective = snapshot.effective as Settings;
    const own = effectiveSafeguards(effective.safeguards, user.safeguards);
    const categories = Object.fromEntries(Object.keys(effective.safeguards.categories).map((c) => [c, !!own?.categories.includes(c as keyof SafeguardCategories)]));
    return {
      effective: {
        ...effective,
        providers: effective.providers.map((p) => ({ id: p.id, type: p.type, name: p.name, enabled: p.enabled })),
        pricing: {},
        mcpServers: {},
        // The commands the system runs, where web searches go with which key, and what the administrator tells the
        // models, are the admin's business (the system AGENTS.md is admin-only too).
        hooks: {},
        prompts: { organizationInstructions: '' },
        capabilities: { ...effective.capabilities, webSearch: { enabled: effective.capabilities.webSearch.enabled, provider: effective.capabilities.webSearch.provider } },
        safeguards: { enabled: !!own, categories: categories as SafeguardCategories, profile: own?.younger ? 'younger' : 'adult', crisisResources: '' },
      },
      origins: {},
      projectRoot: null,
      errors: [],
    };
  };
  const settingsFor = (c: Connection) => (isAdmin(c) ? settings.snapshot() : publicSettings(settings.snapshot(), c.auth!.user));
  /** Hidden models are an admin decision: only admins see them (to unhide them). */
  const modelsFor = (c: Connection, all: ModelInfo[]) => (isAdmin(c) ? all : all.filter((m) => !m.hidden));

  /** Ends the sign-in of matching connections, which then show the sign-in screen. */
  const signOutWhere = (pick: (c: Connection) => boolean) => {
    for (const c of connections) {
      if (!c.auth || !pick(c)) continue;
      c.auth = null;
      c.subscriptions.clear();
      c.rpc.emit('auth.signedOut', {});
    }
  };

  const inspector = new RequestInspector(() => settings.effective.developer.inspector);
  inspector.on('request', (request) => {
    for (const c of connections) if (isAdmin(c)) c.rpc.emit('developer.request', request);
  });
  // Provider sign-ins are admin-wide; token calls bypass the request inspector.
  const chatgpt = new ChatGptAuth({
    fetch: httpFetch,
    secrets: { get: (id) => secrets.get(id), set: (secret) => secrets.set(secret), delete: (id) => secrets.delete(id) },
    ...(Number(platform.env.ATELIER_CHATGPT_CALLBACK_PORT) >= 0 && platform.env.ATELIER_CHATGPT_CALLBACK_PORT ? { port: Number(platform.env.ATELIER_CHATGPT_CALLBACK_PORT) } : {}),
  });
  // GitHub Copilot signs in with the device flow, which needs no redirect: every backend has it. Like the providers, its
  // sign-in is the admins' and serves everyone the provider is shared with. Its token calls go around the request inspector.
  const copilot = new CopilotAuth({
    fetch: httpFetch,
    secrets: { get: (id) => secrets.get(id), set: (secret) => secrets.set(secret), delete: (id) => secrets.delete(id) },
  });
  const registry = new ProviderRegistry({
    db,
    settings,
    secrets,
    env: platform.env,
    createAdapter,
    // Plain-HTTP model servers go without fetch's 300-second timeouts (providers/plain-http.ts).
    // ATELIER_MODEL_IDLE_TIMEOUT_MS overrides how long such a request may receive nothing (15 minutes).
    adapterDeps: {
      fetch: inspector.wrap(platform.fetch ?? plainHttpFetch(httpFetch, { idleMs: Number(platform.env.ATELIER_MODEL_IDLE_TIMEOUT_MS) || undefined })),
      readBlob: (sha) => blobs.read(sha),
      ...(chatgpt ? { chatgpt } : {}),
      chatgptChat: platform.chatgptChat,
      copilot,
    },
  });
  // "Connect with OpenRouter": mints a key in the person's account and saves the provider with it.
  const openrouter = new OpenRouterConnect({ fetch: httpFetch, surface: platform.surface, save: (draft) => registry.save(draft) });
  registry.on('status', (s) => emitWhere(isAdmin, 'providers.changed', s));
  registry.on('models', (m: ModelInfo[]) => {
    for (const c of connections) if (c.auth) c.rpc.emit('models.changed', modelsFor(c, m));
  });
  const syncProviders = () => void registry.syncWithSettings().catch((e: unknown) => platform.logger.error('provider refresh failed', e));
  settings.on('change', () => {
    for (const c of connections) if (c.auth) c.rpc.emit('settings.changed', settingsFor(c));
    syncProviders();
  });

  const mcp = new McpManager({
    servers: () => settings.effective.mcpServers,
    surface: platform.surface,
    secret: (id) => secrets.forSettings(id),
    secrets,
    env: platform.env,
    blobs,
    logger: platform.logger,
    elicit: (sessionId, request, signal) => chat.elicit(sessionId, request, signal),
    fetch: (url, init) => httpFetch(String(url), init ?? {}),
  });
  settings.on('change', () => mcp.sync());
  /** Regular users see which connectors exist and the tools they may use, never their errors, URLs or commands. */
  const mcpStatusFor = (c: Connection, list: McpServerStatus[]): McpServerStatus[] =>
    isAdmin(c)
      ? list
      : list.map((s) => ({ name: s.name, type: s.type, state: s.state, tools: s.tools.filter((t) => t.enabled).map((t) => ({ name: t.name, readOnly: t.readOnly, enabled: true })) }));
  mcp.on('changed', (list) => {
    for (const c of connections) if (c.auth) c.rpc.emit('mcp.changed', mcpStatusFor(c, list));
  });
  /**
   * Writes system settings. A connector that goes away, stops signing in with OAuth or moves to another URL takes its
   * sign-in with it. Only on a write: a settings file that fails to load drops its connectors for a while, not their sign-ins.
   */
  const writeSettings = async (write: () => Promise<void>) => {
    const before = settings.effective.mcpServers;
    await write();
    const after = settings.effective.mcpServers;
    for (const [name, config] of Object.entries(before)) {
      if (config.auth && (after[name]?.auth !== config.auth || after[name]?.url !== config.url)) await mcp.signOut(name);
    }
  };
  const signInError = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      throw appError('sign_in_failed', e instanceof Error ? e.message : String(e));
    }
  };

  const checkpointStore = new Checkpoints({ db, blobs, repo: sessions });
  /** Stops and deletes conversations, and tells the owner's windows. */
  const removeConversations = async (userId: string, ids: string[]) => {
    const folders = await Promise.all(ids.map((id) => sessions.getRow(id).then((row) => row?.workspaceId ?? null)));
    for (const id of ids) await chat.discard(id);
    await deleteConversations(db, ids);
    for (const id of ids) emitToUser(userId, 'sessions.removed', { id });
    if (ids.length) emitToUser(userId, 'projects.changed', {});
    await forgetScratchFolders(userId, folders);
  };
  /** A scratch folder leaves the person's folders with the last session that used it; it stays on disk. */
  const forgetScratchFolders = async (userId: string, workspaceIds: (string | null)[]) => {
    if (await workspaceManager.forgetScratch(userId, workspaceIds)) emitToUser(userId, 'workspaces.changed', await workspaceManager.list(userId));
  };
  /** Daily: old checkpoints, conversations past each person's retention period, then blobs nothing uses. */
  const dailyCleanup = async () => {
    await checkpointStore.prune(settings.effective.checkpoints.retentionDays);
    for (const { id } of await db.select({ id: users.id }).from(users).all()) {
      const days = (await prefs.get(id)).privacy.historyRetentionDays;
      if (days) await removeConversations(id, await conversationIds(db, id, days));
    }
    await collectUnusedBlobs(db, blobs);
  };
  const cleanupTimer = setInterval(() => void dailyCleanup().catch((e: unknown) => platform.logger.error('daily cleanup failed', e)), 24 * 3600_000);
  cleanupTimer.unref();

  /** Whether any window has the session open (subscribed to it). */
  const openAnywhere = (id: string, except?: Connection) => [...connections].some((c) => c !== except && c.subscriptions.has(id));
  /** Deletes a temporary chat with everything it made, as `sessions.delete` would. */
  const removeTemporary = async (row: { id: string; userId: string | null; projectId: string | null; workspaceId: string | null }) => {
    await chat.discard(row.id);
    await sessions.delete(row.id);
    if (row.userId) {
      emitToUser(row.userId, 'sessions.removed', { id: row.id });
      if (row.projectId) emitToUser(row.userId, 'projects.changed', {});
      await forgetScratchFolders(row.userId, [row.workspaceId]);
    }
  };
  /** Temporary chats nobody has open and idle since `before` (all closed ones when the backend just started). */
  const sweepTemporary = async (before: number) => {
    for (const row of await sessions.temporaryIdleSince(before)) if (!openAnywhere(row.id)) await removeTemporary(row);
  };
  const temporarySweep = () => void sweepTemporary(Date.now() - TEMPORARY_MAX_IDLE_MS).catch((e: unknown) => platform.logger.error('temporary chat sweep failed', e));
  const temporaryTimer = setInterval(temporarySweep, 3600_000);
  temporaryTimer.unref();
  /** A window that closed or dropped gets this long to come back (a reload, a reconnect) before its temporary chats go. */
  const TEMPORARY_GRACE_MS = 60_000;
  const graceTimers = new Set<ReturnType<typeof setTimeout>>();
  const afterGrace = (run: () => Promise<void>) => {
    const timer = setTimeout(() => {
      graceTimers.delete(timer);
      void run().catch((e: unknown) => platform.logger.error('temporary chat cleanup failed', e));
    }, TEMPORARY_GRACE_MS);
    timer.unref();
    graceTimers.add(timer);
  };

  /**
   * Where skills are installed: on desktop the shared `~/.agents/skills` (linked from `~/.claude/skills` with
   * Claude Code compatibility), the layout `npx skills -g` uses; a server keeps them in its config dir.
   */
  const skillTarget = (): InstallTarget =>
    platform.surface === 'desktop'
      ? {
          root: join(homedir(), '.agents', 'skills'),
          ...(settings.effective.compat.claudeCode ? { linkFrom: join(homedir(), '.claude', 'skills') } : {}),
          lockFile: join(platform.configDir, 'skills-lock.json'),
        }
      : { root: join(platform.configDir, 'skills'), lockFile: join(platform.configDir, 'skills-lock.json') };

  const pluginTarget: PluginTarget = { cache: join(platform.configDir, 'plugins', 'cache'), registry: join(platform.configDir, 'plugins', 'installed.json') };
  /** Atelier's installs, then (desktop, with Claude Code compatibility) Claude Code's; Atelier's win a shared id. */
  const installedPlugins = async () => {
    const enabled = settings.effective.enabledPlugins;
    const own = await atelierPlugins(pluginTarget, enabled);
    const claude = platform.surface === 'desktop' && settings.effective.compat.claudeCode ? await claudeCodePlugins(homedir(), enabled) : [];
    return [...own, ...claude.filter((c) => !own.some((o) => o.id === c.id))];
  };
  const installErrors = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      throw e instanceof InstallError ? appError(e.code, e.message, e.data) : e;
    }
  };

  /**
   * Skills, commands and sub-agent definitions for a session (or the `/` menu before one exists): the
   * workspace's project folders first, then this machine's global ones. The desktop shares installs with
   * Claude Code and other agents (~/.agents/skills, ~/.claude/{skills,commands,agents}); a server keeps its own.
   */
  const globalRoots = (kind: 'skills' | 'commands' | 'agents', claudeCode: boolean) => [
    join(platform.configDir, kind),
    ...(platform.surface === 'desktop' && kind === 'skills' ? [join(homedir(), '.agents', 'skills')] : []),
    ...(platform.surface === 'desktop' && claudeCode ? [join(homedir(), '.claude', kind)] : []),
  ];
  const stopExtensionWatch = watchHost(
    [
      ...(['skills', 'commands', 'agents'] as const).flatMap((kind) => globalRoots(kind, true)),
      pluginTarget.registry,
      ...(platform.surface === 'desktop' ? [join(homedir(), '.claude', 'plugins', 'installed_plugins.json')] : []),
    ],
    () => {
      for (const c of connections) if (c.auth) c.rpc.emit('extensions.changed', {});
    },
  );
  const extensionsFor = async (userId: string | null, workspaceId: string | null): Promise<ExtensionCatalog> => {
    const claudeCode = settings.effective.compat.claudeCode;
    const workspace = workspaceId && userId ? await workspaceManager.open(userId, workspaceId).catch(() => null) : null;
    const desktop = platform.surface === 'desktop';
    const global = (kind: 'skills' | 'commands' | 'agents') => globalRoots(kind, claudeCode);
    const plugins = await installedPlugins();
    const sources = (kind: 'skills' | 'commands' | 'agents'): ExtensionSource[] => [
      // A folder's own skills, commands and agents are offered only once the person trusted it.
      ...(workspace && isTrusted(workspace) ? [{ fs: workspaceFs(workspace), location: 'workspace' as const, scope: 'project' as const, roots: projectRoots(workspace, kind, claudeCode) }] : []),
      { fs: hostFs, location: 'host', scope: 'global', roots: global(kind) },
      ...pluginSources(plugins, kind),
    ];
    const [skills, commands, agents] = await Promise.all([discoverSkills(sources('skills')), discoverCommands(sources('commands')), discoverAgents(sources('agents'))]);
    return {
      skills,
      commands,
      agents,
      read: (item) => (item.location === 'host' || !workspace ? hostFs : workspaceFs(workspace)).read(item.path),
      // A desktop skill used in a folder on the same machine: let Read and Glob reach its scripts and references.
      reach: async (skill) => {
        if (skill.location === 'host' && workspace && onThisMachine(workspace) && desktop) await workspace.runner.call('sys.addRoot', { path: skill.dir });
      },
      projectDir: workspace?.root ?? '',
    };
  };

  /** `~/.claude/settings.json` belongs to whoever owns this machine: only the desktop reads it, for its own folders. */
  const noClaudeSettings: ProjectSettings = { rules: { allow: [], ask: [], deny: [] }, hooks: [] };
  const ownerClaudeSettings = (workspace: Workspace) =>
    platform.surface === 'desktop' && onThisMachine(workspace) && settings.effective.compat.claudeCode ? claudeUserSettings(fs, homedir()) : Promise.resolve(noClaudeSettings);

  // Web search: one service for the tool and for Settings, so its rate limits, breakers and cache are shared. Stored secret
  // values are looked up (for a minute at a time) so that no query can carry one out.
  let secretValues: { at: number; values: string[] } | null = null;
  const searchBase = platform.env.ATELIER_SEARCH_BASE?.replace(/\/$/, '');
  const search = new SearchService({
    fetch: httpFetch,
    webFetch: platform.webFetch,
    config: () => resolveSearchConfig(settings.effective.capabilities.webSearch, (value) => interpolate(value, { secret: (id) => secrets.forSettings(id), env: (name) => platform.env[name] }).then((r) => r.value)),
    secretValues: async () => {
      if (secretValues && Date.now() - secretValues.at < 60_000) return secretValues.values;
      const found = await Promise.all((await secrets.list(() => [])).map((s) => secrets.get(s.id).catch(() => undefined)));
      secretValues = { at: Date.now(), values: found.filter((v): v is string => !!v && v.length >= 8) };
      return secretValues.values;
    },
    // The first results are read for their passages, like WebFetch would read them (same guard against private addresses).
    // Test-only: end-to-end tests serve result pages themselves instead of reaching the internet (and read nothing).
    ...(searchBase
      ? {
          endpoints: {
            duckduckgo: `${searchBase}/ddg/html/`,
            'duckduckgo-lite': `${searchBase}/ddg/lite/`,
            brave: `${searchBase}/brave/search`,
            bing: `${searchBase}/bing/search`,
            wikipedia: `${searchBase}/wikipedia/w/api.php`,
            'bing-news': `${searchBase}/bing/news`,
            'google-news': `${searchBase}/google/news`,
            'hacker-news': `${searchBase}/hn/search`,
            'stack-exchange': `${searchBase}/stackexchange/search`,
            github: `${searchBase}/github/search`,
          },
        }
      : { excerpt: createExcerptReader({ fetch: httpFetch, allowPrivateNetworks: () => settings.effective.capabilities.webFetchPrivateNetworks }) }),
  });

  /** One model request's tokens and cost, for Settings › Usage. */
  const recordUsage = ({ model, sessionId, mode, usage, userId }: { model: ModelInfo; sessionId: string | null; mode: string; usage: Usage; userId: string | null }) => {
    // A price the person set wins; else the provider's list price where Atelier knows it (providers/prices.ts).
    const providerType = settings.effective.providers.find((p) => p.id === model.providerId)?.type;
    const price = settings.effective.pricing[model.ref] ?? (providerType ? listPrice(providerType, model.modelId) : null);
    const cost = price ? costOf(price, usage) : null;
    void db.insert(usageEvents).values({
      id: newId(),
      ts: Date.now(),
      userId,
      providerId: model.providerId,
      modelId: model.modelId,
      sessionId,
      mode,
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: usage.cacheWrite ?? 0,
      reasoning: usage.reasoning ?? 0,
      durationMs: usage.durationMs ?? null,
      tokensPerSecond: usage.tokensPerSecond ?? null,
      costUsd: cost,
    }).catch((e: unknown) => platform.logger.error('recording usage failed', e));
  };

  const memory = new MemoryService({
    db,
    sessions,
    prefs: (userId) => prefs.get(userId),
    name: async (userId) => (await prefs.get(userId)).callMe.trim() || (await accounts.get(userId)).name,
    models: registry,
    settings: () => settings.effective,
    promptOverrides: () => promptOverrides,
    changed: (userId) => emitToUser(userId, 'memory.changed', {}),
    recordUsage: ({ model, sessionId, userId, usage }) => recordUsage({ model, sessionId, userId, usage, mode: 'chat' }),
    onError: (message, e) => platform.logger.error(message, e),
  });

  // What the Usage tool reports: a ChatGPT plan's windows, or what a priced model has cost.
  const providerType = (ref: string) => {
    const id = parseModelRef(ref)?.providerId;
    return settings.effective.providers.find((p) => p.id === id)?.type;
  };
  const usageSource = {
    offered: (ref: string) => {
      const type = providerType(ref);
      return type === 'chatgpt' || type === 'anthropic' || type === 'openai' || type === 'openai-compatible' || !!settings.effective.pricing[ref];
    },
    report: async (sessionId: string, ref: string) => {
      const type = providerType(ref);
      if (!type) return null;
      if (type === 'chatgpt') {
        const status = await chatgpt.status();
        const pro = status.plan?.toLowerCase().startsWith('pro') ?? false;
        // As the app shows them: a window the plan doesn't have is left out, and Pro has only the weekly one.
        const windows = [status.limits?.primary, status.limits?.secondary]
          .filter((w): w is NonNullable<typeof w> => !!w && (w.windowMinutes === null || w.windowMinutes > 0) && (!pro || w.windowMinutes === 10_080))
          .map((w) => ({ minutes: w.windowMinutes, usedPercent: w.usedPercent, resetsAt: w.resetsAt }));
        return { provider: PROVIDER_LABELS.chatgpt, ...(status.plan ? { plan: chatGptPlanLabel(status.plan) } : {}), windows };
      }
      const row = await sessions.getRow(sessionId);
      const offset = new Date().getTimezoneOffset();
      const rows = (days: number) => usageSummary(db, { userId: row?.userId ?? null, days, timezoneOffset: offset });
      const spent = (list: ReturnType<typeof rows>) => list.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
      const week = rows(7);
      return {
        provider: PROVIDER_LABELS[type],
        cost: { session: sessionUsage(db, sessionId).costUsd ?? null, today: spent(rows(1)), week: spent(week), unpriced: week.some((r) => r.unpriced > 0) },
      };
    },
  };

  const chat = new ChatService({
    usage: usageSource,
    search,
    memory,
    // Test-only: end-to-end tests run loops faster than the minute everyone else gets.
    ...(Number(platform.env.ATELIER_LOOP_MIN_INTERVAL_MS) > 0 ? { loopMinIntervalMs: Number(platform.env.ATELIER_LOOP_MIN_INTERVAL_MS) } : {}),
    checkpoints: checkpointStore,
    repo: sessions,
    artifacts,
    files,
    projects,
    blobs,
    settings: () => settings.effective,
    models: registry,
    promptOverrides: () => promptOverrides,
    // Whether a connection may follow a conversation was settled when it subscribed, and `syncRemoteAccess` ends the
    // subscriptions of those who lose it. A check here would cost a database read for every streamed token.
    sessionEvent: (sessionId, seq, event) => {
      for (const c of connections) if (c.subscriptions.has(sessionId)) c.rpc.emit('session.event', { sessionId, seq, event });
    },
    sessionChanged: (summary) =>
      void sessions
        .getRow(summary.id)
        // Sub-agent sessions stay out of Recents; their transcript cards follow them through session events.
        .then((row) => row && !row.parentSessionId && emitToUser(row.userId, 'sessions.changed', summary))
        .catch((e: unknown) => platform.logger.error('session update broadcast failed', e)),
    person: async (userId) => {
      if (!userId) return { prefs: await prefs.get(''), name: '', safeguards: 'inherit' };
      const user = await accounts.get(userId);
      return { prefs: await prefs.get(userId), name: user.name, safeguards: user.safeguards };
    },
    permissionContext: async (session) => {
      // Chat sessions have no workspace: only connector tools are gated there.
      if (session.mode === 'chat' || !session.workspaceId || !session.userId) {
        const { allow, ask, deny } = settings.effective.permissions;
        const mine = session.userId ? (await prefs.get(session.userId)).permissions.allow : [];
        return connectorContext({ allow: [...allow, ...mine], ask, deny }, homedir());
      }
      const workspace = await workspaceManager.open(session.userId, session.workspaceId);
      const system = settings.effective.permissions;
      const project = await projectRules(workspace, settings.effective.compat.claudeCode);
      const claude = (await ownerClaudeSettings(workspace)).rules;
      const person = (await prefs.get(session.userId)).permissions;
      return {
        mode: (session.permissionMode as PermissionMode | null) ?? system.defaultMode,
        rules: {
          allow: [...claude.allow, ...system.allow, ...project.allow, ...person.allow],
          ask: [...claude.ask, ...system.ask, ...project.ask],
          deny: [...claude.deny, ...system.deny, ...project.deny],
        },
        cwd: workspace.root,
        home: workspace.home,
        projectRoot: workspace.root,
        roots: [workspace.root, ...system.additionalDirectories],
        isReadOnly: () => false,
      };
    },
    workspace: async (session) => (session.workspaceId && session.userId ? workspaceManager.open(session.userId, session.workspaceId) : null),
    chatSandboxAvailable: (session) => !!session.userId && workspaceManager.chatSandboxes,
    chatSandbox: (session) => {
      // Parallel calls of a turn share one new sandbox.
      let made = sandboxesMaking.get(session.id);
      if (!made) {
        made = (async () => {
          const userId = session.userId!;
          const fresh = await sessions.getRow(session.id);
          if (fresh?.workspaceId) return workspaceManager.open(userId, fresh.workspaceId);
          const folder = await workspaceManager.addChatSandbox(userId);
          await sessions.update(session.id, { workspaceId: folder.id });
          return workspaceManager.open(userId, folder.id);
        })();
        sandboxesMaking.set(session.id, made);
        void made.finally(() => sandboxesMaking.delete(session.id)).catch(() => undefined);
      }
      return made;
    },
    // A path outside the folder that a call on it was allowed to reach: the runner takes the nearest folder that exists
    // (the path itself when it is one, else its parent, and up) as a root, never the filesystem root or a home folder.
    reach: async (session, path) => {
      if (!session.workspaceId || !session.userId) return;
      const workspace = await workspaceManager.open(session.userId, session.workspaceId);
      // A POSIX path stays POSIX whatever this computer is (an SSH host seen from Windows).
      const parentOf = (p: string) => (p.startsWith('/') ? posix.dirname(p) : dirname(p));
      const never = new Set(['/', parentOf(workspace.home), workspace.home].map((p) => p.replace(/\/+$/, '') || '/'));
      let dir = path;
      for (let i = 0; i < 8; i++) {
        if (never.has(dir.replace(/\/+$/, '') || '/')) return;
        try {
          await workspace.runner.call('sys.addRoot', { path: dir });
          return;
        } catch {
          const parent = parentOf(dir);
          if (parent === dir) return;
          dir = parent;
        }
      }
    },
    moveWorkspace: async (session, path) => {
      if (!session.workspaceId || !session.userId) throw new WorkspaceError('This session has no folder to move from.');
      return workspaceManager.openFrom(session.userId, session.workspaceId, path);
    },
    hooks: async (session) => {
      if (session.mode === 'chat' || !session.workspaceId || !session.userId) return null;
      const workspace = await workspaceManager.open(session.userId, session.workspaceId);
      const configs = [
        ...(await ownerClaudeSettings(workspace)).hooks,
        // Plugins live on this machine, so their hooks run only for its own folders.
        ...(onThisMachine(workspace) ? await pluginHooks(await installedPlugins()) : []),
        // The admin's hooks run only on this backend's own machine, never on a person's device.
        ...(onThisMachine(workspace) ? [settings.effective.hooks] : []),
        ...(await projectHooks(workspace, settings.effective.compat.claudeCode)),
      ].filter((c) => Object.keys(c).length);
      return configs.length ? { workspace, configs } : null;
    },
    extensions: (session) => extensionsFor(session.userId, session.mode === 'chat' ? null : session.workspaceId),
    // A sub-agent uses the connectors its parent session has on.
    mcpTools: async (session) => mcp.tools(connectorsOff((session.parentSessionId && (await sessions.getRow(session.parentSessionId))) || session)),
    hookError: (sessionId, message) => platform.logger.error(`hook failed in session ${sessionId}: ${message}`),
    codeContext: async (session) => {
      if (!session.workspaceId || !session.userId) return null;
      const workspace = await workspaceManager.open(session.userId, session.workspaceId);
      const claudeCode = settings.effective.compat.claudeCode;
      const summary = (await workspaceManager.list(session.userId)).find((w) => w.id === session.workspaceId);
      return codeContext(workspace, {
        scratch: summary?.scratch ?? false,
        host: hostReader(fs, platform.surface === 'desktop' ? [platform.configDir, homedir()] : [platform.configDir]),
        home: homedir(),
        globals: instructionGlobals({
          configDir: platform.configDir,
          home: platform.surface === 'desktop' ? homedir() : null,
          claudeCode,
          stored: (await prefs.get(session.userId)).personalization.atelierMd,
        }),
        claudeCode,
        kind:
          summary?.kind === 'ssh'
            ? `SSH host ${workspace.host}`
            : summary?.kind === 'codespace'
              ? `GitHub codespace ${workspace.host}`
              : workspace.deviceId
                ? "a folder on the person's computer, reached through their desktop app"
                : platform.surface === 'desktop'
                  ? "a folder on the person's computer"
                  : 'a folder on the Atelier server',
        additionalDirectories: settings.effective.permissions.additionalDirectories,
      });
    },
    folders: async (userId) => (await workspaceManager.list(userId)).map((w) => ({ id: w.id, name: w.name })),
    gitSnapshot: async (session) => (session.workspaceId && session.userId ? git.repositorySnapshot(await workspaceManager.open(session.userId, session.workspaceId)) : null),
    rememberProjectRule: async (session, rule) => {
      if (!session.workspaceId || !session.userId) return;
      await workspaceManager
        .open(session.userId, session.workspaceId)
        .then((workspace) => rememberProjectRule(workspace, rule))
        .catch((e: unknown) => platform.logger.error('saving a project permission rule failed', e));
    },
    rememberRule: async (userId, rule) => {
      const current = await prefs.get(userId);
      if (current.permissions.allow.includes(rule)) return;
      emitToUser(userId, 'prefs.changed', await prefs.set(userId, ['permissions', 'allow'], [...current.permissions.allow, rule]));
    },
    fetch: httpFetch,
    resolveRefs: async (value) => (await interpolate(value, { secret: (id) => secrets.forSettings(id), env: (name) => platform.env[name] })).value,
    recordUsage,
  });

  await sessions.markRunningAsInterrupted();
  // Long-idle temporary chats go now; the rest of those left from before go if no window reopens them shortly.
  await sweepTemporary(Date.now() - TEMPORARY_MAX_IDLE_MS);
  const startedAt = Date.now();
  afterGrace(() => sweepTemporary(startedAt));
  await accounts.prune();
  syncProviders();
  const stopPromptWatch = fs.watch([join(platform.configDir, 'prompts')], () => {
    void loadTemplateOverrides(fs, join(platform.configDir, 'prompts'))
      .then((o) => (promptOverrides = o))
      .catch((e: unknown) => platform.logger.error('loading prompt overrides failed', e));
  });

  /** Which settings paths reference each secret (shown in Keys & secrets and on the provider row). */
  const secretUsage = (): Map<string, string[]> => {
    const usage = new Map<string, string[]>();
    const raw = settings.layerRaw('global') ?? {};
    const use = (id: string, path: string) => usage.set(id, [...(usage.get(id) ?? []), path]);
    for (const path of leafPaths(raw)) {
      const value = getAt(raw, path.split('.'));
      if (typeof value === 'string') for (const id of secretRefs(value)) use(id, path);
      // Lists of entries (providers) name the entry that holds the reference: `providers.<id>`.
      else if (Array.isArray(value)) {
        value.forEach((item, i) => {
          for (const id of secretRefs(JSON.stringify(item))) use(id, `${path}.${(item as { id?: unknown })?.id ?? i}`);
        });
      }
    }
    return usage;
  };

  type Ctx = { connection: () => Connection };
  /** The signed-in user; the guard below has already rejected anonymous calls. */
  const me = (ctx: Ctx): UserSummary => ctx.connection().auth!.user;
  /** The person's SSH connections, with whether a password is kept for each. */
  const sshViews = async (userId: string): Promise<SshConnectionView[]> => {
    const list = (await prefs.get(userId)).ssh.connections;
    const kept = new Set((await secrets.list(() => [])).map((s) => s.id));
    return list.map((c) => ({ ...c, passwordSaved: kept.has(sshSecretId(userId, c.id)) }));
  };
  const githubOp = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      throw e instanceof GitHubError ? appError('github_failed', e.message) : e;
    }
  };
  /**
   * A codespace's checkout as the person's folder (the same one when it already is), announced to their windows. `trust`: the
   * person answered "Trust this workspace?" with yes; without it the checkout's own settings and hooks stay off.
   */
  const addCodespaceFolder = async (userId: string, codespace: { name: string; root: string }, trust = false) => {
    const added = await workspaceManager.addCodespace(userId, codespace.name, codespace.root, trust).catch((e: unknown) => {
      throw e instanceof WorkspaceError || e instanceof SshError ? appError('workspace_unavailable', e.message) : e;
    });
    emitToUser(userId, 'workspaces.changed', await workspaceManager.list(userId));
    return added;
  };
  const gitOp = async <T>(ctx: Ctx, workspaceId: string, op: (ws: Workspace) => Promise<T>): Promise<T> => {
    const ws = await openWorkspace(ctx, workspaceId);
    try {
      return await op(ws);
    } catch (e) {
      throw e instanceof git.GitError ? appError('git_failed', e.message) : e;
    }
  };
  const openWorkspace = (ctx: Ctx, id: string) =>
    workspaceManager.open(me(ctx).id, id).catch((e: unknown) => {
      throw e instanceof WorkspaceError ? appError('workspace_unavailable', e.message) : e;
    });
  /**
   * On a server, the desktop device this connection comes from, when it lends `service` (its folders, scratch folders,
   * SSH hosts reached from it); null on the desktop's own backend, which does these itself.
   */
  const callerDevice = (ctx: { connection(): Connection }, service: DeviceService): string | null => {
    if (platform.surface === 'desktop') return null;
    const c = ctx.connection();
    const deviceId = c.deviceId;
    const userId = c.auth?.user.id;
    if (!deviceId || !userId) return null;
    return links.info(userId, deviceId)?.services.includes(service) ? deviceId : null;
  };
  /** A new session's scratch folder (it starts with no folder); the person's clients learn of it like any folder. */
  const scratchFolder = async (userId: string, sshHost: string | undefined, deviceId: string | null): Promise<string> => {
    const added = await workspaceManager.addScratch(userId, sshHost, deviceId).catch((e: unknown) => {
      throw e instanceof WorkspaceError || e instanceof SshError ? appError('workspace_unavailable', e.message) : e;
    });
    emitToUser(userId, 'workspaces.changed', await workspaceManager.list(userId));
    return added.id;
  };
  const canAccessSession = async (row: NonNullable<Awaited<ReturnType<SessionRepo['getRow']>>>, c: Connection): Promise<boolean> => {
    if (row.userId !== c.auth?.user.id) return false;
    if (row.parentSessionId) {
      const parent = await sessions.getRow(row.parentSessionId);
      return !!parent && canAccessSession(parent, c);
    }
    if (platform.surface === 'desktop') return true;
    const origin = row.overrides.originClient;
    if (origin && origin === (c.auth?.sessionId)) return true;
    return row.overrides.remoteControl !== false && (await prefs.get(c.auth.user.id)).remoteControl;
  };
  /**
   * After remote control was switched for a person (everything of theirs) or for one conversation: their connections are
   * told what they may still see, and the live events of what they may not stop. Subscriptions are the only place a
   * conversation's events leave through, so this is where access is enforced for streaming.
   */
  const syncRemoteAccess = async (userId: string, onlySessionId?: string): Promise<void> => {
    if (!onlySessionId) for (const summary of await sessions.list({ userId, archived: 'all', limit: 10_000 })) emitToUser(userId, 'sessions.changed', summary);
    for (const connection of connections) {
      if (connection.auth?.user.id !== userId) continue;
      for (const id of [...connection.subscriptions]) {
        if (onlySessionId && id !== onlySessionId) continue;
        const row = await sessions.getRow(id);
        if (row && !(await canAccessSession(row, connection))) {
          connection.subscriptions.delete(id);
          connection.rpc.emit('sessions.removed', { id });
        }
      }
    }
  };
  const sessionOrThrow = async (id: string, ctx: Ctx): Promise<SessionSummary> => {
    const row = await sessions.getRow(id);
    // Someone else's conversation reads like a deleted one; only the person's own, kept off this device, says so.
    if (!row || row.userId !== ctx.connection().auth?.user.id) throw appError('not_found', 'That conversation no longer exists.');
    if (!(await canAccessSession(row, ctx.connection()))) throw appError('not_found', 'That conversation is unavailable on this device.');
    return (await sessions.get(id))!;
  };
  const projectOrThrow = async (id: string, ctx: Ctx): Promise<void> => {
    if ((await projects.ownerOf(id)) !== me(ctx).id) throw appError('not_found', 'Project not found.');
  };
  const fileOrThrow = async (id: string, ctx: Ctx) => {
    const row = await files.get(id);
    if (!row || row.userId !== me(ctx).id) throw appError('not_found', 'File not found.');
    return row;
  };
  const accountErrors = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      if (e instanceof AccountError) throw appError(e.code, e.message);
      if (e instanceof PrefsValidationError) throw appError('invalid_setting', e.message);
      throw e;
    }
  };
  const memoryErrors = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      if (e instanceof MemoryNotFoundError) throw appError('not_found', e.message);
      if (e instanceof MemoryEditingOffError) throw appError('forbidden', e.message);
      if (e instanceof MemoryInvalidError) throw appError('invalid_input', e.message);
      if (e instanceof ModelChoiceError) throw appError('model_unavailable', e.message);
      throw appError('memory_failed', `Memory couldn't be updated: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const localOnly = () => {
    if (!local) throw appError('unsupported', 'Only the desktop app running on this computer has this.');
  };
  /** Every window follows the screen lock, signed in or not. */
  const lockChanged = (status: ReturnType<ScreenLock['status']>) => {
    for (const c of connections) c.rpc.emit('lock.changed', status);
    return status;
  };
  const lockErrors = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      if (e instanceof ScreenLockError) throw appError(e.code, e.message, { retryAt: e.retryAt });
      throw e;
    }
  };
  /** Signs a connection in after it proved who it is (setup, login, invite). */
  const signIn = async (ctx: Ctx, result: { token: string; user: UserSummary }) => {
    ctx.connection().auth = await accounts.authenticate(result.token);
    return result;
  };

  // The desktop app's own backend updates with the app, not through this.
  const serverUpdates = platform.serverUpdates !== undefined ? platform.serverUpdates : platform.surface === 'web' ? serverUpdatesFromEnv(platform.env) : null;
  const serverUpdateErrors = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      if (e instanceof ServerUpdateError) throw appError(e.code, e.message);
      throw e;
    }
  };

  const handlers: Handlers<AppContract, Ctx> = {
    'app.info': () => ({
      name: APP.name,
      version: APP.version,
      surface: platform.surface,
      platform: process.platform,
      dataDir: platform.dataDir,
      // A server takes these from desktop devices (ARCHITECTURE §21); their windows offer them only where both ends can.
      ...(platform.surface === 'web' ? { deviceLink: { protocol: DEVICE_LINK_PROTOCOL, services: [...SERVER_DEVICE_SERVICES] } } : {}),
    }),

    // ---------------------------------------------------------------- sign-in
    'auth.status': async (_input, ctx) => ({
      setupRequired: await accounts.setupRequired(),
      signup: settings.effective.server.signup,
      user: ctx.connection().auth?.user ?? null,
      local,
    }),
    'auth.setupLocal': ({ name, clientKind }, ctx) =>
      accountErrors(async () => {
        localOnly();
        return signIn(ctx, await accounts.setupLocal(name, { ...ctx.connection().client, clientKind }));
      }),
    'auth.localSignIn': ({ clientKind }, ctx) =>
      accountErrors(async () => {
        localOnly();
        return signIn(ctx, await accounts.signInOwner({ ...ctx.connection().client, clientKind }));
      }),

    // ---------------------------------------------------------------- screen lock
    'lock.status': async () => {
      if (local) await screenLock.load();
      return screenLock.status();
    },
    'lock.unlock': ({ secret }) =>
      lockErrors(async () => {
        localOnly();
        const before = screenLock.locked;
        const status = await screenLock.unlock(secret);
        return before ? lockChanged(status) : status;
      }),
    'lock.lock': () => {
      localOnly();
      return lockChanged(screenLock.lock());
    },
    'lock.set': ({ lock, current }) =>
      lockErrors(async () => {
        localOnly();
        return lockChanged(await screenLock.set(lock, current));
      }),
    'lock.clear': ({ current }) =>
      lockErrors(async () => {
        localOnly();
        return lockChanged(await screenLock.clear(current));
      }),
    'lock.setAutoLock': ({ minutes }) =>
      lockErrors(async () => {
        localOnly();
        return lockChanged(await screenLock.setAutoLock(minutes));
      }),
    'auth.setup': ({ setupToken, clientKind, ...input }, ctx) =>
      accountErrors(async () => {
        if (platform.setupToken && setupToken !== platform.setupToken) throw appError('invalid_setup_token', 'That setup token is wrong. It is printed in the server log.');
        return signIn(ctx, await accounts.setup(input, { ...ctx.connection().client, clientKind }));
      }),
    'auth.login': ({ clientKind, ...input }, ctx) => accountErrors(async () => signIn(ctx, await accounts.login(input, { ...ctx.connection().client, clientKind }))),
    'auth.checkInvite': ({ invite }, ctx) =>
      accountErrors(async () => {
        await accounts.checkInvite(invite, ctx.connection().client);
        return { ok: true as const };
      }),
    'auth.acceptInvite': ({ clientKind, ...input }, ctx) => accountErrors(async () => signIn(ctx, await accounts.acceptInvite(input, { ...ctx.connection().client, clientKind }))),
    'auth.signup': (input) =>
      accountErrors(async () => {
        await accounts.signup(input);
        return { pending: true as const };
      }),
    'auth.logout': async (_input, ctx) => {
      const c = ctx.connection();
      await accounts.logout(c.auth!.sessionId);
      const sessionId = c.auth!.sessionId;
      signOutWhere((x) => x.auth?.sessionId === sessionId);
      return { ok: true as const };
    },

    // ---------------------------------------------------------------- your account
    'account.get': (_input, ctx) => accounts.get(me(ctx).id),
    'account.update': async (patch, ctx) => {
      const user = await accounts.update(me(ctx).id, patch);
      for (const c of connections) if (c.auth?.user.id === user.id) c.auth.user = user;
      emitToUser(user.id, 'account.changed', user);
      return user;
    },
    'account.changePassword': ({ current, next }, ctx) =>
      accountErrors(async () => {
        const { user, sessionId } = ctx.connection().auth!;
        await accounts.changePassword(user.id, current, next, sessionId);
        signOutWhere((c) => c.auth?.user.id === user.id && c.auth.sessionId !== sessionId);
        const updated = await accounts.get(user.id);
        ctx.connection().auth!.user = updated;
        emitToUser(user.id, 'account.changed', updated);
        return { ok: true as const };
      }),
    'account.sessions': (_input, ctx) => accounts.listSessions(me(ctx).id, ctx.connection().auth!.sessionId),
    'account.revokeSession': async ({ id }, ctx) => {
      await accounts.revokeSession(me(ctx).id, id);
      signOutWhere((c) => c.auth?.sessionId === id);
      return { ok: true as const };
    },
    'account.logoutEverywhere': async (_input, ctx) => {
      const userId = me(ctx).id;
      await accounts.revokeAll(userId);
      signOutWhere((c) => c.auth?.user.id === userId);
      return { ok: true as const };
    },
    'account.passkeys': (_input, ctx) => passkeys.list(me(ctx).id),
    'account.removePasskey': async ({ id }, ctx) => {
      await passkeys.remove(me(ctx).id, id);
      return { ok: true as const };
    },
    'account.devices': async (_input, ctx) => {
      const userId = me(ctx).id;
      const connected = (id: string) => [...connections].some((c) => c.deviceId === id && c.auth?.user.id === userId);
      const list = await devices.list(userId, ctx.connection().deviceId, (id) => links.online(userId, id) || connected(id));
      return list.map((d) => {
        const info = links.info(userId, d.id);
        return info ? { ...d, services: [...info.services], lending: info.lending } : d;
      });
    },
    'account.removeDevice': async ({ id }, ctx) => {
      await devices.remove(me(ctx).id, id);
      return { ok: true as const };
    },
    'devices.register': async (input, ctx) => {
      const row = await devices.register(me(ctx).id, input);
      ctx.connection().deviceId = row.id;
      return toDeviceSummary(row, row.id, true);
    },

    'prefs.get': (_input, ctx) => prefs.get(me(ctx).id),
    'prefs.set': ({ path, value }, ctx) =>
      accountErrors(async () => {
        if (path[0] === 'remoteControl' && value === false) {
          for (const summary of await sessions.list({ userId: me(ctx).id, archived: 'all', limit: 10_000 })) {
            const row = await sessions.getRow(summary.id);
            if (row && !row.overrides.originClient) await sessions.patchQuietly(row.id, { overrides: { ...row.overrides, originClient: ctx.connection().auth?.sessionId } });
          }
        }
        const next = await prefs.set(me(ctx).id, path, value);
        emitToUser(me(ctx).id, 'prefs.changed', next);
        if (path[0] === 'remoteControl') await syncRemoteAccess(me(ctx).id);
        return next;
      }),
    'prefs.reset': ({ path }, ctx) =>
      accountErrors(async () => {
        const next = await prefs.reset(me(ctx).id, path);
        emitToUser(me(ctx).id, 'prefs.changed', next);
        if (path[0] === 'remoteControl') await syncRemoteAccess(me(ctx).id);
        return next;
      }),

    // ---------------------------------------------------------------- admin: people
    'users.list': () => accounts.list(),
    'users.create': (input) => accountErrors(() => accounts.create(input)),
    'users.update': ({ id, ...patch }) =>
      accountErrors(async () => {
        const user = await accounts.adminUpdate(id, patch);
        if (user.disabled || user.role === 'pending') signOutWhere((c) => c.auth?.user.id === id);
        for (const c of connections) {
          if (c.auth?.user.id !== id) continue;
          c.auth.user = user;
          // Their role and safeguards decide which settings they see.
          c.rpc.emit('settings.changed', settingsFor(c));
        }
        emitToUser(id, 'account.changed', user);
        return user;
      }),
    'users.resetPassword': ({ id }) =>
      accountErrors(async () => {
        const temporaryPassword = await accounts.resetPassword(id);
        signOutWhere((c) => c.auth?.user.id === id);
        return { temporaryPassword };
      }),
    'users.delete': ({ id }, ctx) =>
      accountErrors(async () => {
        if (id === me(ctx).id) throw appError('forbidden', 'You can’t delete your own account here.');
        for (const s of await sessions.list({ userId: id, archived: 'all', limit: 500, withTemporary: true })) await chat.discard(s.id);
        signOutWhere((c) => c.auth?.user.id === id);
        await accounts.remove(id);
        return { ok: true as const };
      }),
    'invites.list': () => accounts.listInvites(),
    'invites.create': ({ role }, ctx) => accounts.createInvite(role, me(ctx).id),
    'invites.revoke': async ({ id }) => {
      await accounts.revokeInvite(id);
      return { ok: true as const };
    },

    // ---------------------------------------------------------------- admin: system settings and providers
    'settings.get': (_input, ctx) => settingsFor(ctx.connection()),
    'settings.set': async ({ layer, path, value }) => {
      if (secretRefs(JSON.stringify(value) ?? '').some(isPersonalSecret)) throw appError('forbidden', "Settings can't use a person's own secrets.");
      try {
        await writeSettings(() => settings.set(layer, path, value));
      } catch (e) {
        if (e instanceof SettingsValidationError) throw appError('invalid_setting', e.message);
        throw e;
      }
      return { ok: true as const };
    },
    'settings.reset': async ({ layer, path }) => {
      await writeSettings(() => settings.reset(layer, path));
      return { ok: true as const };
    },

    'secrets.list': async () => {
      const usage = secretUsage();
      // People's own GitHub tokens are theirs, not the admin's to see or rotate. Connectors' sign-ins are managed on
      // the connector (Sign in, Sign out, Remove).
      return (await secrets.list((id) => usage.get(id) ?? [])).filter((s) => !isPersonalSecret(s.id) && s.kind !== 'mcp_oauth');
    },
    'secrets.set': async ({ id, label, kind, value }) => {
      if (isPersonalSecret(id)) throw appError('forbidden', 'That secret belongs to a person.');
      await secrets.set({ id, label, kind, value });
      const usage = secretUsage();
      return (await secrets.list((sid) => usage.get(sid) ?? [])).find((s) => s.id === id)!;
    },
    'secrets.delete': async ({ id }) => {
      if (isPersonalSecret(id)) throw appError('forbidden', 'That secret belongs to a person.');
      if ((secretUsage().get(id) ?? []).length) throw appError('secret_in_use', 'This secret is still referenced in settings. Remove those references first.');
      await secrets.delete(id);
      return { ok: true as const };
    },

    'providers.status': () => registry.statusList(),
    'providers.detect': () => registry.detect(),
    'providers.test': (draft) => registry.test(draft),
    'providers.save': async (draft) => {
      if (!draft.apiKey && !draft.apiKeyFromEnv && (draft.type === 'anthropic' || draft.type === 'openai')) {
        const existing = settings.effective.providers.find((p) => p.id === draft.id);
        if (!existing?.apiKey) throw appError('missing_key', `${draft.name} needs an API key.`);
      }
      return registry.save(draft);
    },
    'providers.remove': async ({ id }) => {
      // A subscription's sign-in goes with its provider.
      const type = settings.effective.providers.find((p) => p.id === id)?.type;
      if (type === 'chatgpt') await chatgpt?.signOut();
      if (type === 'copilot') await copilot.signOut();
      await registry.remove(id);
      return { ok: true as const };
    },
    'providers.refresh': ({ id }) => registry.refresh(id),
    'models.list': async (_input, ctx) => modelsFor(ctx.connection(), await registry.listModels()),
    'models.probeTools': ({ ref }) => registry.probeTools(ref),

    // ---------------------------------------------------------------- your chats
    'sessions.list': async (input, ctx) => {
      const list = await sessions.list({ ...input, userId: me(ctx).id });
      const allowed = await Promise.all(list.map(async (summary) => {
        const row = await sessions.getRow(summary.id);
        return row && await canAccessSession(row, ctx.connection()) ? summary : null;
      }));
      return allowed.filter((summary): summary is SessionSummary => summary !== null);
    },
    'sessions.create': async ({ mode, projectId, model, effort, thinking, remoteControl, workspaceId, scratch, permissionMode, connectorsOff: off, research, groupId, temporary }, ctx) => {
      if (projectId) await projectOrThrow(projectId, ctx);
      const userId = me(ctx).id;
      if (temporary && (mode !== 'chat' || groupId)) throw appError('unsupported', 'Only a chat can be temporary, and it isn’t filed in a group.');
      if (workspaceId && !(await workspaceManager.list(userId)).some((w) => w.id === workspaceId)) throw appError('not_found', 'Workspace not found.');
      if (scratch && (mode === 'chat' || workspaceId)) throw appError('unsupported', 'Only a Code or Cowork session without a folder gets a scratch folder.');
      const folder = scratch ? await scratchFolder(userId, scratch.sshHost, callerDevice(ctx, scratch.sshHost ? 'ssh' : 'scratch')) : workspaceId;
      const created = await sessions.create({
        mode,
        userId,
        projectId: projectId ?? null,
        model: model ?? null,
        effort: sessionEffort(effort ?? null, mode),
        workspaceId: folder ?? null,
        permissionMode: permissionMode ?? null,
        groupId: groupId && (await groups.get(userId, groupId)) ? groupId : null,
        overrides: { ...(off?.length ? { connectorsOff: off } : {}), ...(research ? { research } : {}), thinking: thinking ?? (await prefs.get(userId)).thinking, remoteControl: remoteControl ?? true, originClient: ctx.connection().auth?.sessionId },
        temporary: temporary ? (await prefs.get(userId)).privacy.temporaryChats : null,
      });
      // Nothing lists a temporary chat, so there is nothing to tell other windows.
      if (temporary) return created;
      emitToUser(userId, 'sessions.changed', created);
      // The person moved on: what their earlier conversations hold is remembered now rather than after the idle wait.
      memory.sessionStarted(userId);
      // Project lists show chat counts.
      if (projectId) emitToUser(userId, 'projects.changed', {});
      return created;
    },
    'sessions.update': async ({ id, title, pinned, model, effort, thinking, remoteControl, projectId, permissionMode, connectorsOff: off, research, groupId, archived, unread }, ctx) => {
      const before = await sessionOrThrow(id, ctx);
      const row = off !== undefined || research !== undefined || thinking !== undefined || remoteControl !== undefined ? await sessions.getRow(id) : undefined;
      if (projectId) await projectOrThrow(projectId, ctx);
      if (groupId && !(await groups.get(me(ctx).id, groupId))) throw appError('not_found', 'Group not found.');
      const loud = {
        ...(title !== undefined ? { title } : {}),
        ...(pinned !== undefined ? { pinnedAt: pinned ? Date.now() : null } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(effort !== undefined ? { effort: sessionEffort(effort, before.mode) } : {}),
        ...(projectId !== undefined ? { projectId } : {}),
        ...(permissionMode !== undefined ? { permissionMode } : {}),
        ...(row ? { overrides: { ...row.overrides, ...(off !== undefined ? { connectorsOff: off } : {}), ...(research !== undefined ? { research } : {}), ...(thinking !== undefined ? { thinking } : {}), ...(remoteControl !== undefined ? { remoteControl, originClient: row.overrides.originClient ?? ctx.connection().auth?.sessionId } : {}) } } : {}),
      };
      // Filing, archiving and marking unread are the person's housekeeping, not activity: they don't reorder Recents.
      const quiet = {
        ...(groupId !== undefined ? { groupId } : {}),
        ...(archived !== undefined ? { archivedAt: archived ? Date.now() : null } : {}),
        ...(unread !== undefined ? { finishedUnseenAt: unread ? Date.now() : null } : {}),
      };
      if (Object.keys(quiet).length) await sessions.patchQuietly(id, quiet);
      const updated = Object.keys(loud).length ? await sessions.update(id, loud) : (await sessions.get(id))!;
      emitToUser(me(ctx).id, 'sessions.changed', updated);
      if (remoteControl !== undefined) await syncRemoteAccess(me(ctx).id, id);
      if (updated.projectId !== before.projectId) emitToUser(me(ctx).id, 'projects.changed', {});
      return updated;
    },
    'sessions.fork': async ({ id }, ctx) => {
      await sessionOrThrow(id, ctx);
      const copy = await sessions.fork(id);
      emitToUser(me(ctx).id, 'sessions.changed', copy);
      return copy;
    },
    'sessions.continueInCowork': async ({ id }, ctx) => {
      const row = await sessionOrThrow(id, ctx);
      if (row.mode !== 'chat') throw appError('unsupported', 'Only a chat can be continued in Cowork.');
      if (row.temporary) throw appError('unsupported', 'A temporary chat can’t be continued in Cowork.');
      const copy = await sessions.fork(id, 'work');
      emitToUser(me(ctx).id, 'sessions.changed', copy);
      return copy;
    },
    'groups.list': async (_input, ctx) => groups.list(me(ctx).id),
    'groups.create': async ({ name }, ctx) => {
      const created = await groups.create(me(ctx).id, name);
      emitToUser(me(ctx).id, 'groups.changed', await groups.list(me(ctx).id));
      return created;
    },
    'groups.update': async ({ id, name, collapsed }, ctx) => {
      const updated = await groups.update(me(ctx).id, id, { ...(name !== undefined ? { name } : {}), ...(collapsed !== undefined ? { collapsed } : {}) });
      if (!updated) throw appError('not_found', 'Group not found.');
      emitToUser(me(ctx).id, 'groups.changed', await groups.list(me(ctx).id));
      return updated;
    },
    'groups.delete': async ({ id }, ctx) => {
      if (!(await groups.delete(me(ctx).id, id))) throw appError('not_found', 'Group not found.');
      emitToUser(me(ctx).id, 'groups.changed', await groups.list(me(ctx).id));
      return { ok: true as const };
    },
    'sessions.markSeen': async ({ id }, ctx) => {
      await sessionOrThrow(id, ctx);
      const seen = await sessions.markSeen(id);
      if (seen) emitToUser(me(ctx).id, 'sessions.changed', seen);
      return { ok: true as const };
    },
    'sessions.delete': async ({ id }, ctx) => {
      const session = await sessionOrThrow(id, ctx);
      await chat.discard(id);
      await sessions.delete(id);
      emitToUser(me(ctx).id, 'sessions.removed', { id });
      if (session.projectId) emitToUser(me(ctx).id, 'projects.changed', {});
      await forgetScratchFolders(me(ctx).id, [session.workspaceId]);
      return { ok: true as const };
    },
    'sessions.subscribe': async ({ id }, ctx) => {
      await sessionOrThrow(id, ctx);
      ctx.connection().subscriptions.add(id);
      return chat.snapshot(id);
    },
    'sessions.unsubscribe': ({ id }, ctx) => {
      ctx.connection().subscriptions.delete(id);
      return { ok: true as const };
    },
    'sessions.leave': async ({ id }, ctx) => {
      await sessionOrThrow(id, ctx);
      const row = (await sessions.getRow(id))!;
      ctx.connection().subscriptions.delete(id);
      if (!row.temporary || row.parentSessionId || openAnywhere(id)) return { deleted: false };
      await removeTemporary(row);
      return { deleted: true };
    },

    'chat.send': async ({ sessionId, parentId, parts }, ctx) => {
      await sessionOrThrow(sessionId, ctx);
      return { userMessageId: await chat.send(sessionId, parts, parentId) };
    },
    'chat.stop': async ({ sessionId }, ctx) => {
      await sessionOrThrow(sessionId, ctx);
      await chat.stop(sessionId);
      return { ok: true as const };
    },
    'chat.queue': async ({ sessionId, parts }, ctx) => {
      await sessionOrThrow(sessionId, ctx);
      return chat.queue(sessionId, parts);
    },
    'chat.unqueue': async ({ sessionId, id }, ctx) => {
      await sessionOrThrow(sessionId, ctx);
      return { parts: chat.unqueue(sessionId, id) };
    },
    'chat.sendNow': async ({ sessionId, id }, ctx) => {
      await sessionOrThrow(sessionId, ctx);
      await chat.sendNow(sessionId, id);
      return { ok: true as const };
    },
    'chat.retry': async ({ sessionId, messageId }, ctx) => {
      await sessionOrThrow(sessionId, ctx);
      await chat.retry(sessionId, messageId);
      return { ok: true as const };
    },
    'chat.continue': async ({ sessionId }, ctx) => {
      await sessionOrThrow(sessionId, ctx);
      await chat.continue(sessionId);
      return { ok: true as const };
    },
    'chat.edit': async ({ sessionId, messageId, parts }, ctx) => {
      await sessionOrThrow(sessionId, ctx);
      return { userMessageId: await chat.edit(sessionId, messageId, parts) };
    },
    'chat.switchBranch': async ({ sessionId, messageId }, ctx) => {
      await sessionOrThrow(sessionId, ctx);
      return chat.switchBranch(sessionId, messageId);
    },
    'chat.respond': async ({ sessionId, interactionId, answer }, ctx) => {
      await sessionOrThrow(sessionId, ctx);
      if (!chat.respond(sessionId, interactionId, answer)) throw appError('not_waiting', 'This question was already answered or the response stopped.');
      return { ok: true as const };
    },
    'sideChats.start': async ({ sessionId, question }, ctx) => {
      await sessionOrThrow(sessionId, ctx);
      if ((await sessions.getRow(sessionId))?.parentSessionId) throw appError('unsupported', 'Side chats start from a main session.');
      return chat.startSideChat(sessionId, question);
    },
    'sideChats.list': async ({ sessionId }, ctx) => {
      await sessionOrThrow(sessionId, ctx);
      return chat.sideChats(sessionId);
    },
    'tasks.output': async ({ sessionId, taskId, since }, ctx) => {
      await sessionOrThrow(sessionId, ctx);
      return chat.tasks.output(sessionId, taskId, since).catch((e: unknown) => {
        throw appError('not_found', (e as Error).message);
      });
    },
    'tasks.stop': async ({ sessionId, taskId }, ctx) => {
      await sessionOrThrow(sessionId, ctx);
      await chat.tasks.stop(sessionId, taskId).catch((e: unknown) => {
        throw appError('not_found', (e as Error).message);
      });
      return { ok: true as const };
    },
    'tasks.clear': async ({ sessionId }, ctx) => {
      await sessionOrThrow(sessionId, ctx);
      chat.tasks.clearFinished(sessionId);
      return { ok: true as const };
    },
    'loops.start': async ({ sessionId, prompt, intervalMs }, ctx) => {
      const session = await sessionOrThrow(sessionId, ctx);
      // A sub-agent's session runs once, for its parent.
      if (session.mode === 'chat' || (await sessions.getRow(sessionId))?.parentSessionId) throw appError('unsupported', 'Loops run in Code and Cowork sessions.');
      try {
        // At most LOOP_MAX_PER_SESSION in the session and LOOP_MAX_PER_USER of the person's.
        return chat.startLoop(sessionId, prompt, intervalMs, me(ctx).id);
      } catch (e) {
        if (e instanceof LoopLimitError) throw appError('limit', e.message);
        throw e;
      }
    },
    'loops.stop': async ({ sessionId, target }, ctx) => {
      await sessionOrThrow(sessionId, ctx);
      return { stopped: chat.stopLoops(sessionId, target) };
    },
    'checkpoints.list': async ({ sessionId }, ctx) => {
      await sessionOrThrow(sessionId, ctx);
      return checkpointStore.list(sessionId);
    },
    'checkpoints.rewind': async ({ sessionId, messageId, files, conversation }, ctx) => {
      const session = await sessionOrThrow(sessionId, ctx);
      if (chat.isRunning(sessionId)) throw appError('busy', 'Stop the response before rewinding.');
      const restored = files && session.workspaceId ? await checkpointStore.rewind(await openWorkspace(ctx, session.workspaceId), sessionId, messageId) : [];
      if (conversation) await chat.rewindTo(sessionId, messageId);
      return { restored, snapshot: await chat.snapshot(sessionId) };
    },
    'chat.compact': async ({ sessionId, focus }, ctx) => {
      await sessionOrThrow(sessionId, ctx);
      await chat.compact(sessionId, focus);
      return { ok: true as const };
    },
    'chat.contextBreakdown': async ({ sessionId }, ctx) => {
      await sessionOrThrow(sessionId, ctx);
      return { context: await chat.contextUsage(sessionId), usage: sessionUsage(db, sessionId) };
    },

    'server.updates': ({ refresh }) => serverUpdates?.status(refresh) ?? null,
    'server.update': () =>
      serverUpdateErrors(() => {
        if (!serverUpdates) throw appError('not_supported', 'This app updates itself: see Settings › System.');
        return serverUpdates.update();
      }),
    'instructions.get': async () => ({ content: (await fs.read(join(platform.configDir, 'AGENTS.md'))) ?? '' }),
    'instructions.set': async ({ content }) => {
      await fs.write(join(platform.configDir, 'AGENTS.md'), content);
      return { ok: true as const };
    },

    'skills.list': async ({ workspaceId }, ctx) => {
      const [{ skills }, installed] = await Promise.all([extensionsFor(me(ctx).id, workspaceId ?? null), installedSkills(skillTarget())]);
      return skills.map((s) => ({
        name: s.name,
        description: s.description,
        scope: s.scope,
        manualOnly: s.disableModelInvocation,
        warnings: s.warnings,
        installed: s.scope === 'global' && installed[s.name] ? { source: installed[s.name]!.source, sha: installed[s.name]!.sha, installedAt: installed[s.name]!.installedAt } : null,
      }));
    },
    'skills.install': ({ source, replace }) => installErrors(async () => ({ installed: await installSkills(source, skillTarget(), httpFetch, replace) })),
    'skills.uninstall': ({ name }) => installErrors(async () => (await uninstallSkill(name, skillTarget()), { ok: true as const })),
    'plugins.list': async () =>
      Promise.all(
        (await installedPlugins()).map(async (p) => {
          const own = (kind: 'skills' | 'commands' | 'agents') => pluginSources([{ ...p, enabled: true }], kind);
          const [skills, commands, agents] = await Promise.all([discoverSkills(own('skills')), discoverCommands(own('commands')), discoverAgents(own('agents'))]);
          const names = (items: { name: string }[]) => items.map((i) => i.name);
          return { id: p.id, name: p.name, description: p.description, version: p.version, source: p.source, enabled: p.enabled, skills: names(skills), commands: names(commands), agents: names(agents) };
        }),
      ),
    'usage.summary': ({ days, timezoneOffset, everyone }, ctx) => {
      if (everyone && me(ctx).role !== 'admin') throw appError('forbidden', 'Only admins can see everyone’s usage.');
      return usageSummary(db, { userId: everyone ? null : me(ctx).id, days, timezoneOffset });
    },
    'stats.summary': ({ mode, days, timezoneOffset }, ctx) => statsSummary(db, { userId: me(ctx).id, mode, days: days ?? null, timezoneOffset }),
    'privacy.export': async (_input, ctx) => {
      const blob = await blobs.put(await exportAll(db, blobs, me(ctx).id), 'application/zip');
      return { sha256: blob.sha256, name: `${APP.dirName.replace(/^\./, '')}-export-${new Date().toISOString().slice(0, 10)}.zip` };
    },
    'privacy.deleteConversations': async (_input, ctx) => {
      const ids = await conversationIds(db, me(ctx).id);
      await removeConversations(me(ctx).id, ids);
      await collectUnusedBlobs(db, blobs);
      return { deleted: ids.length };
    },
    'plugins.browse': ({ repo }) => installErrors(() => browseMarketplace(repo, httpFetch)),
    'plugins.install': ({ repo, plugin }) =>
      installErrors(async () => {
        const id = await installPlugin(repo, plugin, pluginTarget, httpFetch);
        const marketplace = id.slice(id.indexOf('@') + 1);
        await settings.set('global', ['extraKnownMarketplaces', marketplace], { source: { source: 'github', repo: repo.replace(/^https:\/\/github\.com\//, '').replace(/\.git$|\/$/g, '') } });
        return { id };
      }),
    'plugins.uninstall': ({ id }) => installErrors(async () => (await uninstallPlugin(id, pluginTarget), { ok: true as const })),
    'plugins.setEnabled': async ({ id, enabled }) => {
      await settings.set('global', ['enabledPlugins', id], enabled);
      return { ok: true as const };
    },
    'slash.list': async ({ workspaceId }, ctx) => {
      const { skills, commands } = await extensionsFor(me(ctx).id, workspaceId ?? null);
      return [
        ...skills.filter((s) => s.userInvocable).map((s) => ({ name: s.name, description: s.description, kind: 'skill' as const, ...(s.argumentHint ? { argumentHint: s.argumentHint } : {}) })),
        ...commands.filter((c) => !skills.some((s) => s.name === c.name)).map((c) => ({ name: c.name, description: c.description, kind: 'command' as const, ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}) })),
      ];
    },

    'workspaces.list': (_input, ctx) => workspaceManager.list(me(ctx).id),
    'workspaces.addLocal': async ({ path }, ctx) => {
      try {
        const added = await workspaceManager.addLocal(me(ctx).id, path, ctx.connection().deviceId);
        emitToUser(me(ctx).id, 'workspaces.changed', await workspaceManager.list(me(ctx).id));
        return added;
      } catch (e) {
        if (e instanceof WorkspaceError) throw appError('workspace_unavailable', e.message);
        throw e;
      }
    },
    'workspaces.addCodespace': ({ name, trust }, ctx) =>
      githubOp(async () => {
        const codespace = (await codespaces.list(me(ctx).id)).find((c) => c.name === name);
        if (!codespace) throw new GitHubError('That codespace no longer exists.');
        return addCodespaceFolder(me(ctx).id, codespace, trust === true);
      }),
    'workspaces.trust': async ({ id }, ctx) => {
      try {
        const trusted = await workspaceManager.trust(me(ctx).id, id);
        emitToUser(me(ctx).id, 'workspaces.changed', await workspaceManager.list(me(ctx).id));
        return trusted;
      } catch (e) {
        if (e instanceof WorkspaceError) throw appError('not_found', e.message);
        throw e;
      }
    },
    'codespaces.open': ({ repo, ref, trust }, ctx) =>
      githubOp(async () => addCodespaceFolder(me(ctx).id, await codespaces.open(me(ctx).id, { repo, ...(ref ? { ref } : {}) }), trust === true)),
    'github.repos': (_input, ctx) => githubOp(() => codespaces.repos(me(ctx).id)),
    'search.status': () => search.status(),
    // Remote clients use device codes: localhost callbacks would reach the client's machine, not this backend.
    'chatgptChat.status': async () => platform.chatgptChat ? { available: true, ...JSON.parse(await platform.chatgptChat.request('status')) as { signedIn: boolean } } : { available: false, signedIn: false },
    'chatgptChat.open': async () => {
      if (!platform.chatgptChat) throw new Error('ChatGPT Chat requires the desktop app.');
      await platform.chatgptChat.request('open');
      return { ok: true };
    },
    'chatgptChat.hide': async () => {
      await platform.chatgptChat?.request('hide');
      return { ok: true };
    },
    'chatgptChat.disconnect': async () => {
      await platform.chatgptChat?.request('disconnect');
      return { ok: true };
    },
    'chatgpt.status': () => chatgpt.status(),
    'chatgpt.signIn': async () => {
      try {
        return await (platform.surface === 'desktop' ? chatgpt.signIn() : chatgpt.signInDevice());
      } catch (e) {
        throw appError('chatgpt_sign_in_failed', e instanceof Error ? e.message : 'The sign-in could not start.');
      }
    },
    'chatgpt.cancel': async () => (chatgpt?.cancel(), { ok: true as const }),
    'chatgpt.signOut': async () => {
      await chatgpt?.signOut();
      // What was listed under the subscription goes with the sign-in.
      void registry.syncWithSettings().catch(() => undefined);
      return { ok: true as const };
    },
    // GitHub Copilot: the device flow polls in the backend (providers/copilot-auth.ts).
    'copilot.status': () => copilot.status(),
    'copilot.signIn': async () => {
      try {
        return await copilot.signIn();
      } catch (e) {
        throw appError('copilot_sign_in_failed', e instanceof Error ? e.message : 'The sign-in could not start.');
      }
    },
    'copilot.cancel': async () => (copilot.cancel(), { ok: true as const }),
    'copilot.signOut': async () => {
      await copilot.signOut();
      void registry.syncWithSettings().catch(() => undefined);
      return { ok: true as const };
    },
    'openrouter.connect': async (draft, ctx) => {
      const c = ctx.connection();
      try {
        // A browser's callback must carry the same person's cookie; a desktop app's system browser has none.
        return { url: await openrouter.start(draft, { userId: me(ctx).id, browser: c.client.clientKind === 'web', origin: c.origin }) };
      } catch (e) {
        throw appError('openrouter_connect_failed', e instanceof Error ? e.message : 'Connecting could not start.');
      }
    },
    'openrouter.status': async () => openrouter.status(),
    'openrouter.cancel': async () => (openrouter.cancel(), { ok: true as const }),
    'search.test': async (_input, ctx) => {
      try {
        const { engine, ms, results } = await search.test(ctx.signal);
        return { engine, ms, results: results.map((r) => ({ title: r.title, url: r.url })) };
      } catch (e) {
        throw appError('search_failed', e instanceof Error ? e.message : 'The search failed.');
      }
    },
    'github.status': (_input, ctx) => github.status(me(ctx).id),
    'github.connectToken': ({ token }, ctx) => githubOp(() => github.connectToken(me(ctx).id, token)),
    'github.deviceStart': (_input, ctx) => githubOp(() => github.deviceStart(me(ctx).id)),
    'github.devicePoll': ({ flowId }, ctx) => githubOp(() => github.devicePoll(me(ctx).id, flowId)),
    'github.disconnect': async (_input, ctx) => (await github.disconnect(me(ctx).id), { ok: true as const }),
    'codespaces.list': (_input, ctx) => githubOp(() => codespaces.list(me(ctx).id)),
    'codespaces.machines': ({ repo, ref }, ctx) => githubOp(() => codespaces.machines(me(ctx).id, repo, ref)),
    'codespaces.create': (input, ctx) => githubOp(() => codespaces.create(me(ctx).id, input)),
    'codespaces.start': ({ name }, ctx) => githubOp(async () => (await codespaces.start(me(ctx).id, name), { ok: true as const })),
    'codespaces.stop': ({ name }, ctx) => githubOp(async () => (await codespaces.stop(me(ctx).id, name), { ok: true as const })),
    'codespaces.delete': ({ name }, ctx) => githubOp(async () => (await codespaces.remove(me(ctx).id, name), { ok: true as const })),
    // SSH hosts are the desktop's: its own backend reads ~/.ssh/config, a server asks the person's desktop for its list.
    // The server's own ~/.ssh/config is nobody else's business.
    'workspaces.sshHosts': async (_input, ctx) => {
      if (platform.surface === 'desktop') return sshConfigHosts();
      const deviceId = callerDevice(ctx, 'ssh');
      if (!deviceId) return [];
      return links
        .request(me(ctx).id, deviceId, { op: 'ssh.hosts' })
        .then((v) => z.array(z.string()).parse(v))
        .catch(() => []);
    },
    'ssh.list': async (_input, ctx) => sshViews(me(ctx).id),
    'ssh.save': async (input, ctx) => {
      const userId = me(ctx).id;
      if (platform.surface !== 'desktop' && !callerDevice(ctx, 'ssh')) throw appError('forbidden', 'SSH connections are managed in the desktop app.');
      const { id, ...fields } = input;
      const list = (await prefs.get(userId)).ssh.connections;
      if (list.some((c) => c.id !== id && c.host.toLowerCase() === fields.host.toLowerCase())) throw appError('conflict', `${fields.host} is already one of your connections.`);
      const saved = { id: id && list.some((c) => c.id === id) ? id : newId(), ...fields };
      await prefs.set(userId, ['ssh', 'connections'], [...list.filter((c) => c.id !== saved.id), saved]);
      sshAccess.forget(userId);
      emitToUser(userId, 'prefs.changed', await prefs.get(userId));
      return (await sshViews(userId)).find((c) => c.id === saved.id)!;
    },
    'ssh.remove': async ({ id }, ctx) => {
      const userId = me(ctx).id;
      const list = (await prefs.get(userId)).ssh.connections;
      await prefs.set(userId, ['ssh', 'connections'], list.filter((c) => c.id !== id));
      await secrets.delete(sshSecretId(userId, id));
      sshAccess.forget(userId);
      emitToUser(userId, 'prefs.changed', await prefs.get(userId));
      return { ok: true as const };
    },
    'ssh.forgetPassword': async ({ id }, ctx) => {
      await secrets.delete(sshSecretId(me(ctx).id, id));
      sshAccess.forget(me(ctx).id);
      return { ok: true as const };
    },
    'ssh.test': async (input, ctx) => {
      const deviceId = callerDevice(ctx, 'ssh');
      if (platform.surface !== 'desktop' && !deviceId) throw appError('forbidden', 'SSH connections are managed in the desktop app.');
      const { id, ...fields } = input;
      return sshAccess.test(me(ctx).id, { ...fields, ...(id ? { id } : {}) }, deviceId ?? undefined);
    },
    'ssh.browse': async ({ host, path }, ctx) =>
      workspaceManager.browseRemote(me(ctx).id, host, path, callerDevice(ctx, 'ssh')).catch((e: unknown) => {
        throw e instanceof WorkspaceError || e instanceof SshError ? appError('workspace_unavailable', e.message) : e;
      }),
    'ssh.mkdir': async ({ host, parent, name }, ctx) =>
      workspaceManager.createRemoteFolder(me(ctx).id, host, parent, name, callerDevice(ctx, 'ssh')).then(
        (path) => ({ path }),
        (e: unknown) => {
          throw e instanceof WorkspaceError || e instanceof SshError ? appError('workspace_unavailable', e.message) : e;
        },
      ),
    'ssh.answer': async (answer, ctx) => {
      const waiting = sshWaiting.get(answer.id);
      if (!waiting || waiting.userId !== me(ctx).id) throw appError('not_waiting', 'That question was already answered.');
      sshWaiting.delete(answer.id);
      waiting.resolve(answer);
      return { ok: true as const };
    },
    'workspaces.addSsh': async ({ host, path }, ctx) => {
      try {
        const added = await workspaceManager.addSsh(me(ctx).id, host, path, callerDevice(ctx, 'ssh'));
        emitToUser(me(ctx).id, 'workspaces.changed', await workspaceManager.list(me(ctx).id));
        return added;
      } catch (e) {
        if (e instanceof WorkspaceError || e instanceof SshError) throw appError('workspace_unavailable', e.message);
        throw e;
      }
    },
    'workspaces.remove': async ({ id }, ctx) => {
      await workspaceManager.remove(me(ctx).id, id);
      emitToUser(me(ctx).id, 'workspaces.changed', await workspaceManager.list(me(ctx).id));
      return { ok: true as const };
    },
    'workspaces.files': async ({ workspaceId, dir }, ctx) => listDir(await openWorkspace(ctx, workspaceId), dir),
    'workspaces.findFiles': async ({ workspaceId, query }, ctx) => findFiles(await openWorkspace(ctx, workspaceId), query),
    'workspaces.readFile': async ({ workspaceId, path }, ctx) => readWorkspaceFile(await openWorkspace(ctx, workspaceId), path),
    'workspaces.fileBytes': async ({ workspaceId, path }, ctx) =>
      fileBytes(await openWorkspace(ctx, workspaceId), path).catch((e: unknown) => {
        throw e instanceof FileBytesError ? appError('file_unavailable', e.message) : e;
      }),
    'workspaces.gitStatus': async ({ workspaceId }, ctx) => gitStatus(await openWorkspace(ctx, workspaceId)),
    'workspaces.diff': async ({ workspaceId, path, compare = 'head', sessionId }, ctx) => {
      const ws = await openWorkspace(ctx, workspaceId);
      if (compare !== 'session') return gitDiff(ws, path, compare);
      if (!sessionId) throw appError('invalid_request', 'Say which session’s changes to show.');
      await sessionOrThrow(sessionId, ctx);
      return sessionDiff(ws, await checkpointStore.firstVersions(sessionId), path);
    },
    'workspaces.grep': async ({ workspaceId, query }, ctx) => grepFiles(await openWorkspace(ctx, workspaceId), query),
    'git.branches': ({ workspaceId }, ctx) => gitOp(ctx, workspaceId, (ws) => git.branches(ws)),
    'git.checkout': ({ workspaceId, branch, create }, ctx) => gitOp(ctx, workspaceId, async (ws) => (await git.checkout(ws, branch, create), { ok: true as const })),
    'git.stage': ({ workspaceId, paths, staged }, ctx) => gitOp(ctx, workspaceId, async (ws) => (await git.stage(ws, paths, staged), { ok: true as const })),
    'git.commit': ({ workspaceId, message }, ctx) =>
      gitOp(ctx, workspaceId, async (ws) => {
        const { authorName, authorEmail } = (await prefs.get(me(ctx).id)).git;
        return { commit: await git.commit(ws, message, { name: authorName, email: authorEmail }) };
      }),
    'git.revertHunk': ({ workspaceId, patch }, ctx) => gitOp(ctx, workspaceId, async (ws) => (await git.revertPatch(ws, patch), { ok: true as const })),
    'git.push': ({ workspaceId }, ctx) => gitOp(ctx, workspaceId, async (ws) => (await git.push(ws), { ok: true as const })),
    'git.pullRequest': ({ workspaceId, title, body, base }, ctx) =>
      gitOp(ctx, workspaceId, async (ws) => ({ url: await git.createPullRequest(ws, { title, body, ...(base ? { base } : {}) }) })),
    'terminals.open': async ({ workspaceId, cols, rows, dir }, ctx) => ({
      terminalId: await terminals.open(ctx.connection(), me(ctx).id, await openWorkspace(ctx, workspaceId), { cols, rows }, dir),
    }),
    'terminals.attach': ({ terminalId, since }, ctx) => {
      try {
        return terminals.attach(ctx.connection(), me(ctx).id, terminalId, since);
      } catch (e) {
        throw appError('not_found', (e as Error).message);
      }
    },
    'terminals.write': async ({ terminalId, data }, ctx) => {
      await terminals.write(ctx.connection(), terminalId, data);
      return { ok: true as const };
    },
    'terminals.resize': async ({ terminalId, cols, rows }, ctx) => {
      await terminals.resize(ctx.connection(), terminalId, cols, rows);
      return { ok: true as const };
    },
    'terminals.close': async ({ terminalId }, ctx) => {
      await terminals.close(ctx.connection(), terminalId);
      return { ok: true as const };
    },

    'files.upload': async ({ name, mime, dataBase64, sessionId }, ctx) => {
      if (sessionId) await sessionOrThrow(sessionId, ctx);
      return files.upload({ name, mime, bytes: new Uint8Array(Buffer.from(dataBase64, 'base64')), kind: 'upload', userId: me(ctx).id, sessionId: sessionId ?? null });
    },
    'files.get': async ({ id }, ctx) => {
      const row = await fileOrThrow(id, ctx);
      return { id: row.id, name: row.name, mime: row.mime, size: row.size, blob: row.blob, kind: row.kind, tokens: row.tokens, createdAt: row.createdAt };
    },
    'files.extractText': async ({ id }, ctx) => {
      const row = await fileOrThrow(id, ctx);
      if (!canExtractText(row.mime)) throw appError('unsupported', 'This file type has no text to extract.');
      return files.text(row, 200_000);
    },

    'projects.list': (_input, ctx) => projects.list(me(ctx).id),
    'projects.get': async ({ id }, ctx) => {
      await projectOrThrow(id, ctx);
      return { ...(await projects.get(id))!, files: await files.forProject(id) };
    },
    'projects.create': async (input, ctx) => {
      const p = await projects.create({ ...input, userId: me(ctx).id });
      emitToUser(me(ctx).id, 'projects.changed', {});
      return p;
    },
    'projects.update': async ({ id, ...patch }, ctx) => {
      await projectOrThrow(id, ctx);
      const p = await projects.update(id, patch);
      emitToUser(me(ctx).id, 'projects.changed', {});
      return p;
    },
    'projects.delete': async ({ id }, ctx) => {
      await projectOrThrow(id, ctx);
      await projects.delete(id);
      emitToUser(me(ctx).id, 'projects.changed', {});
      return { ok: true as const };
    },
    'projects.addFile': async ({ projectId, fileId }, ctx) => {
      await projectOrThrow(projectId, ctx);
      await fileOrThrow(fileId, ctx);
      const ref = await files.attachToProject(fileId, projectId);
      await projects.touch(projectId);
      emitToUser(me(ctx).id, 'projects.changed', {});
      return ref;
    },
    'projects.removeFile': async ({ projectId, fileId }, ctx) => {
      await projectOrThrow(projectId, ctx);
      await files.removeFromProject(projectId, fileId);
      emitToUser(me(ctx).id, 'projects.changed', {});
      return { ok: true as const };
    },

    'mcp.status': (_input, ctx) => mcpStatusFor(ctx.connection(), mcp.status()),
    'mcp.test': async ({ name }) => {
      const status = await mcp.test(name);
      if (!status) throw appError('not_found', `There is no connector named ${name}.`);
      return status;
    },
    'mcp.logs': ({ name }) => {
      const lines = mcp.logs(name);
      if (!lines) throw appError('not_found', `There is no connector named ${name}.`);
      return { lines };
    },
    'mcp.signIn': ({ name }, ctx) =>
      signInError(async () => {
        const c = ctx.connection();
        // A browser's callback must carry the same person's cookie; a desktop app's system browser has none.
        return { url: await mcp.signIn(name, { userId: me(ctx).id, browser: c.client.clientKind === 'web', origin: c.origin }) };
      }),
    'mcp.cancelSignIn': ({ name }) => (mcp.cancelSignIn(name), { ok: true as const }),
    'mcp.signOut': async ({ name }) => (await mcp.signOut(name), { ok: true as const }),
    'developer.requests': () => inspector.list(),
    'developer.clearRequests': () => (inspector.clear(), { ok: true as const }),
    'developer.reload': () => {
      mcp.restart();
      for (const c of connections) if (c.auth) c.rpc.emit('extensions.changed', {});
      return { ok: true as const };
    },
    'mcp.import': async (_input, ctx) => {
      if (platform.surface !== 'desktop') throw appError('unsupported', 'Importing from Claude Code works in the desktop app, where its settings live.');
      // Shared project servers come from `.mcp.json` in the folders this person opened on this computer.
      const folders = (await workspaceManager.list(me(ctx).id)).filter((w) => w.kind === 'local' && !w.deviceId).map((w) => w.root);
      return importClaudeCode(homedir(), folders);
    },

    'artifacts.list': async ({ sessionId }, ctx) => {
      await sessionOrThrow(sessionId, ctx);
      return artifacts.list(sessionId);
    },
    'artifacts.get': async ({ id, version }, ctx) => {
      const a = await artifacts.get(id, version);
      if (!a) throw appError('not_found', 'Artifact not found.');
      await sessionOrThrow(a.summary.sessionId, ctx);
      return { ...a.summary, content: a.content };
    },
    'artifacts.listAll': (page, ctx) => artifacts.listForUser(me(ctx).id, page),

    'memory.list': async (_input, ctx) => ({ entries: await memory.repo.list(me(ctx).id) }),
    'memory.get': async ({ id }, ctx) => {
      const entry = await memory.repo.get(me(ctx).id, id);
      if (!entry) throw appError('not_found', 'That memory no longer exists.');
      return entry;
    },
    'memory.delete': async ({ id }, ctx) => {
      const userId = me(ctx).id;
      if (!(await memory.repo.delete(userId, id))) throw appError('not_found', 'That memory no longer exists.');
      emitToUser(userId, 'memory.changed', {});
      return { ok: true as const };
    },
    'memory.instruct': ({ text, entryId, section, model }, ctx) =>
      memoryErrors(async () => ({ changes: await memory.instruct(me(ctx).id, text, { ...(entryId ? { entryId } : {}), ...(section ? { section } : {}) }, model ? { model } : {}) })),
    'memory.update': ({ id, section, ...patch }, ctx) => memoryErrors(() => memory.edit(me(ctx).id, { ...(id ? { id } : {}), ...(section ? { section } : {}) }, patch)),
    'memory.import': ({ text, model }, ctx) => memoryErrors(async () => ({ changes: await memory.import(me(ctx).id, text, model ? { model } : {}) })),
  };

  /** Every procedure passes this gate: sign-in, admin role, and a forced password change come first. */
  const guarded = Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [
      name,
      async (input: never, ctx: Ctx & { signal: AbortSignal }) => {
        const c = ctx.connection();
        await c.ready;
        const method = name as keyof AppContract['procedures'];
        if (screenLock.locked && !LOCKED_PROCEDURES.has(method)) throw appError('locked', 'Atelier is locked. Unlock it to continue.');
        if (!PUBLIC_PROCEDURES.has(method)) {
          if (!c.auth) throw appError('unauthenticated', 'Sign in to continue.');
          if (c.auth.user.mustChangePassword && !method.startsWith('account.') && method !== 'auth.logout' && method !== 'prefs.get') {
            throw appError('password_change_required', 'Choose a new password to continue.');
          }
          if (ADMIN_PROCEDURES.has(method) && c.auth.user.role !== 'admin') throw appError('forbidden', 'Only admins can do this.');
        }
        return (handler as unknown as (i: never, x: Ctx & { signal: AbortSignal }) => unknown)(input, ctx);
      },
    ]),
  ) as unknown as Handlers<AppContract, Ctx>;

  return {
    accounts,
    authenticate: (token) => accounts.authenticate(token),
    connect(transport, options) {
      // Handlers reach their connection through the context; the RPC endpoint is attached right after.
      const connection = { subscriptions: new Set(), client: options.client, auth: null, deviceId: options.client.deviceId ?? null, origin: options.origin } as unknown as Connection;
      connection.ready = options.token
        ? accounts.authenticate(options.token).then((auth) => void (connection.auth = auth), () => undefined)
        : Promise.resolve();
      const rpc = serveRpc(contract, guarded, transport, { connection: () => connection }, (method, error) => platform.logger.error(`rpc ${method} failed`, error));
      connection.rpc = rpc;
      connections.add(connection);
      return () => {
        rpc.close();
        connections.delete(connection);
        const open = [...connection.subscriptions];
        if (open.length) afterGrace(async () => {
          for (const id of open) {
            const row = await sessions.getRow(id);
            if (row?.temporary && !row.parentSessionId && !openAnywhere(id)) await removeTemporary(row);
          }
        });
        // Its terminals wait a few minutes for the same person to attach them again (a reload, a dropped socket).
        terminals.detachAll(connection);
      };
    },
    async logout(sessionId) {
      await accounts.logout(sessionId);
      signOutWhere((c) => c.auth?.sessionId === sessionId);
    },
    async removeScreenLock() {
      if (!local) return;
      lockChanged(await screenLock.removeTrusted());
    },
    finishSignIn: (params, userId) => (openrouter.owns(params) ? openrouter.finish(params, userId) : mcp.finishSignIn(params, userId)),
    async readBlob(sha256) {
      const info = await blobs.info(sha256);
      if (!info) return undefined;
      return { bytes: await blobs.read(sha256), mime: info.mime };
    },
    passkeys,
    async linkDevice(socket, token, device) {
      const auth = await accounts.authenticate(token);
      if (!auth || auth.user.mustChangePassword) return null;
      await devices.register(auth.user.id, device);
      return links.attach(auth.user.id, device.id, socket);
    },
    async dispose() {
      clearInterval(cleanupTimer);
      clearInterval(temporaryTimer);
      for (const timer of graceTimers) clearTimeout(timer);
      openrouter.cancel();
      chatgpt.dispose();
      links.closeAll();
      await chat.stopAll();
      memory.dispose();
      await terminals.closeAll();
      await mcp.close();
      await workspaceManager.disposeAll();
      stopPromptWatch();
      stopExtensionWatch();
      settings.unwatch();
      for (const c of connections) c.rpc.close();
      connections.clear();
      db.$client.close();
    },
  };
}
