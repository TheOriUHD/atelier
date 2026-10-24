/** The UI ↔ backend contract. Methods are added here in the milestone that implements them. */
import { z } from 'zod';
import {
  InspectedRequest,
  AppInfo,
  ArtifactListItem,
  ArtifactSummary,
  ArtifactType,
  ArtifactVersion,
  CodespaceMachine,
  CodespaceSummary,
  GitHubRepo,
  ContextUsage,
  DiffCompare,
  ElicitationAnswer,
  FileRef,
  GitStatus,
  PluginSummary,
  SkillSummary,
  StatsSummary,
  UsageRow,
  PermissionAnswer,
  QuestionAnswer,
  Project,
  RunEvent,
  SecretSummary,
  SessionSnapshot,
  SessionGroup,
  SessionSummary,
  SessionUsage,
  SettingsSnapshot,
  WorkspaceEntry,
  WorkspaceFile,
  WorkspaceSummary,
} from '../domain.ts';
import { McpImportEntry, McpServerName, McpServerStatus, PersonalConnector, PersonalConnectorInput, PersonalConnectorView } from '../mcp.ts';
import { MEMORY_DETAILS_MAX, MEMORY_SUMMARY_MAX, MEMORY_TITLE_MAX, MemoryChange, MemoryEntry, MemorySection } from '../memory.ts';
import { LOOP_MAX_INTERVAL_MS } from '../loops.ts';
import { ServerUpdateStatus } from '../versions.ts';
import { Part } from '../messages.ts';
import { SshAnswer, SshConnectionInput, SshConnectionView, SshPrompt, SshTestResult } from '../ssh.ts';
import { Effort, ModelInfo, ProviderStatus, ProviderType } from '../models.ts';
import { LocalServer, PersonalProvider, PersonalProviderDraft } from '../personal-providers.ts';
import { Mode, PermissionMode, ProviderConfig, SettingsLayer, SettingsPath } from '../settings.ts';
import {
  AuthSessionSummary,
  AuthStatus,
  AutoLockMinutes,
  ClientKind,
  DeviceSummary,
  InviteSummary,
  NewScreenLock,
  PasskeySummary,
  Password,
  SafeguardsOverride,
  ScreenLockStatus,
  UserPrefs,
  UserRole,
  UserSummary,
  Username,
} from '../accounts.ts';
import type { Contract } from './jsonrpc.ts';

const Empty = z.object({});
const Ok = z.object({ ok: z.literal(true) });
const Id = z.object({ id: z.string() });
const TerminalSize = z.number().int().min(2).max(1000);
const ChatGptLimit = z.object({ usedPercent: z.number(), windowMinutes: z.number().nullable(), resetsAt: z.number().nullable() });
const ChatGptStatus = z.object({
  /** This backend can sign in with a ChatGPT subscription. */
  available: z.boolean(),
  signedIn: z.boolean(),
  /** A sign-in is open in the browser. */
  signingIn: z.boolean(),
  /** A server sign-in's one-time code and verification page. */
  device: z.object({ url: z.string(), userCode: z.string() }).optional(),
  email: z.string().optional(),
  plan: z.string().optional(),
  /** Why the last sign-in or refresh failed. */
  error: z.string().optional(),
  /** The plan's usage windows as the last reply reported them. */
  limits: z.object({ primary: ChatGptLimit.optional(), secondary: ChatGptLimit.optional() }).optional(),
});
const CopilotStatus = z.object({
  signedIn: z.boolean(),
  /** A device sign-in is waiting for the code to be entered on GitHub. */
  signingIn: z.boolean(),
  /** The GitHub account signed in. */
  login: z.string().optional(),
  /** While signing in: the code to enter and where. */
  userCode: z.string().optional(),
  verificationUri: z.string().optional(),
  expiresAt: z.number().optional(),
  /** Why the last sign-in or token exchange failed. */
  error: z.string().optional(),
});

const OpenRouterStatus = z.object({
  /** The connect page is open in the browser. */
  connecting: z.boolean(),
  /** The provider the last connect saved. */
  provider: ProviderConfig.optional(),
  /** Why the last connect failed. */
  error: z.string().optional(),
});

const SearchStatus = z.object({
  mode: z.enum(['auto', 'searxng', 'brave', 'tavily']),
  engines: z.array(z.object({ id: z.string(), name: z.string(), kind: z.enum(['web', 'news', 'dev']), state: z.enum(['ok', 'limited', 'unknown']), retryAt: z.number().optional(), lastOkAt: z.number().optional() })),
});

const Repo = z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'Use owner/repo.');

export const DetectedProvider = z.object({
  type: ProviderType,
  baseUrl: z.string(),
  label: z.string(),
  /** Where it was found: a local port probe or an environment variable. */
  via: z.enum(['port', 'env']),
  envVar: z.string().optional(),
});
export type DetectedProvider = z.infer<typeof DetectedProvider>;

/** Provider config as entered in the wizard: the key is passed raw and stored in the secret store by the backend. */
export const ProviderDraft = ProviderConfig.omit({ apiKey: true }).extend({
  apiKey: z.string().optional(),
  /** Import the key from this environment variable instead of a raw value. */
  apiKeyFromEnv: z.string().optional(),
});
export type ProviderDraft = z.infer<typeof ProviderDraft>;

/** A personal ChatGPT Chat provider's computer; without an id, the desktop app the call comes from. */
const PersonalChatGpt = z.object({ providerId: z.string().optional() });

const SignedIn = z.object({ token: z.string(), user: UserSummary });
const Credentials = z.object({ username: Username, password: z.string().min(1).max(256) });
const NewAccount = z.object({ username: Username, name: z.string().trim().min(1).max(80), password: Password });

