/**
 * How each admin procedure shows up in the activity log (ARCHITECTURE §21). One table, `AUDIT_RULES`, keyed by the
 * procedure's name: the backend's `guarded` wrapper looks the call up here after it succeeds, so a procedure can't be
 * added to ADMIN_PROCEDURES and forgotten. The test next to this file fails when an admin procedure has no entry, and
 * when a procedure that changes something is marked as "not recorded".
 *
 * A rule describes; it never writes. It says what happened in words and in a few flat details, and it must not put a
 * secret there: ids and names yes, values only when `smallValue` allows them.
 */
import type { z } from 'zod';
import type { AppContract, Settings, UserSummary } from '@atelier/protocol';
import type { AuditDraft } from './audit-log.ts';
import { hostOf, oneLine, scrubText, secretPath, smallValue } from './audit-redact.ts';

type ProcedureName = keyof AppContract['procedures'];
type In<K extends ProcedureName> = z.infer<AppContract['procedures'][K]['input']>;
type Out<K extends ProcedureName> = z.infer<AppContract['procedures'][K]['output']>;

/** What a rule may look at besides the call itself. */
export interface AuditEnv {
  settings(): Settings;
  user(id: string): Promise<UserSummary | null>;
  secretIds(): Promise<ReadonlySet<string>>;
}

export interface AuditRule<K extends ProcedureName> {
  /** Runs before the handler, for what the handler is about to change (the old value, whether the thing existed). Failures are ignored. */
  before?(input: In<K>, env: AuditEnv): unknown;
  describe(call: { input: In<K>; result: Out<K>; before: unknown; env: AuditEnv }): AuditDraft | readonly AuditDraft[] | null;
}

/** A procedure that changes nothing, with the reason. */
export interface AuditSkip {
  skip: string;
}

export type AuditEntry<K extends ProcedureName> = AuditRule<K> | AuditSkip;

const rule = <K extends ProcedureName>(r: AuditRule<K>): AuditRule<K> => r;
const skip = (reason: string): AuditSkip => ({ skip: reason });

// ------------------------------------------------------------------ settings

type Path = readonly (string | number)[];

export function getAt(root: unknown, path: Path): unknown {
  let at: unknown = root;
  for (const key of path) {
    if (at === null || typeof at !== 'object') return undefined;
    at = (at as Record<string | number, unknown>)[key];
  }
  return at;
}

const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const dotted = (path: Path) => path.join('.');

/** A setting that caps something: counts, spending and how long things are kept. */
function isLimit(path: Path): boolean {
  const leaf = String(path.at(-1) ?? '');
  return /^max[A-Z]/.test(leaf) || /(Days|Limit|Limits)$/.test(leaf) || leaf === 'parallelRequests' || leaf === 'modelsAtOnce' || leaf === 'autoCompactAt';
}

/**
 * What a change to the system settings is, by where it is. `after` is undefined for a reset. Pure: the test feeds it
 * hostile paths and values.
 */
