/**
 * Accounts, sessions, devices and per-user preferences (ARCHITECTURE §21). System-wide settings live in
 * `settings.ts` and are admin-only; everything here belongs to one user.
 */
import { z } from 'zod';
import { Mode, SignupPolicy, type SafeguardCategories, type SafeguardsSettings } from './settings.ts';
import { TemporaryMode } from './domain.ts';
import { SshConnection } from './ssh.ts';

export const UserRole = z.enum(['admin', 'user', 'pending']);
export type UserRole = z.infer<typeof UserRole>;

export const Username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{1,31}$/, '2–32 characters: letters, digits, dot, dash or underscore');
export const Password = z.string().min(8, 'At least 8 characters').max(256);

/** An admin's per-person override of the system safeguards setting. */
export const SafeguardsOverride = z.enum(['inherit', 'on', 'off']);
export type SafeguardsOverride = z.infer<typeof SafeguardsOverride>;

/**
 * What the optional safeguards cover for one person: their override, or the system switch when it is `inherit`. Null
 * when nothing applies, also when they are on with every category off and the adult profile.
 */
export function effectiveSafeguards(
  system: SafeguardsSettings,
  person: SafeguardsOverride,
): { categories: (keyof SafeguardCategories)[]; younger: boolean } | null {
  const on = person === 'inherit' ? system.enabled : person === 'on';
  const categories = (Object.keys(system.categories) as (keyof SafeguardCategories)[]).filter(
    (c) => system.categories[c],
  );
  const younger = system.profile === 'younger';
  return on && (categories.length > 0 || younger) ? { categories, younger } : null;
}

export const UserSummary = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string(),
  role: UserRole,
  /** Blob sha256 of the profile photo. */
  avatar: z.string().nullable(),
  mustChangePassword: z.boolean(),
  disabled: z.boolean(),
  /** Admin-set: `inherit` follows the system safeguards setting. */
  safeguards: SafeguardsOverride,
  createdAt: z.number(),
  lastActiveAt: z.number().nullable(),
});
export type UserSummary = z.infer<typeof UserSummary>;

export const ClientKind = z.enum(['web', 'desktop']);
export type ClientKind = z.infer<typeof ClientKind>;

export const AuthSessionSummary = z.object({
  id: z.string(),
  clientKind: ClientKind,
  userAgent: z.string(),
  ip: z.string(),
  createdAt: z.number(),
  lastSeenAt: z.number(),
  /** The session this connection uses. */
  current: z.boolean(),
});
export type AuthSessionSummary = z.infer<typeof AuthSessionSummary>;

export const DeviceSummary = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.string(),
  createdAt: z.number(),
  lastSeenAt: z.number(),
  /** The device this connection comes from. */
  current: z.boolean(),
  online: z.boolean(),
});
export type DeviceSummary = z.infer<typeof DeviceSummary>;

/** Crockford's base32 has no I, L, O or U, so a typed I or L can only mean 1 and O only 0. */
export const INVITE_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** The 16 symbols (80 bits) of an invite code however it was typed, or null when it can't be one. */
export function normalizeInviteCode(input: string): string | null {
  const code = input
    .toUpperCase()
    .replace(/[\s\-\u2010-\u2015]+/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{16}$/.test(code) ? code : null;
}

/** `A1B2C3D4E5F6G7H8` → `A1B2-C3D4-E5F6-G7H8`. */
export function formatInviteCode(code: string): string {
  return code.replace(/(.{4})(?=.)/g, '$1-');
}

export const InviteSummary = z.object({
  id: z.string(),
  role: z.enum(['admin', 'user']),
  /** The last group of an invite code, so admins can tell codes apart; null for invite links made before codes. */
  hint: z.string().nullable(),
  createdAt: z.number(),
  expiresAt: z.number(),
  usedAt: z.number().nullable(),
  usedBy: z.string().nullable(),
});
export type InviteSummary = z.infer<typeof InviteSummary>;

export const AuthStatus = z.object({
  /** No account exists yet: the first one created becomes the admin. */
  setupRequired: z.boolean(),
  signup: SignupPolicy,
  /** The signed-in user of this connection, if any. */
  user: UserSummary.nullable(),
  /** The desktop app's own backend ("Run on this computer"): one person, no password, no sign-in screen. */
  local: z.boolean(),
});
export type AuthStatus = z.infer<typeof AuthStatus>;

/** The optional screen lock of the desktop app's own backend: a PIN of 4–8 digits or a password. */
export const ScreenLockKind = z.enum(['pin', 'password']);
export type ScreenLockKind = z.infer<typeof ScreenLockKind>;

export const LOCK_PIN_RE = /^\d{4,8}$/;
export const LOCK_PASSWORD_MIN = 6;

/** A new PIN or password, checked against its kind. */
export const NewScreenLock = z.object({ kind: ScreenLockKind, secret: z.string().max(256) }).superRefine((v, ctx) => {
  if (v.kind === 'pin' && !LOCK_PIN_RE.test(v.secret))
    ctx.addIssue({ code: 'custom', path: ['secret'], message: 'Use 4 to 8 digits.' });
  if (v.kind === 'password' && v.secret.length < LOCK_PASSWORD_MIN)
    ctx.addIssue({ code: 'custom', path: ['secret'], message: `At least ${LOCK_PASSWORD_MIN} characters.` });
});
export type NewScreenLock = z.infer<typeof NewScreenLock>;

export const AUTO_LOCK_MINUTES = [0, 5, 15, 30, 60] as const;
export const AutoLockMinutes = z.union([z.literal(0), z.literal(5), z.literal(15), z.literal(30), z.literal(60)]);
export type AutoLockMinutes = z.infer<typeof AutoLockMinutes>;

export const ScreenLockStatus = z.object({
  /** Off unless the person set a PIN or password. */
  enabled: z.boolean(),
  kind: ScreenLockKind.nullable(),
  /** Locks after this many minutes without input in any window; 0 is never. */
  autoLockMinutes: AutoLockMinutes,
  locked: z.boolean(),
  /** After too many wrong tries: when the next one is accepted (ms since epoch), else null. */
  retryAt: z.number().nullable(),
});
export type ScreenLockStatus = z.infer<typeof ScreenLockStatus>;

/** A syntax theme: `atelier-light`, `atelier-dark` or one of Shiki's bundled theme ids. */
const SyntaxTheme = z.string().regex(/^[a-z0-9-]{1,64}$/, 'Not a syntax theme id');

/** Per-user preferences. Keys are added in the milestone that uses them. */
export const PasskeySummary = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  lastUsedAt: z.number().nullable(),
});
export type PasskeySummary = z.infer<typeof PasskeySummary>;