export const contract = {
  procedures: {
    'app.info': { input: Empty, output: AppInfo },

    // Public: allowed before sign-in. The returned token is for clients that keep their own (desktop);
    // browsers sign in over HTTP and get an HttpOnly cookie instead.
    'auth.status': { input: Empty, output: AuthStatus },
    /** The first account. Servers also require the one-time setup token printed to their log. */
    'auth.setup': { input: NewAccount.extend({ clientKind: ClientKind, setupToken: z.string().optional() }), output: SignedIn },
    'auth.login': { input: Credentials.extend({ clientKind: ClientKind }), output: SignedIn },
    /** Whether an invite code (or an older invite link's token) is open, before the account form; wrong ones count against the address. */
    'auth.checkInvite': { input: z.object({ invite: z.string().min(1).max(200) }), output: Ok },
    'auth.acceptInvite': { input: NewAccount.extend({ invite: z.string().min(16).max(200), clientKind: ClientKind }), output: SignedIn },
    'auth.signup': { input: NewAccount, output: z.object({ pending: z.literal(true) }) },
    'auth.logout': { input: Empty, output: Ok },
    /** "Run on this computer" only: the first account from a name alone (no password; the username is derived). */
    'auth.setupLocal': { input: z.object({ name: z.string().trim().min(1).max(80), clientKind: ClientKind }), output: SignedIn },
    /** "Run on this computer" only: signs the owner in without a password (the backend is reachable only through the app). */
    'auth.localSignIn': { input: z.object({ clientKind: ClientKind }), output: SignedIn },

    // The screen lock of "Run on this computer" (status and unlock are public, so a locked app can ask).
    'lock.status': { input: Empty, output: ScreenLockStatus },
    'lock.unlock': { input: z.object({ secret: z.string().min(1).max(256) }), output: ScreenLockStatus },
    'lock.lock': { input: Empty, output: ScreenLockStatus },
    /** Sets or replaces the PIN or password; `current` is required while one is set. */
    'lock.set': { input: z.object({ lock: NewScreenLock, current: z.string().max(256).optional() }), output: ScreenLockStatus },
    'lock.clear': { input: z.object({ current: z.string().min(1).max(256) }), output: ScreenLockStatus },
    'lock.setAutoLock': { input: z.object({ minutes: AutoLockMinutes }), output: ScreenLockStatus },

    'account.get': { input: Empty, output: UserSummary },
    'account.update': { input: z.object({ name: z.string().trim().min(1).max(80).optional(), avatar: z.string().nullable().optional() }), output: UserSummary },
    'account.changePassword': { input: z.object({ current: z.string().min(1).max(256), next: Password }), output: Ok },
    'account.sessions': { input: Empty, output: z.array(AuthSessionSummary) },
    'account.revokeSession': { input: Id, output: Ok },
    'account.logoutEverywhere': { input: Empty, output: Ok },
    /** The person's passkeys (added and used through the web sign-in routes). */
    'account.passkeys': { input: Empty, output: z.array(PasskeySummary) },
    'account.removePasskey': { input: Id, output: Ok },
    'account.devices': { input: Empty, output: z.array(DeviceSummary) },
    'account.removeDevice': { input: Id, output: Ok },
    /** Desktop apps register the machine they run on for the signed-in user. */
    'devices.register': { input: z.object({ id: z.string().uuid(), name: z.string().min(1).max(120), platform: z.string().min(1).max(40) }), output: DeviceSummary },

    'prefs.get': { input: Empty, output: UserPrefs },
    'prefs.set': { input: z.object({ path: SettingsPath, value: z.unknown() }), output: UserPrefs },
    'prefs.reset': { input: z.object({ path: SettingsPath }), output: UserPrefs },

    // Admin only (see ADMIN_PROCEDURES).
    'users.list': { input: Empty, output: z.array(UserSummary) },
    'users.create': {
      input: z.object({ username: Username, name: z.string().trim().min(1).max(80), role: UserRole.exclude(['pending']) }),
      output: z.object({ user: UserSummary, temporaryPassword: z.string() }),
    },
    'users.update': {
      input: z.object({ id: z.string(), name: z.string().trim().min(1).max(80).optional(), role: UserRole.optional(), disabled: z.boolean().optional(), safeguards: SafeguardsOverride.optional() }),
      output: UserSummary,
    },
    'users.resetPassword': { input: Id, output: z.object({ temporaryPassword: z.string() }) },
    'users.delete': { input: Id, output: Ok },
    'invites.list': { input: Empty, output: z.array(InviteSummary) },
    'invites.create': { input: z.object({ role: z.enum(['admin', 'user']) }), output: z.object({ invite: InviteSummary, code: z.string() }) },
    'invites.revoke': { input: Id, output: Ok },
    /** This server's version, the newest published one and how to update (null on the desktop app's own backend). `refresh` skips the 10-minute cache. */
    'server.updates': { input: z.object({ refresh: z.boolean().optional() }), output: ServerUpdateStatus.nullable() },
    /** Asks the compose file's updater service to pull the images and recreate the server; progress shows in `server.updates`. */
    'server.update': { input: Empty, output: ServerUpdateStatus },
    /** The system AGENTS.md: instructions every Code and Work session on this backend follows. */
    'instructions.get': { input: Empty, output: z.object({ content: z.string() }) },
    'instructions.set': { input: z.object({ content: z.string().max(60_000) }), output: Ok },

    'settings.get': { input: Empty, output: SettingsSnapshot },
    'settings.set': { input: z.object({ layer: SettingsLayer.default('global'), path: SettingsPath, value: z.unknown() }), output: Ok },
    'settings.reset': { input: z.object({ layer: SettingsLayer, path: SettingsPath }), output: Ok },

    'secrets.list': { input: Empty, output: z.array(SecretSummary) },
    /** Stores (or rotates) a secret; returns its masked summary. The value never comes back. */
    'secrets.set': {
      input: z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), label: z.string().min(1).max(120), kind: SecretSummary.shape.kind, value: z.string().min(1).max(10_000) }),
      output: SecretSummary,
    },
    'secrets.delete': { input: Id, output: Ok },

    /**
     * "Sign in with ChatGPT": desktop browser OAuth or a server device code, through the sign-in OpenAI's Codex uses.
     * `signIn` returns the address to open and, on servers, a code to enter; its result shows in `status`.
     */
    'chatgptChat.status': { input: Empty, output: z.object({ available: z.boolean(), signedIn: z.boolean() }) },
    'chatgptChat.open': { input: Empty, output: Ok },
    'chatgptChat.hide': { input: Empty, output: Ok },
    'chatgptChat.disconnect': { input: Empty, output: Ok },
    'chatgpt.status': { input: Empty, output: ChatGptStatus },
    'chatgpt.signIn': { input: Empty, output: z.object({ url: z.string(), userCode: z.string().optional() }) },
    'chatgpt.cancel': { input: Empty, output: Ok },
    'chatgpt.signOut': { input: Empty, output: Ok },
    /**
     * "Sign in with GitHub" for GitHub Copilot (desktop and server): the device flow, so no redirect is needed. `signIn`
     * returns the code to enter at `verificationUri`; the backend polls GitHub and the result shows in `status`.
     */
    'copilot.status': { input: Empty, output: CopilotStatus },
    'copilot.signIn': { input: Empty, output: z.object({ userCode: z.string(), verificationUri: z.string(), expiresAt: z.number() }) },
    'copilot.cancel': { input: Empty, output: Ok },
    'copilot.signOut': { input: Empty, output: Ok },
    /**
     * "Connect with OpenRouter": its OAuth PKCE flow mints a key in the person's account, and the drafted provider is
     * saved with it. `connect` returns the address to open; the result shows in `status`.
     */
    'openrouter.connect': { input: ProviderDraft.omit({ apiKey: true, apiKeyFromEnv: true }), output: z.object({ url: z.string() }) },
    'openrouter.status': { input: Empty, output: OpenRouterStatus },
    'openrouter.cancel': { input: Empty, output: Ok },
    'providers.status': { input: Empty, output: z.array(ProviderStatus) },
    'providers.detect': { input: Empty, output: z.array(DetectedProvider) },
    'providers.test': { input: ProviderDraft, output: z.object({ status: ProviderStatus, models: z.array(ModelInfo) }) },
    'providers.save': { input: ProviderDraft, output: ProviderConfig },
    'providers.remove': { input: Id, output: Ok },
    'providers.refresh': { input: z.object({ id: z.string().optional() }), output: z.array(ProviderStatus) },
    'models.list': { input: Empty, output: z.array(ModelInfo) },
    'models.probeTools': { input: z.object({ ref: z.string() }), output: z.object({ native: z.boolean(), detail: z.string() }) },
    /**
     * The caller's personal providers (personal-providers.ts): their own model servers and ChatGPT Chat, on their
     * computers. `detect`, `test` and adding one run on the desktop app the call comes from, which lends the address
     * (or its ChatGPT window) first, under the draft's id. The ChatGPT Chat calls go to that provider's computer, or
     * without one to the calling desktop (signing in before it is added).
     */
    'personalProviders.list': { input: Empty, output: z.array(PersonalProvider) },
    'personalProviders.detect': { input: Empty, output: z.array(LocalServer) },
    'personalProviders.test': { input: PersonalProviderDraft, output: z.object({ status: ProviderStatus, models: z.array(ModelInfo) }) },
    'personalProviders.save': { input: PersonalProviderDraft, output: PersonalProvider },
    'personalProviders.remove': { input: Id, output: Ok },
    'personalProviders.refresh': { input: z.object({ id: z.string().optional() }), output: z.array(PersonalProvider) },
    'personalProviders.probeTools': { input: z.object({ ref: z.string() }), output: z.object({ native: z.boolean(), detail: z.string() }) },
    'personalProviders.chatgptChat.status': { input: PersonalChatGpt, output: z.object({ available: z.boolean(), signedIn: z.boolean() }) },
    'personalProviders.chatgptChat.open': { input: PersonalChatGpt, output: Ok },
    'personalProviders.chatgptChat.hide': { input: PersonalChatGpt, output: Ok },
    'personalProviders.chatgptChat.disconnect': { input: PersonalChatGpt, output: Ok },

    'sessions.list': {
      input: z.object({
        mode: Mode.optional(),
        projectId: z.string().optional(),
        query: z.string().optional(),
        /** Archived sessions are left out unless asked for. */
        archived: z.enum(['active', 'archived', 'all']).default('active'),
        limit: z.number().int().positive().max(500).default(200),
      }),
      output: z.array(SessionSummary),
    },
    'sessions.create': {
      input: z.object({
        mode: Mode,
        projectId: z.string().optional(),
        model: z.string().optional(),
        effort: Effort.nullable().optional(),
        thinking: z.boolean().optional(),
        remoteControl: z.boolean().optional(),
        /** Code and Work sessions run in a workspace. */
        workspaceId: z.string().optional(),
        /**
         * Code and Work sessions with no folder (instead of `workspaceId`): each runs in a new, empty scratch folder,
         * made on this computer (the desktop's own backend) or under `~/.atelier/scratch-workspaces` on `sshHost`.
         */
        scratch: z.object({ sshHost: z.string().min(1).max(255).optional() }).optional(),
        permissionMode: PermissionMode.optional(),
        connectorsOff: z.array(McpServerName).max(200).optional(),
        research: z.boolean().optional(),
        /** File the new session under one of the person's sidebar groups. */
        groupId: z.string().optional(),
        /** A temporary chat (Chat only), private as the person's `privacy.temporaryChats` says. */
        temporary: z.boolean().optional(),
      }),
      output: SessionSummary,
    },
    'sessions.update': {
      input: z.object({
        id: z.string(),
        title: z.string().min(1).max(200).optional(),
        pinned: z.boolean().optional(),
        model: z.string().optional(),
        effort: Effort.nullable().optional(),
        thinking: z.boolean().optional(),
        remoteControl: z.boolean().optional(),
        projectId: z.string().nullable().optional(),
        permissionMode: PermissionMode.optional(),
        /** Takes effect from the next turn (and restarts the prompt cache, like any change of tools). */
        connectorsOff: z.array(McpServerName).max(200).optional(),
        /** Takes effect from the next message. */
        research: z.boolean().optional(),
        /** A sidebar group of the person's (null: ungrouped). Doesn't count as activity. */
        groupId: z.string().nullable().optional(),
        /** Puts it away (true) or brings it back (false). Doesn't count as activity. */
        archived: z.boolean().optional(),
        /** Marks it as having news (the blue dot) until it is opened again. */
        unread: z.boolean().optional(),
      }),
      output: SessionSummary,
    },
    /** A copy of a session's conversation (the branch it is on) as a new session in the same folder. */
    'sessions.fork': { input: Id, output: SessionSummary },
    /** A chat continued as a Cowork task: the same conversation, in the chat's sandbox folder when it has one. */
    'sessions.continueInCowork': { input: Id, output: SessionSummary },
    'groups.list': { input: Empty, output: z.array(SessionGroup) },
    'groups.create': { input: z.object({ name: z.string().trim().min(1).max(80) }), output: SessionGroup },
    'groups.update': {
      input: z.object({ id: z.string(), name: z.string().trim().min(1).max(80).optional(), collapsed: z.boolean().optional() }),
      output: SessionGroup,
    },
    /** Its sessions become ungrouped; none is deleted. */
    'groups.delete': { input: Id, output: Ok },
    /** The person has looked at a session whose turn finished meanwhile: its sidebar dot goes back to idle. */
    'sessions.markSeen': { input: Id, output: Ok },
    'sessions.delete': { input: Id, output: Ok },
    'sessions.subscribe': { input: Id, output: SessionSnapshot },
    'sessions.unsubscribe': { input: Id, output: Ok },
    /**
     * The person left a session: it is unsubscribed, and a temporary chat that no other window has open is deleted
     * (`deleted`). For other sessions it is the same as `sessions.unsubscribe`.
     */
    'sessions.leave': { input: Id, output: z.object({ deleted: z.boolean() }) },

    'chat.send': {
      input: z.object({ sessionId: z.string(), parentId: z.string().nullable().optional(), parts: z.array(Part).min(1) }),
      output: z.object({ userMessageId: z.string() }),
    },
    'chat.stop': { input: z.object({ sessionId: z.string() }), output: Ok },
    /**
     * Sends a message while the agent works: it is shown as waiting, joins the conversation at the agent's next step,
     * and can be taken back (`chat.unqueue`) or sent at once (`chat.sendNow`). When no run is going it is a plain send.
     */
    'chat.queue': { input: z.object({ sessionId: z.string(), parts: z.array(Part).min(1) }), output: z.object({ id: z.string(), queued: z.boolean() }) },
    /** Takes a waiting message back; its parts, or none when the agent already took it. */
    'chat.unqueue': { input: z.object({ sessionId: z.string(), id: z.string() }), output: z.object({ parts: z.array(Part) }) },
    /** Interrupts the agent's current step and sends this waiting message now; the agent carries on from there. */
    'chat.sendNow': { input: z.object({ sessionId: z.string(), id: z.string() }), output: Ok },
    'chat.retry': { input: z.object({ sessionId: z.string(), messageId: z.string() }), output: Ok },
    /** Carries on with a reply a restart cut off: what it had done stays, and the model hears that it was cut off. */
    'chat.continue': { input: z.object({ sessionId: z.string() }), output: Ok },
    'chat.edit': { input: z.object({ sessionId: z.string(), messageId: z.string(), parts: z.array(Part).min(1) }), output: z.object({ userMessageId: z.string() }) },
    'chat.switchBranch': { input: z.object({ sessionId: z.string(), messageId: z.string() }), output: SessionSnapshot },
    /** Summarizes the conversation so far (Code's `/compact [focus]`; Chat and Cowork only compact automatically). */
    'chat.compact': { input: z.object({ sessionId: z.string(), focus: z.string().optional() }), output: Ok },
    /** What fills the context window now (null before a model is chosen), and the tokens the session used. */
    'chat.contextBreakdown': { input: z.object({ sessionId: z.string() }), output: z.object({ context: ContextUsage.nullable(), usage: SessionUsage }) },
    /** The person's messages whose turns changed files, with those files (for Rewind). */
    'checkpoints.list': { input: z.object({ sessionId: z.string() }), output: z.array(z.object({ messageId: z.string(), paths: z.array(z.string()) })) },
    /**
     * Rewinds to before one of the person's messages: `files` restores what Write and Edit changed since then,
     * `conversation` moves the conversation back so the message can be sent again (the old branch stays).
     */
    'checkpoints.rewind': {
      input: z.object({ sessionId: z.string(), messageId: z.string(), files: z.boolean(), conversation: z.boolean() }),
      output: z.object({ restored: z.array(z.string()), snapshot: SessionSnapshot }),
    },
    /** Answers the permission prompt, question or connector request a run is waiting on. */
    'chat.respond': { input: z.object({ sessionId: z.string(), interactionId: z.string(), answer: z.union([PermissionAnswer, QuestionAnswer, ElicitationAnswer]) }), output: Ok },
    /**
     * `/btw`: a side chat beside a session, asking `question` at once when there is one. It sees the session's
     * conversation, only reads, and never enters the session or waits for it. Closed with `sessions.delete`.
     */
    'sideChats.start': { input: z.object({ sessionId: z.string(), question: z.string().max(100_000).optional() }), output: SessionSummary },
    /** A session's side chats, oldest first. */
    'sideChats.list': { input: z.object({ sessionId: z.string() }), output: z.array(SessionSummary) },

    /** What `/` offers besides the built-ins: skills people may start and custom commands, for a workspace or none. */
    'slash.list': {
      input: z.object({ workspaceId: z.string().optional() }),
      output: z.array(z.object({ name: z.string(), description: z.string(), kind: z.enum(['skill', 'command']), argumentHint: z.string().optional() })),
    },
    'skills.list': { input: z.object({ workspaceId: z.string().optional() }), output: z.array(SkillSummary) },
    /** Installs the skills under `owner/repo[@ref][/path]` (or a github.com URL); `replace` overwrites same-named skills from elsewhere. */
    'skills.install': { input: z.object({ source: z.string().min(3).max(500), replace: z.boolean().optional() }), output: z.object({ installed: z.array(z.string()) }) },
    'skills.uninstall': { input: z.object({ name: z.string().min(1).max(64) }), output: Ok },
    /** Usage per day, provider, model and mode; `everyone` (admins only) covers all accounts. `timezoneOffset` as `Date#getTimezoneOffset()`. */
    'usage.summary': {
      input: z.object({ days: z.number().int().min(1).max(366), timezoneOffset: z.number().int().min(-840).max(840), everyone: z.boolean().optional() }),
      output: z.array(UsageRow),
    },
    /** The signed-in person's stats for a mode's home over the last `days` days (null: all time). */
    'stats.summary': {
      input: z.object({ mode: Mode, days: z.union([z.literal(7), z.literal(30)]).nullable().optional(), timezoneOffset: z.number().int().min(-840).max(840) }),
      output: StatsSummary,
    },
    /** Everything the person has, as a zip in the blob store (download it from the blob URL). */
    'privacy.export': { input: Empty, output: z.object({ sha256: z.string(), name: z.string() }) },
    /** Deletes all of the person's conversations (projects stay). */
    'privacy.deleteConversations': { input: Empty, output: z.object({ deleted: z.number() }) },
    'plugins.list': { input: Empty, output: z.array(PluginSummary) },
    'plugins.setEnabled': { input: z.object({ id: z.string().min(1).max(200), enabled: z.boolean() }), output: Ok },
    /** A marketplace's plugins (`repo`: owner/repo or a github.com URL with `.claude-plugin/marketplace.json`). */
    'plugins.browse': {
      input: z.object({ repo: z.string().min(3).max(300) }),
      output: z.object({ name: z.string(), plugins: z.array(z.object({ name: z.string(), description: z.string(), version: z.string(), unsupported: z.string().optional() })) }),
    },
    'plugins.install': { input: z.object({ repo: z.string().min(3).max(300), plugin: z.string().min(1).max(64) }), output: z.object({ id: z.string() }) },
    'plugins.uninstall': { input: z.object({ id: z.string().min(1).max(200) }), output: Ok },
    'workspaces.list': { input: Empty, output: z.array(WorkspaceSummary) },
    /** Trusts a folder on this backend's machine (desktop "Run on this computer"). Its git toplevel becomes the root. */
    'workspaces.addLocal': { input: z.object({ path: z.string().min(1).max(4096) }), output: WorkspaceSummary },
    /** Desktop: the person's SSH connections (their own list; ~/.ssh/config's hosts only suggest what to type). */
    'ssh.list': { input: Empty, output: z.array(SshConnectionView) },
    /** Adds a connection, or changes one (`id`). The host must be new to the list. */
    'ssh.save': { input: SshConnectionInput.extend({ id: z.string().optional() }), output: SshConnectionView },
    /** Removes a connection and its saved password. Folders already opened on its host stay in the list. */
    'ssh.remove': { input: Id, output: Ok },
    'ssh.forgetPassword': { input: Id, output: Ok },
    /**
     * Connects with what is filled in, asking about an unknown host key or a password through `ssh.prompt` events
     * (answered with `ssh.answer`), and says whether it worked.
     */
    'ssh.test': { input: SshConnectionInput.extend({ id: z.string().optional() }), output: SshTestResult },
    'ssh.answer': { input: SshAnswer, output: Ok },
    /** The folders of an SSH host's file system, for choosing one: `path` (default: its home), its subfolders by name. */
    'ssh.browse': {
      input: z.object({ host: z.string().min(1).max(255), path: z.string().max(4096).optional() }),
      output: z.object({ path: z.string(), home: z.string(), dirs: z.array(z.string()) }),
    },
    /** Creates a folder named `name` inside `parent` on an SSH host; its path. */
    'ssh.mkdir': {
      input: z.object({ host: z.string().min(1).max(255), parent: z.string().min(1).max(4096), name: z.string().min(1).max(255) }),
      output: z.object({ path: z.string() }),
    },
    /** Desktop: hosts from ~/.ssh/config (without patterns), for adding SSH workspaces. */
    'workspaces.sshHosts': { input: Empty, output: z.array(z.string()) },
    /** Desktop: a folder on an SSH host (`~/` paths start in its home); the runner is uploaded on first use. */
    'workspaces.addSsh': { input: z.object({ host: z.string().min(1).max(255), path: z.string().min(1).max(4096) }), output: WorkspaceSummary },
    /**
     * A codespace's checkout as a workspace (its runner is uploaded through `gh codespace ssh`). It is trusted only with
     * `trust: true`, which says the person answered "Trust this workspace?"; otherwise its own settings, hooks and
     * instruction files are ignored until `workspaces.trust`.
     */
    'workspaces.addCodespace': { input: z.object({ name: z.string().min(1).max(200), trust: z.boolean().optional() }), output: WorkspaceSummary },
    /** The person answered "Trust this workspace?" with yes: the folder's own settings, hooks and instruction files apply from now on. */
    'workspaces.trust': { input: Id, output: WorkspaceSummary },
    'workspaces.remove': { input: Id, output: Ok },
    'github.status': { input: Empty, output: z.object({ connected: z.boolean(), login: z.string().optional() }) },
    /** A personal access token (classic: codespace + repo scopes); checked with GitHub before it is kept. */
    'github.connectToken': { input: z.object({ token: z.string().min(10).max(500) }), output: z.object({ connected: z.boolean(), login: z.string().optional() }) },
    'github.deviceStart': { input: Empty, output: z.object({ flowId: z.string(), userCode: z.string(), verificationUri: z.string(), interval: z.number() }) },
    'github.devicePoll': {
      input: z.object({ flowId: z.string() }),
      output: z.object({ status: z.enum(['pending', 'connected', 'expired', 'denied']), interval: z.number().optional(), login: z.string().optional() }),
    },
    'github.disconnect': { input: Empty, output: Ok },
    /** The repositories the person can open in a codespace, most recently pushed first. */
    'github.repos': { input: Empty, output: z.array(GitHubRepo) },
    /** How web search is doing: which engines answer, and which are being limited until when. */
    'search.status': { input: Empty, output: SearchStatus },
    /** One real search (admin: Settings › Admin › Capabilities › Test search); throws with the reason when none works. */
    'search.test': { input: Empty, output: z.object({ engine: z.string(), ms: z.number(), results: z.array(z.object({ title: z.string(), url: z.string() })) }) },
    'codespaces.list': { input: Empty, output: z.array(CodespaceSummary) },
    /**
     * Opens a repository as a folder: its codespace (woken when asleep), or a new one on the largest machine the account
     * can use that stays on as long as GitHub allows. Resolves once it is running and ready to work in (up to three minutes).
     * `trust` as for `workspaces.addCodespace`.
     */
    'codespaces.open': { input: z.object({ repo: Repo, ref: z.string().max(250).optional(), trust: z.boolean().optional() }), output: WorkspaceSummary },
    'codespaces.machines': { input: z.object({ repo: Repo, ref: z.string().max(250).optional() }), output: z.array(CodespaceMachine) },
    /** Creates a codespace and waits until it is available (up to three minutes). */
    'codespaces.create': {
      input: z.object({ repo: Repo, ref: z.string().max(250).optional(), machine: z.string().min(1).max(100), idleTimeoutMinutes: z.number().int().min(5).max(240).optional() }),
      output: CodespaceSummary,
    },
    'codespaces.start': { input: z.object({ name: z.string() }), output: Ok },
    'codespaces.stop': { input: z.object({ name: z.string() }), output: Ok },
    'codespaces.delete': { input: z.object({ name: z.string() }), output: Ok },
    'workspaces.files': { input: z.object({ workspaceId: z.string(), dir: z.string().max(4096) }), output: z.array(WorkspaceEntry) },
    /** `@`-mentions: workspace files matching `query`, best first. */
    'workspaces.findFiles': { input: z.object({ workspaceId: z.string(), query: z.string().max(200) }), output: z.array(z.string()) },
    'workspaces.readFile': { input: z.object({ workspaceId: z.string(), path: z.string().min(1).max(4096) }), output: WorkspaceFile },
    /** A file's bytes, base64, for image previews and downloads in the browser; files over 16 MiB are refused. */
    'workspaces.fileBytes': {
      input: z.object({ workspaceId: z.string(), path: z.string().min(1).max(4096) }),
      output: z.object({ dataBase64: z.string(), mime: z.string(), size: z.number() }),
    },
    'workspaces.gitStatus': { input: z.object({ workspaceId: z.string() }), output: GitStatus },
    /**
     * A unified diff of the working tree (the Diff pane): against HEAD (`head`, untracked files included), what is staged
     * (`staged`), everything since the branch left the default branch (`base`), or the files a session's Write and Edit
     * calls changed since it began (`session`, with `sessionId`). `base` names what the diff starts from.
     */
    'workspaces.diff': {
      input: z.object({ workspaceId: z.string(), path: z.string().max(4096).optional(), compare: DiffCompare.optional(), sessionId: z.string().optional() }),
      output: z.object({ diff: z.string(), truncated: z.boolean(), base: z.string().nullable() }),
    },
    /** The Files pane's `?` search: lines containing `query` (as typed, case-insensitive unless it has capitals). */
    'workspaces.grep': {
      input: z.object({ workspaceId: z.string(), query: z.string().min(1).max(200) }),
      output: z.object({ matches: z.array(z.object({ path: z.string(), line: z.number().int(), text: z.string() })), truncated: z.boolean() }),
    },
    /**
     * `lastCommit`: the subject of the newest commit on the current branch, which suggests a pull request's title.
     * `defaultBranch`: the repository's main line (origin's HEAD, else a local main or master), when known.
     */
    'git.branches': {
      input: z.object({ workspaceId: z.string() }),
      output: z.object({ current: z.string().nullable(), branches: z.array(z.string()), lastCommit: z.string().nullable(), defaultBranch: z.string().nullable() }),
    },
    'git.checkout': { input: z.object({ workspaceId: z.string(), branch: z.string().min(1).max(250), create: z.boolean() }), output: Ok },
    'git.stage': { input: z.object({ workspaceId: z.string(), paths: z.array(z.string().min(1).max(4096)).max(10_000), staged: z.boolean() }), output: Ok },
    /** Commits what is staged, as the person's git author (Settings) or the repository's configured one. */
    'git.commit': { input: z.object({ workspaceId: z.string(), message: z.string().min(1).max(20_000) }), output: z.object({ commit: z.string() }) },
    'git.push': { input: z.object({ workspaceId: z.string() }), output: Ok },
    /** Rejects one hunk in the Diff pane: `patch` is the file's header lines from `workspaces.diff` plus that hunk. */
    'git.revertHunk': { input: z.object({ workspaceId: z.string(), patch: z.string().min(1).max(2_000_000) }), output: Ok },
    'git.pullRequest': {
      input: z.object({ workspaceId: z.string(), title: z.string().min(1).max(256), body: z.string().max(60_000), base: z.string().max(250).optional() }),
      output: z.object({ url: z.string() }),
    },
    /** `dir`: the folder the shell starts in, relative to the workspace root (Files › Open in terminal); the root when absent. */
    'terminals.open': {
      input: z.object({ workspaceId: z.string(), cols: TerminalSize, rows: TerminalSize, dir: z.string().min(1).max(4096).optional() }),
      output: z.object({ terminalId: z.string() }),
    },
    'terminals.write': { input: z.object({ terminalId: z.string(), data: z.string().max(65_536) }), output: Ok },
    'terminals.resize': { input: z.object({ terminalId: z.string(), cols: TerminalSize, rows: TerminalSize }), output: Ok },
    'terminals.close': { input: z.object({ terminalId: z.string() }), output: Ok },
    /**
     * Shows a terminal on this connection again after its last one went away (a terminal outlives its connection for a
     * few minutes): the output since the first `since` characters, or all that was kept (`truncated`).
     */
    'terminals.attach': {
      input: z.object({ terminalId: z.string(), since: z.number().int().nonnegative() }),
      output: z.object({ data: z.string(), truncated: z.boolean() }),
    },
    /** A background command's output from character `since` on (`offset` is where the next read starts). */
    'tasks.output': {
      input: z.object({ sessionId: z.string(), taskId: z.string(), since: z.number().int().nonnegative() }),
      output: z.object({ output: z.string(), offset: z.number().int(), truncated: z.boolean(), running: z.boolean(), exitCode: z.number().int().nullable() }),
    },
    /** Stops a background command, a sub-agent or a loop. */
    'tasks.stop': { input: z.object({ sessionId: z.string(), taskId: z.string() }), output: Ok },
    /**
     * `/loop` (Code and Cowork): sends `prompt` now, or as soon as the session is idle, and again every `intervalMs`
     * (rounded up to the shortest interval, which `intervalMs` in the answer reflects). Listed in Background tasks.
     */
    'loops.start': {
      input: z.object({ sessionId: z.string(), prompt: z.string().trim().min(1).max(20_000), intervalMs: z.number().int().positive().max(LOOP_MAX_INTERVAL_MS) }),
      output: z.object({ taskId: z.string(), intervalMs: z.number().int() }),
    },
    /** `/loop stop [n|id]`: stops the session's loops, or the one `target` names (its number among the running loops, or its id). */
    'loops.stop': { input: z.object({ sessionId: z.string(), target: z.string().max(200).nullable() }), output: z.object({ stopped: z.number().int() }) },
    /** Drops the session's finished background tasks from the list. */
    'tasks.clear': { input: z.object({ sessionId: z.string() }), output: Ok },

    'files.upload': {
      input: z.object({ name: z.string().min(1).max(255), mime: z.string().min(1).max(200), dataBase64: z.string().max(46_000_000), sessionId: z.string().optional() }),
      output: FileRef,
    },
    'files.get': { input: Id, output: FileRef },
    'files.extractText': { input: Id, output: z.object({ text: z.string(), truncated: z.boolean() }) },

    'projects.list': { input: Empty, output: z.array(Project.extend({ fileCount: z.number().int(), sessionCount: z.number().int() })) },
    'projects.get': { input: Id, output: Project.extend({ files: z.array(FileRef) }) },
    'projects.create': { input: z.object({ name: z.string().min(1).max(120), description: z.string().max(2000).default('') }), output: Project },
    'projects.update': {
      input: z.object({ id: z.string(), name: z.string().min(1).max(120).optional(), description: z.string().max(2000).optional(), instructions: z.string().max(100_000).optional(), pinned: z.boolean().optional() }),
      output: Project,
    },
    'projects.delete': { input: Id, output: Ok },
    'projects.addFile': { input: z.object({ projectId: z.string(), fileId: z.string() }), output: FileRef },
    'projects.removeFile': { input: z.object({ projectId: z.string(), fileId: z.string() }), output: Ok },

    /** Connectors and their tools; asking starts connecting the servers not tried yet (updates follow as `mcp.changed`). */
    'mcp.status': { input: Empty, output: z.array(McpServerStatus) },
    /** Connects one server now, e.g. after editing it. */
    'mcp.test': { input: z.object({ name: McpServerName }), output: McpServerStatus },
    /** Desktop: Claude Code's servers (`~/.claude.json`, its projects, and `.mcp.json` in this person's local folders), converted. Nothing is written. */
    'mcp.import': { input: Empty, output: z.array(McpImportEntry) },
    /** A connector's recent log lines (its stderr, connections, failures), credentials masked. */
    'mcp.logs': { input: z.object({ name: McpServerName }), output: z.object({ lines: z.array(z.string()) }) },
    /**
     * Starts an OAuth connector's sign-in: the page to open, where the person signs in. Its status shows `signIn: 'waiting'`
     * until the authorization server sends them back (then it connects) or the sign-in is cancelled or times out.
     */
    'mcp.signIn': { input: z.object({ name: McpServerName }), output: z.object({ url: z.string() }) },
    'mcp.cancelSignIn': { input: z.object({ name: McpServerName }), output: Ok },
    /** Forgets an OAuth connector's tokens; it needs signing in again. */
    'mcp.signOut': { input: z.object({ name: McpServerName }), output: Ok },

    /** The person's own connectors (Customize › Connectors › Your connectors); their status comes with `mcp.status`. */
    'connectors.list': { input: Empty, output: z.array(PersonalConnectorView) },
    /** Adds or changes one; its values stay on the server, encrypted, and never come back. */
    'connectors.save': { input: PersonalConnectorInput, output: PersonalConnector },
    'connectors.remove': { input: Id, output: Ok },
    /** Connects one now, e.g. after editing it or allowing it on a computer. */
    'connectors.test': { input: Id, output: McpServerStatus },
    /** Starts an OAuth connector's sign-in, as `mcp.signIn` does for an admin's. */
    'connectors.signIn': { input: Id, output: z.object({ url: z.string() }) },
    /** Its recent log lines (what its program writes to stderr, connections, failures), credentials masked. */
    'connectors.logs': { input: Id, output: z.object({ lines: z.array(z.string()) }) },
    /** Desktop signed in to a server: Claude Code's connectors on this computer, converted. Nothing is written. */
    'connectors.import': { input: Empty, output: z.array(McpImportEntry) },
    /** Settings › Admin › Developer: the newest recorded provider requests first (while `developer.inspector` is on). */
    'developer.requests': { input: Empty, output: z.array(InspectedRequest) },
    'developer.clearRequests': { input: Empty, output: Ok },
    /** Reconnects every connector and has windows read skills, commands, agents and plugins again. */
    'developer.reload': { input: Empty, output: Ok },

    'artifacts.list': { input: z.object({ sessionId: z.string() }), output: z.array(ArtifactSummary) },
    'artifacts.get': { input: z.object({ id: z.string(), version: z.number().int().positive().optional() }), output: ArtifactSummary.extend({ content: ArtifactVersion }) },
    /** The person's artifacts across their chats, most recently updated first; `cursor` is the previous page's `nextCursor`. */
    'artifacts.listAll': {
      input: z.object({ limit: z.number().int().positive().max(200).default(60), cursor: z.string().regex(/^\d+:[\w-]+$/).optional(), type: ArtifactType.optional() }),
      output: z.object({ items: z.array(ArtifactListItem), nextCursor: z.string().nullable() }),
    },

    // Memory (Settings › Memory): always the signed-in person's own.
    'memory.list': { input: Empty, output: z.object({ entries: z.array(MemoryEntry) }) },
    'memory.get': { input: Id, output: MemoryEntry },
    /** A fixed entry (Preferences, Profile) is emptied rather than removed. */
    'memory.delete': { input: Id, output: Ok },
    /**
     * "Tell Atelier what to change": a model updates memory from the person's words, only `entryId` when given, or only
     * a fixed section (Preferences, Profile) not written yet. `model` is the person's choice for this request (one they
     * can use); without it the server picks (the small model, else the chat defaults, else the first available).
     */
    'memory.instruct': {
      input: z.object({ text: z.string().trim().min(1).max(4_000), entryId: z.string().optional(), section: MemorySection.optional(), model: z.string().min(1).optional() }),
      output: z.object({ changes: z.array(MemoryChange) }),
    },
    /**
     * An entry edited by hand: `id`, or a fixed `section` (Preferences, Profile) not written yet. Only while the
     * administrator allows it (`memory.manualEditing`); `details` holds one fact per line.
     */
    'memory.update': {
      input: z.object({
        id: z.string().optional(),
        section: MemorySection.optional(),
        title: z.string().trim().min(1).max(MEMORY_TITLE_MAX).optional(),
        summary: z.string().max(MEMORY_SUMMARY_MAX).optional(),
        details: z.string().max(MEMORY_DETAILS_MAX).optional(),
      }),
      output: MemoryEntry,
    },
    /**
     * Memory exported from another assistant, pasted in: a model (`model` as for `memory.instruct`) merges it into the
     * person's memory. The page sends a long export in parts (`splitMemoryExport`) to show progress; a longer part is
     * split here too.
     */
    'memory.import': {
      input: z.object({ text: z.string().trim().min(1).max(200_000), model: z.string().min(1).optional() }),
      output: z.object({ changes: z.array(MemoryChange) }),
    },
  },
  events: {
    /** The person's memory changed (a chat saved something, a background update, another window). */
    'memory.changed': Empty,
    /** This connection's sign-in ended (logout elsewhere, password reset, account disabled). */
    'auth.signedOut': Empty,
    /** The screen lock was set, cleared, locked or unlocked (every window follows). */
    'lock.changed': ScreenLockStatus,
    'prefs.changed': UserPrefs,
    'account.changed': UserSummary,
    'session.event': z.object({ sessionId: z.string(), seq: z.number().int(), event: RunEvent }),
    'sessions.changed': SessionSummary,
    'sessions.removed': Id,
    'groups.changed': z.array(SessionGroup),
    'settings.changed': SettingsSnapshot,
    'providers.changed': z.array(ProviderStatus),
    'models.changed': z.array(ModelInfo),
    'projects.changed': Empty,
    'workspaces.changed': z.array(WorkspaceSummary),
    /** One of the person's desktop devices came or went, or changed what it lends: read `account.devices` again. */
    'devices.changed': Empty,
    /** A connection needs the person: trust a host key, or give a password (answer with `ssh.answer`). */
    'ssh.prompt': SshPrompt,
    /** A prompt is no longer waiting (answered elsewhere, or it timed out). */
    'ssh.promptClosed': Id,
    'mcp.changed': z.array(McpServerStatus),
    /** Skills, commands, agents or plugin installs changed in this machine's folders: lists should be read again. */
    'extensions.changed': Empty,
    /** To admins only, while the inspector is on. */
    'developer.request': InspectedRequest,
    /** Terminal output, only to the connection that opened the terminal. */
    'terminals.data': z.object({ terminalId: z.string(), data: z.string() }),
    'terminals.exit': z.object({ terminalId: z.string(), code: z.number().nullable() }),
  },
} as const satisfies Contract;