export function describeSettingsChange(op: 'set' | 'reset', layer: string, path: Path, before: unknown, after: unknown): AuditDraft[] {
  const where = dotted(path) || '(everything)';
  const place: Record<string, string> = layer === 'global' ? {} : { layer };
  const head = path[0];

  // Connectors: the names that appeared, vanished or changed. Never the command, address, headers or variables.
  if (head === 'mcpServers') {
    const names = (v: unknown): Record<string, unknown> => (path.length === 1 ? (plain(v) ? v : {}) : path.length === 2 && v !== undefined && v !== null ? { [String(path[1])]: v } : {});
    const was = names(before);
    const now = op === 'reset' ? {} : names(after);
    // A deeper path edits one connector in place.
    if (path.length > 2) return [{ kind: 'connector.changed', target: String(path[1]), summary: `Changed connector ${path[1]}`, detail: { ...place } }];
    const out: AuditDraft[] = [];
    for (const name of Object.keys(now)) {
      if (!(name in was)) out.push({ kind: 'connector.added', target: name, summary: `Added connector ${name}`, detail: place });
      else if (!same(was[name], now[name])) out.push({ kind: 'connector.changed', target: name, summary: `Changed connector ${name}`, detail: place });
    }
    for (const name of Object.keys(was)) if (!(name in now)) out.push({ kind: 'connector.removed', target: name, summary: `Removed connector ${name}`, detail: place });
    return out.length ? out : [{ kind: 'connector.changed', target: where, summary: `Saved connectors (no change)`, detail: place }];
  }

  // Plugins: switched on or off by name, or the marketplaces they come from.
  if (head === 'enabledPlugins' && path.length === 2) {
    const name = String(path[1]);
    if (op === 'reset') return [{ kind: 'plugin.changed', target: name, summary: `Plugin ${name} follows its default again`, detail: place }];
    return [{ kind: after ? 'plugin.enabled' : 'plugin.disabled', target: name, summary: `${after ? 'Enabled' : 'Disabled'} plugin ${name} for everyone`, detail: place }];
  }
  if (head === 'enabledPlugins' || head === 'extraKnownMarketplaces') return [{ kind: 'plugin.changed', target: where, summary: `Changed ${where}`, detail: place }];

  // Models hidden from, or shown to, everyone who is not an admin.
  if ((head === 'models' || head === 'imageModels') && path[1] === 'overrides' && path.length >= 3) {
    const ref = String(path[2]);
    const hiddenBefore = path.length === 3 ? plain(before) && before.hidden === true : before === true;
    const hiddenAfter = op === 'reset' ? false : path.length === 3 ? plain(after) && after.hidden === true : after === true;
    const touchesHidden = path.length === 3 || path[3] === 'hidden';
    if (touchesHidden && hiddenBefore !== hiddenAfter) {
      return [{ kind: hiddenAfter ? 'model.hidden' : 'model.unhidden', target: ref, summary: `${hiddenAfter ? 'Hid' : 'Showed'} model ${ref}`, detail: { family: head === 'models' ? 'text' : 'image', ...place } }];
    }
    return [{ kind: 'model.changed', target: ref, summary: `Changed settings of model ${ref}`, detail: { family: head === 'models' ? 'text' : 'image', field: path.length > 3 ? String(path[3]) : null, ...place } }];
  }

  if (head === 'providers' || head === 'imageProviders') {
    return [{ kind: 'provider.changed', target: where, summary: `Changed ${head === 'providers' ? 'text' : 'image'} provider settings (${where})`, detail: { ...place } }];
  }

  const detail: Record<string, string | number | boolean | null> = { path: where, ...place };
  if (op === 'reset') detail.reset = true;
  // The old and new value, when they are small and not a credential. Objects and secrets are named, not shown.
  if (!secretPath(path)) {
    const from = smallValue(before);
    const to = op === 'reset' ? undefined : smallValue(after);
    if (from !== undefined) detail.from = from;
    if (to !== undefined) detail.to = to;
    if (plain(after) && plain(before)) {
      const fields = Object.keys({ ...before, ...after }).filter((k) => !same(before[k], after[k]) && !secretPath([k]));
      if (fields.length) detail.fields = fields.slice(0, 8).join(', ');
    }
  }
  const verb = op === 'reset' ? 'Reset' : 'Changed';
  const shown = !secretPath(path) && 'to' in detail ? `${detail.from !== undefined ? `${String(detail.from)} → ` : ''}${String(detail.to)}` : '';
  const kind = isLimit(path) ? 'limits.changed' : op === 'reset' ? 'settings.reset' : 'settings.changed';
  return [{ kind, target: where, summary: `${verb} ${where}${shown ? `: ${shown}` : ''}`, detail }];
}

// ------------------------------------------------------------------ providers

/** Which fields of a drafted provider differ from the saved one. Names only: a key, header or address is never copied. */
function changedFields(draft: Record<string, unknown>, saved: Record<string, unknown> | undefined): string[] {
  if (!saved) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(draft)) {
    if (key === 'id' || value === undefined) continue;
    // A new key arrives raw; the saved one is a reference, so any key in the draft counts as a change.
    if (key === 'apiKey' || key === 'apiKeyFromEnv' || key === 'apiKeyFromProvider') {
      if (value) out.push('apiKey');
      continue;
    }
    if (!same(value, saved[key])) out.push(key);
  }
  return [...new Set(out)];
}

