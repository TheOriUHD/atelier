/**
 * System settings, written by admins (ARCHITECTURE §21): layered global ~/.atelier/settings.json →
 * project .atelier/settings.json → local .atelier/settings.local.json. Per-user preferences are in
 * `accounts.ts`. Same shape on desktop and server. Secrets are never stored here:
 * strings may reference them as `${secret:<id>}` and environment variables as `${ENV}` / `${ENV:-default}`.
 * Keys are added to this schema in the milestone that uses them.
 */
import { z } from 'zod';
import { McpServerConfig, McpServerName } from './mcp.ts';
import { ProviderId, ProviderType, PromptTier } from './models.ts';

export const Mode = z.enum(['chat', 'work', 'code']);
export type Mode = z.infer<typeof Mode>;

/** Claude Code's permission modes (ARCHITECTURE §8); the UI calls them Auto, Ask, Accept edits, Plan and Bypass. */
export const PermissionMode = z.enum(['auto', 'default', 'acceptEdits', 'plan', 'bypassPermissions']);
export type PermissionMode = z.infer<typeof PermissionMode>;

/** How people get an account: admins invite them, or anyone may sign up and wait for approval. */
export const SignupPolicy = z.enum(['invite', 'open']);
export type SignupPolicy = z.infer<typeof SignupPolicy>;

export const ProviderConfig = z.object({
  id: ProviderId,
  type: ProviderType,
  name: z.string().min(1),
  baseUrl: z.string().url(),
  /** Usually `${secret:<id>}`. */
  apiKey: z.string().optional(),
  headers: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().default(true),
  /**
   * Requests the server answers at once. Unset: what the server reports (llama.cpp's slots), else 1 for a server on
   * this computer or the local network and 16 for a hosted API.
   */
  parallelRequests: z.number().int().min(1).max(64).optional(),
  /** Available GPU/unified memory in GiB. Ollama uses model metadata to estimate context; not a server configuration. */
  vramGiB: z.number().positive().max(1_048_576).optional(),
  /** Models the server keeps loaded at once. Unset: 1 for a server on this computer or the local network, no limit for a hosted API. */
  modelsAtOnce: z.number().int().min(1).max(16).optional(),
  /** ChatGPT Chat only: chat in ChatGPT's temporary chats, which stay out of the account's history and memory. Unset: on. */
  temporaryChat: z.boolean().optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfig>;

export const ModelOverride = z
  .object({
    hidden: z.boolean(),
    displayName: z.string(),
    favorite: z.boolean(),
    order: z.number(),
    contextLength: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    temperature: z.number().min(0).max(2),
    toolCalling: z.enum(['native', 'prompted', 'none']),
    vision: z.boolean(),
    promptTier: PromptTier,
    /** Added by id in Settings › Admin › Models: listed for its provider even when the provider's model list leaves it out. */
    manual: z.boolean(),
  })
  .partial();
export type ModelOverride = z.infer<typeof ModelOverride>;

/** Content kinds the optional safeguards block covers (§9 of docs/PROMPTS.md); harassment and self-harm are opt-in. */
export const SafeguardCategories = z.object({
  sexual: z.boolean().default(true),
  hate: z.boolean().default(true),
  harassment: z.boolean().default(false),
  selfHarm: z.boolean().default(false),
});
export type SafeguardCategories = z.infer<typeof SafeguardCategories>;

/**
 * Optional extra safeguards, off by default: with them off, Atelier adds nothing to what the model and its provider
 * already enforce. Admins switch them on for everyone here, or per person on the user record.
 */
export const SafeguardsSettings = z.object({
  enabled: z.boolean().default(false),
  categories: SafeguardCategories.default({ sexual: true, hate: true, harassment: false, selfHarm: false }),
  /** `younger` adds rules for accounts that may belong to someone under 18. */
  profile: z.enum(['adult', 'younger']).default('adult'),
  /** A helpline or service the self-harm rules may point to. */
  crisisResources: z.string().max(500).default(''),
});
export type SafeguardsSettings = z.infer<typeof SafeguardsSettings>;

/** What the administrator tells the model in every conversation (docs/PROMPTS.md §1.5). */
export const PromptSettings = z.object({
  /** Read in Chat, Cowork and Code alike, ranked above everything else the model is told; Code and Cowork also get the system AGENTS.md. */
  organizationInstructions: z.string().max(20_000).default(''),
});
export type PromptSettings = z.infer<typeof PromptSettings>;

export const Price = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative().optional(),
  cacheWrite: z.number().nonnegative().optional(),
  /** Dollars per million tokens for a request whose whole input is longer than `above` tokens. */
  longContext: z
    .object({
      above: z.number().int().positive(),
      input: z.number().nonnegative(),
      output: z.number().nonnegative(),
      cacheRead: z.number().nonnegative().optional(),
      cacheWrite: z.number().nonnegative().optional(),
    })
    .optional(),
});
export type Price = z.infer<typeof Price>;