export type AppContract = typeof contract;
type ProcedureName = keyof AppContract['procedures'];

/** Callable without signing in. */
export const PUBLIC_PROCEDURES: ReadonlySet<ProcedureName> = new Set<ProcedureName>([
  'app.info',
  'auth.status',
  'auth.setup',
  'auth.login',
  'auth.checkInvite',
  'auth.acceptInvite',
  'auth.signup',
  'auth.setupLocal',
  'auth.localSignIn',
  'lock.status',
  'lock.unlock',
]);

/** Callable while the screen lock is on; everything else is refused until it is unlocked. */
export const LOCKED_PROCEDURES: ReadonlySet<ProcedureName> = PUBLIC_PROCEDURES;

/** Callable by admins only: providers, models, system settings, secrets, users, invites and connectors. */
export const ADMIN_PROCEDURES: ReadonlySet<ProcedureName> = new Set<ProcedureName>([
  'settings.set',
  'settings.reset',
  'secrets.list',
  'secrets.set',
  'secrets.delete',
  'chatgptChat.status',
  'chatgptChat.open',
  'chatgptChat.hide',
  'chatgptChat.disconnect',
  'chatgpt.status',
  'chatgpt.signIn',
  'chatgpt.cancel',
  'chatgpt.signOut',
  'copilot.status',
  'copilot.signIn',
  'copilot.cancel',
  'copilot.signOut',
  'openrouter.connect',
  'openrouter.status',
  'openrouter.cancel',
  'providers.status',
  'providers.detect',
  'providers.test',
  'search.test',
  'providers.save',
  'providers.remove',
  'providers.refresh',
  'models.probeTools',
  'users.list',
  'users.create',
  'users.update',
  'users.resetPassword',
  'users.delete',
  'invites.list',
  'invites.create',
  'invites.revoke',
  'server.updates',
  'server.update',
  'instructions.get',
  'instructions.set',
  'plugins.setEnabled',
  'plugins.browse',
  'plugins.install',
  'plugins.uninstall',
  'skills.install',
  'skills.uninstall',
  'mcp.test',
  'mcp.import',
  'mcp.logs',
  'mcp.signIn',
  'mcp.cancelSignIn',
  'mcp.signOut',
  'developer.requests',
  'developer.clearRequests',
  'developer.reload',
  'lock.set',
  'lock.clear',
  'lock.setAutoLock',
]);