function providerDraft(family: 'text' | 'image') {
  return rule<'providers.save'>({
    before: (input, env) => (family === 'text' ? env.settings().providers : env.settings().imageProviders).find((p) => p.id === input.id) ?? null,
    describe: ({ input, before }) => {
      const draft = input as unknown as Record<string, unknown>;
      const saved = (before ?? undefined) as Record<string, unknown> | undefined;
      const label = family === 'text' ? 'provider' : 'image provider';
      const kind = (type: string) => (family === 'text' ? type : String(draft.preset ?? type));
      const host = typeof draft.baseUrl === 'string' ? hostOf(draft.baseUrl) : null;
      if (!saved) {
        return { kind: 'provider.added', target: input.id, summary: `Added ${label} ${input.name}`, detail: { family, type: kind(String(draft.type)), host, enabled: draft.enabled !== false } };
      }
      const fields = changedFields(draft, saved);
      return { kind: 'provider.changed', target: input.id, summary: `Changed ${label} ${input.name}`, detail: { family, type: kind(String(draft.type)), host, fields: fields.join(', ') || null } };
    },
  });
}

const providerRemoval = (family: 'text' | 'image') =>
  rule<'providers.remove'>({
    before: (input, env) => (family === 'text' ? env.settings().providers : env.settings().imageProviders).find((p) => p.id === input.id) ?? null,
    describe: ({ input, before }) => {
      const saved = before as { name?: string; type?: string } | null;
      return { kind: 'provider.removed', target: input.id, summary: `Removed ${family === 'text' ? 'provider' : 'image provider'} ${saved?.name ?? input.id}`, detail: { family, type: saved?.type ?? null } };
    },
  });

const connection = (what: string, kind: 'provider.connected' | 'provider.disconnected', target: string, verb: string) =>
  rule<'chatgpt.signIn'>({ describe: () => ({ kind, target, summary: `${verb} ${what}` }) });

// ------------------------------------------------------------------ the table

const userName = (c: { before: unknown; input: { id: string } }) => (c.before as UserSummary | null)?.username ?? c.input.id;
const lookUp = (input: { id: string }, env: AuditEnv) => env.user(input.id);