export const TranscriptView = z.enum(['normal', 'thinking', 'verbose']);
export type TranscriptView = z.infer<typeof TranscriptView>;

export const SidebarEnvironment = z.enum(['local', 'cloud', 'remote', 'ssh']);
export type SidebarEnvironment = z.infer<typeof SidebarEnvironment>;

/** How the Code and Cowork session lists are shown (the sidebar's view options). */
export const SidebarView = z.object({
  /** Archived sessions are shown only when asked for. */
  status: z.enum(['active', 'archived', 'all']).default('active'),
  /** Which environments' sessions are listed. */
  environments: z.array(SidebarEnvironment).default(['local', 'cloud', 'remote', 'ssh']),
  groupBy: z.enum(['date', 'folder', 'state', 'custom', 'none']).default('folder'),
  sortBy: z.enum(['name', 'created', 'activity']).default('activity'),
  showEmptyGroups: z.boolean().default(false),
});
export type SidebarView = z.infer<typeof SidebarView>;

/** The longest personal ATELIER.md, as long as the system AGENTS.md may be. */
export const PERSONAL_INSTRUCTIONS_MAX = 60_000;

export const CUSTOM_PERSONALITY_MAX = 4_000;
export const CUSTOM_PERSONALITY_LIMIT = 20;
export const CustomPersonality = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  name: z.string().trim().min(1).max(80),
  instructions: z.string().trim().min(1).max(CUSTOM_PERSONALITY_MAX),
});
export type CustomPersonality = z.infer<typeof CustomPersonality>;

/** One atomic preference so deleting a selected custom mode cannot leave a dangling selection. */
export const Personality = z
  .object({
    // An id this version doesn't know (0.1.9 had two other presets) falls back to the default.
    selected: z
      .preprocess(
        (value) => (typeof value === 'string' && !value.startsWith('custom:') && !['atelier', 'technical', 'relaxed'].includes(value) ? 'atelier' : value),
        z.union([z.enum(['atelier', 'technical', 'relaxed']), z.string().regex(/^custom:[a-zA-Z0-9_-]{1,64}$/)]),
      )
      .default('atelier'),
    customModes: z.array(CustomPersonality).max(CUSTOM_PERSONALITY_LIMIT).default([]),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.customModes.map((mode) => mode.id)).size !== value.customModes.length)
      ctx.addIssue({ code: 'custom', path: ['customModes'], message: 'Custom mode ids must be unique.' });
    if (
      value.selected.startsWith('custom:') &&
      !value.customModes.some((mode) => `custom:${mode.id}` === value.selected)
    )
      ctx.addIssue({ code: 'custom', path: ['selected'], message: 'Choose an existing custom mode.' });
  });
export type Personality = z.infer<typeof Personality>;