export const SettingsSchema = z.object({
  providers: z.array(ProviderConfig).default([]),
  models: z
    .object({
      defaults: z
        .object({ chat: z.string(), work: z.string(), code: z.string(), small: z.string() })
        .partial()
        .default({}),
      aliases: z.object({ opus: z.string(), sonnet: z.string(), haiku: z.string(), fable: z.string() }).partial().default({}),
      overrides: z.record(z.string(), ModelOverride).default({}),
    })
    .default({ defaults: {}, aliases: {}, overrides: {} }),
  capabilities: z
    .object({
      /**
       * On by default and nothing to set up: `auto` is Atelier's own search of the open web. `searxng`, `brave` and
       * `tavily` are the provider someone runs or pays for; one without its URL or key counts as `auto`.
       */
      webSearch: z
        .object({
          enabled: z.boolean().default(true),
          provider: z.enum(['auto', 'searxng', 'brave', 'tavily']).default('auto'),
          /** SearXNG base URL. */
          url: z.string().optional(),
          /** Brave or Tavily key, usually `${secret:<id>}`. */
          apiKey: z.string().optional(),
        })
        .default({ enabled: true, provider: 'auto' }),
      webFetch: z.boolean().default(true),
      /** Let WebFetch reach LAN and VPN addresses (homelab docs); loopback and link-local stay blocked. */
      webFetchPrivateNetworks: z.boolean().default(false),
    })
    .default({ webSearch: { enabled: true, provider: 'auto' }, webFetch: true, webFetchPrivateNetworks: false }),
  pricing: z.record(z.string(), Price).default({}),
  context: z
    .object({ autoCompactAt: z.number().min(0.5).max(0.98).default(0.85) })
    .default({ autoCompactAt: 0.85 }),
  /** Ultracode, the last effort stop in Code. Off: the stop is gone and sessions that chose it run at Extra. */
  ultracode: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  /** File pre-images kept for Rewind. */
  checkpoints: z.object({ retentionDays: z.number().int().min(1).max(3650).default(30) }).default({ retentionDays: 30 }),
  server: z.object({ signup: SignupPolicy.default('invite') }).default({ signup: 'invite' }),
  /** System-wide permission rules in Claude Code syntax; projects and people add their own. */
  permissions: z
    .object({
      defaultMode: PermissionMode.default('auto'),
      allow: z.array(z.string()).default([]),
      ask: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
      additionalDirectories: z.array(z.string()).default([]),
    })
    .default({ defaultMode: 'auto', allow: [], ask: [], deny: [], additionalDirectories: [] }),
  /**
   * System hooks in Claude Code's shape (ARCHITECTURE §8). They run for workspaces on this backend's own
   * machine; a person's desktop device only runs the hooks its projects bring.
   */
  hooks: z.lazy(() => HooksConfig).default({}),
  /** GitHub sign-in for Codespaces: the client id of an OAuth app with device flow enabled (people can also paste a token). */
  cloud: z.object({ github: z.object({ clientId: z.string().max(100).optional() }).default({}) }).default({ github: {} }),
  /** Plugins switched on or off here (`name@marketplace`), over Claude Code's own `enabledPlugins`. */
  enabledPlugins: z.record(z.string(), z.boolean()).default({}),
  /** Marketplaces plugins were installed from, in Claude Code's shape: `{ "name": { "source": { "source": "github", "repo": "o/r" } } }`. */
  extraKnownMarketplaces: z.record(z.string(), z.looseObject({ source: z.looseObject({ source: z.string(), repo: z.string().optional() }) })).default({}),
  /** Read Claude Code's files too (`.claude/settings.json` permissions and hooks, CLAUDE.md, rules). */
  compat: z.object({ claudeCode: z.boolean().default(true) }).default({ claudeCode: true }),
  /** MCP connectors for everyone on this backend, in Claude Code's shape (ARCHITECTURE §9-B). */
  mcpServers: z.record(McpServerName, McpServerConfig).default({}),
  prompts: PromptSettings.default({ organizationInstructions: '' }),
  safeguards: SafeguardsSettings.default({ enabled: false, categories: { sexual: true, hate: true, harassment: false, selfHarm: false }, profile: 'adult', crisisResources: '' }),
  /** Memory for everyone: `manualEditing` lets people edit an entry's title, summary and details by hand in Settings › Memory. */
  memory: z.object({ manualEditing: z.boolean().default(false) }).default({ manualEditing: false }),
  /** Settings › Admin › Developer: record requests to model providers for the request inspector. */
  developer: z.object({ inspector: z.boolean().default(false) }).default({ inspector: false }),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStart', 'Stop'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** A `command` hook. Other handler types parse (so settings stay valid) but don't run. */
export const HookCommand = z.object({ type: z.literal('command'), command: z.string().min(1), timeout: z.number().positive().max(3600).optional() });
export type HookCommand = z.infer<typeof HookCommand>;

/** `{ "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "…" }] }] }`; unknown events are kept and ignored. */
export const HooksConfig = z.record(z.string(), z.array(z.object({ matcher: z.string().optional(), hooks: z.array(z.looseObject({ type: z.string() })) })));
export type HooksConfig = z.infer<typeof HooksConfig>;
export type SettingsInput = z.input<typeof SettingsSchema>;

export const SettingsLayer = z.enum(['global', 'project', 'local']);
export type SettingsLayer = z.infer<typeof SettingsLayer>;

/** A JSON path into the settings document, e.g. ['appearance', 'theme'] or ['providers', 0, 'name']. */
export const SettingsPath = z.array(z.union([z.string(), z.number().int().nonnegative()])).min(1);
export type SettingsPath = z.infer<typeof SettingsPath>;

export function defaultSettings(): Settings {
  return SettingsSchema.parse({});
}

/**
 * The model a new session in `mode` starts with, before any choice of its own. The admin's "Default model for everyone"
 * is stored as the Chat default, and Cowork and Code follow it until a default is set for their own mode.
 */
export function defaultModelFor(settings: Pick<Settings, 'models'>, mode: Mode): string | undefined {
  const { defaults } = settings.models;
  return defaults[mode] ?? defaults.chat;
}