export const AUDIT_RULES = {
  // Settings: the generic path, classified by where it points.
  'settings.set': rule<'settings.set'>({
    before: (input, env) => getAt(env.settings(), input.path),
    describe: ({ input, before }) => describeSettingsChange('set', input.layer, input.path, before, input.value),
  }),
  'settings.reset': rule<'settings.reset'>({
    before: (input, env) => getAt(env.settings(), input.path),
    describe: ({ input, before }) => describeSettingsChange('reset', input.layer, input.path, before, undefined),
  }),
  'instructions.set': rule<'instructions.set'>({
    describe: ({ input }) => ({ kind: 'settings.instructions', target: 'AGENTS.md', summary: 'Changed the system instructions', detail: { characters: input.content.length } }),
  }),
  'instructions.get': skip('reads only'),

  // People
  'users.create': rule<'users.create'>({
    describe: ({ input, result }) => ({ kind: 'account.created', target: result.user.username, summary: `Created the account ${result.user.username}`, detail: { role: input.role, via: 'admin' } }),
  }),
  'users.update': rule<'users.update'>({
    before: lookUp,
    describe: ({ result, before }) => {
      const prev = before as UserSummary | null;
      const out: AuditDraft[] = [];
      const name = result.username;
      if (prev && prev.role !== result.role) {
        const approved = prev.role === 'pending';
        out.push({ kind: 'account.role_changed', target: name, summary: approved ? `Approved ${name} as ${result.role}` : `Changed the role of ${name} from ${prev.role} to ${result.role}`, detail: { from: prev.role, to: result.role } });
      }
      if (prev && prev.disabled !== result.disabled) out.push({ kind: result.disabled ? 'account.disabled' : 'account.enabled', target: name, summary: `${result.disabled ? 'Disabled' : 'Enabled'} the account ${name}` });
      const fields = [prev && prev.name !== result.name ? 'name' : '', prev && prev.safeguards !== result.safeguards ? 'safeguards' : ''].filter(Boolean);
      if (fields.length) {
        out.push({ kind: 'account.updated', target: name, summary: `Changed ${fields.join(' and ')} of ${name}`, detail: { fields: fields.join(', '), ...(fields.includes('safeguards') ? { safeguards: result.safeguards } : {}) } });
      }
      return out;
    },
  }),
  'users.resetPassword': rule<'users.resetPassword'>({
    before: lookUp,
    describe: (c) => ({ kind: 'account.password_reset', target: userName(c), summary: `Reset the password of ${userName(c)}` }),
  }),
  'users.delete': rule<'users.delete'>({
    before: lookUp,
    describe: (c) => ({ kind: 'account.deleted', target: userName(c), summary: `Deleted the account ${userName(c)} and everything it owned`, detail: { role: (c.before as UserSummary | null)?.role ?? null } }),
  }),
  'users.list': skip('reads only'),
  'invites.create': rule<'invites.create'>({
    describe: ({ input, result }) => ({ kind: 'invite.created', target: result.invite.id, summary: `Created an invite for a ${input.role}`, detail: { role: input.role, expiresAt: result.invite.expiresAt } }),
  }),
  'invites.revoke': rule<'invites.revoke'>({ describe: ({ input }) => ({ kind: 'invite.revoked', target: input.id, summary: 'Revoked an invite' }) }),
  'invites.list': skip('reads only'),
  'oidc.save': rule<'oidc.save'>({
    describe: ({ input, result }) => ({ kind: 'identity.saved', target: result.id, summary: `Saved the single sign-on provider ${input.name}`, detail: { newAccounts: input.newAccounts } }),
  }),
  'oidc.remove': rule<'oidc.remove'>({ describe: ({ input }) => ({ kind: 'identity.removed', target: input.id, summary: `Removed the single sign-on provider ${input.id}` }) }),
  'oidc.list': skip('reads only'),

  // Keys and secrets: ids and kinds, never a value.
  'secrets.set': rule<'secrets.set'>({
    before: async (input, env) => (await env.secretIds()).has(input.id),
    describe: ({ input, before }) => ({ kind: before ? 'secret.rotated' : 'secret.created', target: input.id, summary: `${before ? 'Replaced the value of' : 'Stored'} the secret ${input.id}`, detail: { secretKind: input.kind } }),
  }),
  'secrets.delete': rule<'secrets.delete'>({ describe: ({ input }) => ({ kind: 'secret.deleted', target: input.id, summary: `Deleted the secret ${input.id}` }) }),
  'secrets.list': skip('reads only'),

  // Providers, text and image
  'providers.save': providerDraft('text'),
  'providers.remove': providerRemoval('text'),
  'providers.status': skip('reads only'),
  'providers.detect': skip('looks for servers; stores nothing'),
  'providers.test': skip('a trial request; stores nothing'),
  'providers.refresh': skip('asks the providers again; stores nothing'),
  'models.probeTools': skip('a trial request; stores nothing'),
  'search.test': skip('a trial search; stores nothing'),
  'imageProviders.save': providerDraft('image') as unknown as AuditRule<'imageProviders.save'>,
  'imageProviders.remove': providerRemoval('image') as unknown as AuditRule<'imageProviders.remove'>,
  'imageProviders.status': skip('reads only'),
  'imageProviders.detect': skip('looks for servers; stores nothing'),
  'imageProviders.test': skip('a trial request; stores nothing'),
  'imageProviders.tryImage': skip('a trial image; stores nothing in settings'),
  'imageProviders.refresh': skip('asks the providers again; stores nothing'),
  'imageProviders.parseWorkflow': skip('reads a file; stores nothing'),
  'imageProviders.savedWorkflows': skip('reads only'),

  // Sign-ins to a provider account (the account's tokens are secrets and are not recorded)
  'chatgpt.signIn': connection('ChatGPT Plan', 'provider.connected', 'chatgpt', 'Started signing in to'),
  'chatgpt.signOut': connection('ChatGPT Plan', 'provider.disconnected', 'chatgpt', 'Signed out of') as unknown as AuditRule<'chatgpt.signOut'>,
  'chatgpt.status': skip('reads only'),
  'chatgpt.cancel': skip('abandons a sign-in that has not finished'),
  'copilot.signIn': connection('GitHub Copilot', 'provider.connected', 'copilot', 'Started signing in to') as unknown as AuditRule<'copilot.signIn'>,
  'copilot.signOut': connection('GitHub Copilot', 'provider.disconnected', 'copilot', 'Signed out of') as unknown as AuditRule<'copilot.signOut'>,
  'copilot.status': skip('reads only'),
  'copilot.cancel': skip('abandons a sign-in that has not finished'),
  'openrouter.connect': rule<'openrouter.connect'>({
    describe: ({ input }) => ({ kind: 'provider.connected', target: input.id, summary: `Started connecting OpenRouter as ${input.name}`, detail: { type: input.type } }),
  }),
  'openrouter.status': skip('reads only'),
  'openrouter.cancel': skip('abandons a sign-in that has not finished'),
  'chatgptChat.status': skip('reads only'),
  'chatgptChat.open': skip('shows the sign-in window on the desktop'),
  'chatgptChat.hide': skip('hides the sign-in window on the desktop'),
  'chatgptChat.disconnect': rule<'chatgptChat.disconnect'>({ describe: () => ({ kind: 'provider.disconnected', target: 'chatgpt-chat', summary: 'Disconnected ChatGPT Chat' }) }),

  // Connectors, plugins and skills
  'mcp.signIn': rule<'mcp.signIn'>({ describe: ({ input }) => ({ kind: 'connector.signed_in', target: input.name, summary: `Started signing in connector ${input.name}` }) }),
  'mcp.signOut': rule<'mcp.signOut'>({ describe: ({ input }) => ({ kind: 'connector.signed_out', target: input.name, summary: `Signed connector ${input.name} out` }) }),
  'mcp.cancelSignIn': skip('abandons a sign-in that has not finished'),
  'mcp.test': skip('a trial connection; stores nothing'),
  'mcp.import': skip('lists what could be imported; stores nothing'),
  'mcp.logs': skip('reads only'),
  'plugins.install': rule<'plugins.install'>({
    describe: ({ input, result }) => ({ kind: 'plugin.installed', target: result.id, summary: `Installed plugin ${input.plugin}`, detail: { source: scrubText(input.repo) } }),
  }),
  'plugins.uninstall': rule<'plugins.uninstall'>({ describe: ({ input }) => ({ kind: 'plugin.removed', target: input.id, summary: `Removed plugin ${input.id}` }) }),
  'plugins.setEnabled': rule<'plugins.setEnabled'>({
    describe: ({ input }) => ({ kind: input.enabled ? 'plugin.enabled' : 'plugin.disabled', target: input.id, summary: `${input.enabled ? 'Enabled' : 'Disabled'} plugin ${input.id} for everyone` }),
  }),
  'plugins.browse': skip('reads a marketplace; stores nothing'),
  'skills.install': rule<'skills.install'>({
    describe: ({ input, result }) => ({ kind: 'skill.installed', target: result.installed.join(', ') || null, summary: `Installed ${result.installed.length || 'no'} skill${result.installed.length === 1 ? '' : 's'}`, detail: { source: scrubText(input.source) } }),
  }),
  'skills.uninstall': rule<'skills.uninstall'>({ describe: ({ input }) => ({ kind: 'skill.removed', target: input.name, summary: `Removed skill ${input.name}` }) }),

  // The server itself
  'server.update': rule<'server.update'>({ describe: () => ({ kind: 'server.update_started', summary: 'Started a server update' }) }),
  'server.updates': skip('looks up the newest version; stores nothing'),
  'audit.list': skip('reading the log is not recorded; exporting it is'),
  'audit.export': rule<'audit.export'>({
    describe: ({ input, result }) => ({
      kind: 'audit.exported',
      summary: `Exported ${result.events.length} activity events`,
      detail: { kind: input.kind ?? null, user: input.user ? oneLine(input.user, 80) : null, events: result.events.length },
    }),
  }),

  // The desktop's screen lock; on a server these procedures answer "not available", so this is for completeness.
  'lock.set': rule<'lock.set'>({ describe: () => ({ kind: 'settings.changed', target: 'screen lock', summary: 'Set the screen lock' }) }),
  'lock.clear': rule<'lock.clear'>({ describe: () => ({ kind: 'settings.changed', target: 'screen lock', summary: 'Removed the screen lock' }) }),
  'lock.setAutoLock': rule<'lock.setAutoLock'>({ describe: ({ input }) => ({ kind: 'settings.changed', target: 'screen lock', summary: 'Changed when the screen locks', detail: { minutes: input.minutes } }) }),

  // The request inspector holds requests in memory only (ARCHITECTURE §14).
  'developer.requests': skip('reads only'),
  'developer.clearRequests': skip('empties an in-memory list'),
  'developer.reload': skip('reloads the windows; changes no data'),
} as const satisfies { [K in ProcedureName]?: AuditEntry<K> };

/** The entry for a procedure, if it has one. */
export function auditEntry(name: string): AuditEntry<ProcedureName> | undefined {
  return (AUDIT_RULES as Record<string, AuditEntry<ProcedureName> | undefined>)[name];
}

export function isSkip(entry: AuditEntry<ProcedureName>): entry is AuditSkip {
  return 'skip' in entry;
}
