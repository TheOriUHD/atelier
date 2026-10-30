/** Drizzle schema (SQLite via node:sqlite). Timestamps are epoch milliseconds. */
import { sqliteTable, text, integer, real, index, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Accounts (ARCHITECTURE §21). The first account is the admin; data rows reference their owner. */
export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    /** Lowercase login name. */
    username: text('username').notNull(),
    name: text('name').notNull().default(''),
    role: text('role', { enum: ['admin', 'user', 'pending'] }).notNull(),
    passwordHash: text('password_hash').notNull(),
    /** Set for admin-created accounts and resets: the next login must choose a new password. */
    mustChangePassword: integer('must_change_password', { mode: 'boolean' }).notNull().default(false),
    avatarBlob: text('avatar_blob'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastActiveAt: integer('last_active_at'),
    disabledAt: integer('disabled_at'),
    /** The admin's safeguards override for this person; `inherit` follows the system setting. */
    safeguards: text('safeguards', { enum: ['inherit', 'on', 'off'] }).notNull().default('inherit'),
  },
  (t) => [uniqueIndex('users_username').on(t.username)],
);

export const authSessions = sqliteTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(),
    /** sha256 of the bearer token; the token itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientKind: text('client_kind', { enum: ['web', 'desktop'] }).notNull(),
    deviceId: text('device_id'),
    userAgent: text('user_agent').notNull().default(''),
    ip: text('ip').notNull().default(''),
    createdAt: integer('created_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [uniqueIndex('auth_sessions_token').on(t.tokenHash), index('auth_sessions_user').on(t.userId)],
);

export const invites = sqliteTable(
  'invites',
  {
    id: text('id').primaryKey(),
    tokenHash: text('token_hash').notNull(),
    /** The last group of an invite code; null for the invite links made before codes. */
    codeHint: text('code_hint'),
    role: text('role', { enum: ['admin', 'user'] }).notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
    usedBy: text('used_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [uniqueIndex('invites_token').on(t.tokenHash)],
);

/** Per-user preferences (appearance, profile, personalization …), validated by the protocol's `UserPrefs`. */
export const userPrefs = sqliteTable('user_prefs', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  prefs: text('prefs', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** Folders a user trusted for Code and Work sessions (ARCHITECTURE §6, §21). */
export const workspaces = sqliteTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['local', 'ssh', 'codespace'] }).notNull(),
    name: text('name').notNull(),
    /** Absolute path on the machine that hosts the workspace. */
    root: text('root').notNull(),
    /** SSH workspaces: the host as `ssh` knows it (an alias from ~/.ssh/config, or user@host); codespaces: the codespace's name. */
    host: text('host'),
    /** The desktop device hosting it in server mode; null when it is on the backend's own machine. */
    deviceId: text('device_id'),
    /** A folder Atelier made, empty, for one session started without a folder; it isn't one of the person's folders. */
    scratch: integer('scratch', { mode: 'boolean' }).notNull().default(false),
    /** A chat's sandbox: a scratch folder whose commands run under fixed rules instead of permission prompts. */
    sandbox: integer('sandbox', { mode: 'boolean' }).notNull().default(false),
    /**
     * The person answered "Trust this workspace?". Until then the backend ignores what the folder brings itself (its settings
     * files, hooks, instruction files, skills, commands and agents). Folders on a computer or an SSH host are trusted when
     * they are added (the desktop app asks first); a codespace's only when the call that adds it says so.
     */
    trusted: integer('trusted', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at').notNull(),
  },
  (t) => [index('workspaces_user').on(t.userId)],
);

/** WebAuthn credentials for signing in on the web without a password (ARCHITECTURE §14). */
export const passkeys = sqliteTable(
  'passkeys',
  {
    /** The credential id (base64url). */
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** COSE public key, base64url. */
    publicKey: text('public_key').notNull(),
    counter: integer('counter').notNull(),
    transports: text('transports', { mode: 'json' }).$type<string[]>().notNull().default([]),
    name: text('name').notNull(),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at'),
  },
  (t) => [index('passkeys_user').on(t.userId)],
);

/**
 * Identity providers browsers sign in with (OpenID Connect, ARCHITECTURE §21). A table of their own and not settings:
 * project settings merge into settings, and no project may decide who signs in to a server. The client secret is the
 * secret `oidc-<id>`.
 */
export const oidcProviders = sqliteTable('oidc_providers', {
  /** From the name when added; part of the redirect URI, so it never changes. */
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Exactly as the provider states it, trailing slash and all. */
  issuer: text('issuer').notNull(),
  clientId: text('client_id').notNull(),
  newAccounts: text('new_accounts', { enum: ['none', 'pending', 'user'] }).notNull(),
  createdAt: integer('created_at').notNull(),
});