export const UserPrefs = z.object({
  appearance: z
    .object({
      theme: z.enum(['system', 'light', 'dark']).default('system'),
      chatFont: z.enum(['serif', 'sans', 'system', 'dyslexic']).default('serif'),
      /** Menus, the sidebar and panels. */
      interfaceFont: z.enum(['sans', 'system', 'dyslexic']).default('sans'),
      textSize: z.enum(['s', 'm', 'l']).default('m'),
      transcriptWidth: z.enum(['narrow', 'medium', 'wide']).default('medium'),
      motion: z.enum(['system', 'reduced']).default('system'),
    })
    .default({
      theme: 'system',
      chatFont: 'serif',
      interfaceFont: 'sans',
      textSize: 'm',
      transcriptWidth: 'medium',
      motion: 'system',
    }),
  code: z
    .object({
      /** An installed monospace font by name; empty uses the bundled one. Quotes would break out of the CSS string. */
      font: z
        .string()
        .max(100)
        .regex(/^[^"\\\p{Cc}]*$/u, 'Use the font’s name, without quotes')
        .default(''),
      /** Highlighting for code in the light and the dark app theme. */
      syntaxTheme: z
        .object({ light: SyntaxTheme.default('atelier-light'), dark: SyntaxTheme.default('atelier-dark') })
        .default({ light: 'atelier-light', dark: 'atelier-dark' }),
      /** How Code sessions open: tool cards as usual, thinking expanded too, or every call's details expanded. */
      transcriptView: TranscriptView.default('normal'),
    })
    .default({ font: '', syntaxTheme: { light: 'atelier-light', dark: 'atelier-dark' }, transcriptView: 'normal' }),
  sidebar: SidebarView.default({
    status: 'active',
    environments: ['local', 'cloud', 'remote', 'ssh'],
    groupBy: 'folder',
    sortBy: 'activity',
    showEmptyGroups: false,
  }),
  remoteControl: z.boolean().default(true),
  thinking: z.boolean().default(true),
  language: z.string().default('en'),
  defaultMode: Mode.default('chat'),
  notifications: z
    .object({ taskFinished: z.boolean().default(true), permissionNeeded: z.boolean().default(true) })
    .default({ taskFinished: true, permissionNeeded: true }),
  /** How the assistant should address the person; the account name is used when empty. */
  callMe: z.string().max(80).default(''),
  personalization: z
    .object({
      instructions: z.string().max(20_000).default(''),
      responseStyle: z.enum(['default', 'concise', 'explanatory', 'formal']).default('default'),
      personality: Personality.default({ selected: 'atelier', customModes: [] }),
      /** The person's own ATELIER.md: a personal instruction file for their Code and Cowork sessions and sub-agents, kept by the backend so it works on a server too. */
      atelierMd: z.string().max(PERSONAL_INSTRUCTIONS_MAX).default(''),
    })
    .default({
      instructions: '',
      responseStyle: 'default',
      personality: { selected: 'atelier', customModes: [] },
      atelierMd: '',
    }),
  /** Preferred model per mode, chosen from the models the admin enabled. */
  models: z.object({ chat: z.string(), work: z.string(), code: z.string() }).partial().default({}),
  /** Chat: the offer under a reply that used the sandbox to continue in Cowork; off once dismissed. */
  chat: z.object({ coworkOffer: z.boolean().default(true) }).default({ coworkOffer: true }),
  /** Rules this person approved with "Always allow" (Claude Code syntax), on top of the system rules. */
  permissions: z.object({ allow: z.array(z.string()).default([]) }).default({ allow: [] }),
  /** Conversations untouched for this many days are deleted (pinned ones stay); null keeps everything. */
  privacy: z
    .object({
      historyRetentionDays: z.number().int().min(1).max(3650).nullable().default(null),
      /** Temporary chats: `private` keeps them out of history and memory; `fresh` also leaves out everything personal. */
      temporaryChats: TemporaryMode.default('private'),
    })
    .default({ historyRetentionDays: null, temporaryChats: 'private' }),
  /** Commit author for the Code view's git bar; empty fields fall back to the repository's git config. */
  git: z
    .object({ authorName: z.string().max(200).default(''), authorEmail: z.string().max(320).default('') })
    .default({ authorName: '', authorEmail: '' }),
  /** Memory (Settings › Memory): searching past chats, remembering from chats, and whether sensitive topics may be kept. */
  memory: z
    .object({
      searchChats: z.boolean().default(true),
      generate: z.boolean().default(true),
      sensitive: z.boolean().default(false),
    })
    .default({ searchChats: true, generate: true, sensitive: false }),
  /** The SSH connections this person added in the desktop app (their passwords are secrets, kept apart). */
  ssh: z.object({ connections: z.array(SshConnection).default([]) }).default({ connections: [] }),
  /** The "What's new" dialog: the version whose release notes this person last saw (null: none yet). */
  whatsNew: z.object({ seen: z.string().max(40).nullable().default(null) }).default({ seen: null }),
});
export type UserPrefs = z.infer<typeof UserPrefs>;

export function defaultUserPrefs(): UserPrefs {
  return UserPrefs.parse({});
}