/**
 * Who a person is at an identity provider. Issuer and subject are the only stable names OpenID Connect gives, and
 * only the pair is unique; email addresses and usernames can change hands, so nothing is matched on those.
 */
export const userIdentities = sqliteTable(
  'user_identities',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    providerId: text('provider_id')
      .notNull()
      .references(() => oidcProviders.id, { onDelete: 'cascade' }),
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
    /** An email address or username to tell it by; never used to find anyone. */
    label: text('label').notNull(),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at'),
  },
  (t) => [uniqueIndex('user_identities_subject').on(t.issuer, t.subject), index('user_identities_user').on(t.userId)],
);

/**
 * Desktop apps signed in to an account; they lend their machine to that user's sessions. A device id is
 * the app's own, so each account that signs in on the same machine has its own row for it.
 */
export const devices = sqliteTable(
  'devices',
  {
    id: text('id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    platform: text('platform').notNull(),
    createdAt: integer('created_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.id] })],
);

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  instructions: text('instructions').notNull().default(''),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  archivedAt: integer('archived_at'),
  pinnedAt: integer('pinned_at'),
});

/** A person's own named groups for their Code and Cowork sessions in the sidebar. */
export const sessionGroups = sqliteTable('session_groups', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  collapsed: integer('collapsed', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    mode: text('mode', { enum: ['chat', 'work', 'code'] }).notNull(),
    title: text('title').notNull().default(''),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    workspaceId: text('workspace_id'),
    parentSessionId: text('parent_session_id'),
    model: text('model'),
    effort: text('effort'),
    permissionMode: text('permission_mode'),
    /** JSON: per-session tool/connector toggles. */
    overrides: text('overrides', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    headMessageId: text('head_message_id'),
    status: text('status', { enum: ['idle', 'running', 'waiting', 'interrupted', 'error'] }).notNull().default('idle'),
    /** JSON: pending permission / question / elicitation, survives restarts. */
    pending: text('pending', { mode: 'json' }).$type<{ kind: string; id: string; payload: unknown } | null>(),
    todos: text('todos', { mode: 'json' }).$type<unknown[]>().notNull().default([]),
    /** Blob refs of the frozen system prompt and tool list (prompt-cache stability). */
    systemSnapshot: text('system_snapshot'),
    toolsSnapshot: text('tools_snapshot'),
    seq: integer('seq').notNull().default(0),
    pinnedAt: integer('pinned_at'),
    /** When a turn last finished without the person looking (null once they have opened the session since). */
    finishedUnseenAt: integer('finished_unseen_at'),
    /** The sidebar group it was filed under (its own group list), if any. */
    groupId: text('group_id').references(() => sessionGroups.id, { onDelete: 'set null' }),
    /** Put away: left out of the lists until someone asks for archived sessions. */
    archivedAt: integer('archived_at'),
    /** A temporary chat and how private it is (sessions/temporary.ts); null for every other session. */
    temporary: text('temporary', { enum: ['private', 'fresh'] }),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('sessions_updated').on(t.updatedAt),
    index('sessions_temporary').on(t.temporary),
    index('sessions_parent').on(t.parentSessionId),
    index('sessions_project').on(t.projectId),
    index('sessions_user').on(t.userId, t.updatedAt),
  ],
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    parentId: text('parent_id'),
    role: text('role', { enum: ['user', 'assistant', 'tool'] }).notNull(),
    parts: text('parts', { mode: 'json' }).$type<unknown[]>().notNull(),
    model: text('model'),
    usage: text('usage', { mode: 'json' }).$type<Record<string, number> | null>(),
    stopReason: text('stop_reason'),
    error: text('error', { mode: 'json' }).$type<{ code: string; message: string; fix?: string; retryable?: boolean } | null>(),
    kind: text('kind', { enum: ['normal', 'compaction_summary', 'context'] }).notNull().default('normal'),
    summarizesThroughId: text('summarizes_through_id'),
    /** Plain text for full-text search (kept in sync with messages_fts by triggers). */
    searchText: text('search_text').notNull().default(''),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('messages_session').on(t.sessionId, t.createdAt), index('messages_parent').on(t.parentId)],
);

/**
 * File pre-images for Rewind (ARCHITECTURE §8): one row per file per turn, taken before the turn's first
 * Write or Edit of that file. Keyed by the root conversation, so sub-agent edits belong to their parent's turn.
 */
export const checkpoints = sqliteTable(
  'checkpoints',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** The person's message that started the turn. */
    messageId: text('message_id').notNull(),
    /** As the tool named it: absolute, or relative to the workspace root. */
    path: text('path').notNull(),
    /** The content before the turn changed it; null when the file didn't exist. */
    beforeBlob: text('before_blob'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('checkpoints_turn_path').on(t.sessionId, t.messageId, t.path), index('checkpoints_created').on(t.createdAt)],
);

export const blobs = sqliteTable('blobs', {
  sha256: text('sha256').primaryKey(),
  size: integer('size').notNull(),
  mime: text('mime').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const files = sqliteTable(
  'files',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
    messageId: text('message_id'),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    blob: text('blob').notNull(),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    tokens: integer('tokens'),
    kind: text('kind', { enum: ['upload', 'generated', 'output', 'project'] }).notNull(),
    workspacePath: text('workspace_path'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('files_project').on(t.projectId), index('files_session').on(t.sessionId)],
);

export const artifacts = sqliteTable(
  'artifacts',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    identifier: text('identifier').notNull(),
    type: text('type', { enum: ['html', 'react', 'svg', 'mermaid', 'markdown', 'code'] }).notNull(),
    title: text('title').notNull(),
    language: text('language'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('artifacts_session').on(t.sessionId, t.identifier)],
);

export const artifactVersions = sqliteTable(
  'artifact_versions',
  {
    artifactId: text('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    content: text('content').notNull(),
    messageId: text('message_id'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.artifactId, t.version] })],
);

export const usageEvents = sqliteTable(
  'usage_events',
  {
    id: text('id').primaryKey(),
    ts: integer('ts').notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    providerId: text('provider_id').notNull(),
    modelId: text('model_id').notNull(),
    sessionId: text('session_id'),
    mode: text('mode'),
    input: integer('input').notNull(),
    output: integer('output').notNull(),
    cacheRead: integer('cache_read').notNull().default(0),
    cacheWrite: integer('cache_write').notNull().default(0),
    reasoning: integer('reasoning').notNull().default(0),
    durationMs: integer('duration_ms'),
    tokensPerSecond: real('tokens_per_second'),
    costUsd: real('cost_usd'),
  },
  (t) => [index('usage_ts').on(t.ts)],
);

export const modelCache = sqliteTable(
  'model_cache',
  {
    providerId: text('provider_id').notNull(),
    modelId: text('model_id').notNull(),
    info: text('info', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    discoveredAt: integer('discovered_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.providerId, t.modelId] })],
);

/** A person's own model servers and ChatGPT Chat on one of their computers (providers/personal.ts); ids never clash with the admin's. */
export const personalProviders = sqliteTable(
  'personal_providers',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: text('device_id').notNull(),
    type: text('type', { enum: ['ollama', 'llamacpp', 'openai-compatible', 'chatgpt-chat'] }).notNull(),
    name: text('name').notNull(),
    baseUrl: text('base_url').notNull(),
    /** parallelRequests, modelsAtOnce, vramGiB. */
    options: text('options', { mode: 'json' }).$type<{ parallelRequests?: number; modelsAtOnce?: number; vramGiB?: number }>().notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('personal_providers_user').on(t.userId)],
);

export const secrets = sqliteTable('secrets', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  kind: text('kind', { enum: ['api_key', 'token', 'mcp_oauth', 'github', 'oidc'] }).notNull(),
  ciphertext: text('ciphertext').notNull(),
  /** Last four characters, stored to render the masked value without decrypting. */
  tail: text('tail').notNull(),
  expiresAt: integer('expires_at'),
  createdAt: integer('created_at').notNull(),
  rotatedAt: integer('rotated_at'),
  lastUsedAt: integer('last_used_at'),
});

/** What a person's assistant remembers about them across chats (ARCHITECTURE › Memory); every query is scoped by `userId`. */
export const memoryEntries = sqliteTable(
  'memory_entries',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    section: text('section', { enum: ['preferences', 'profile', 'topic', 'area', 'person', 'project'] }).notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    /** A Markdown bullet list, one fact per line. */
    details: text('details').notNull().default(''),
    /** Section `project`: the Atelier project whose chats read it. A deleted project's entries read as areas. */
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    sensitive: integer('sensitive', { mode: 'boolean' }).notNull().default(false),
    source: text('source', { enum: ['chat', 'background', 'settings', 'import'] }).notNull().default('chat'),
    sourceSessionId: text('source_session_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('memory_entries_user').on(t.userId, t.section)],
);

/** How far the background memory update has read each conversation. */
export const memoryProgress = sqliteTable('memory_progress', {
  sessionId: text('session_id')
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** The last message it read; null when nothing was read yet. */
  throughMessageId: text('through_message_id'),
  processedAt: integer('processed_at').notNull(),
});
