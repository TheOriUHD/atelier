import { describe, expect, it } from 'vitest';
import { ADMIN_PROCEDURES, contract, SettingsSchema, type UserSummary } from '@atelier/protocol';
import { AUDIT_RULES, auditEntry, describeSettingsChange, isSkip, type AuditEnv } from './audit-rules.ts';

/** A credential every test below must never find in the log. */
const CANARY = 'sk-ant-api03-CANARYCANARYCANARY0123456789';

const names = [...ADMIN_PROCEDURES].map(String);

describe('the activity log table', () => {
  it('has an entry for every admin procedure, so a new one cannot be forgotten', () => {
    const missing = names.filter((n) => !auditEntry(n));
    expect(missing).toEqual([]);
  });

  it('has no entry for a procedure that does not exist or is not an admin one', () => {
    const procedures = new Set(Object.keys(contract.procedures));
    const stray = Object.keys(AUDIT_RULES).filter((n) => !procedures.has(n) || !ADMIN_PROCEDURES.has(n as never));
    expect(stray).toEqual([]);
  });

  it('never marks a procedure that changes something as not recorded', () => {
    const changes = /\.(save|set|reset|remove|delete|create|update|install|uninstall|revoke|signIn|signOut|connect|disconnect|setEnabled|resetPassword|clear|setAutoLock|update|export)$/;
    const wrong = Object.entries(AUDIT_RULES).filter(([name, entry]) => isSkip(entry as never) && changes.test(name)).map(([name]) => name);
    expect(wrong).toEqual([]);
  });

  it('gives every "not recorded" procedure a reason', () => {
    for (const entry of Object.values(AUDIT_RULES)) if (isSkip(entry as never)) expect((entry as { skip: string }).skip.length).toBeGreaterThan(5);
  });
});

describe('describing a settings change', () => {
  const one = (path: (string | number)[], before: unknown, after: unknown, op: 'set' | 'reset' = 'set') => {
    const drafts = describeSettingsChange(op, 'global', path, before, after);
    expect(drafts).toHaveLength(1);
    return drafts[0]!;
  };

  it('keeps the path, and the old and new value when they are small', () => {
    expect(one(['server', 'signup'], 'invite', 'open')).toMatchObject({ kind: 'settings.changed', target: 'server.signup', detail: { path: 'server.signup', from: 'invite', to: 'open' } });
    expect(one(['capabilities', 'webFetch'], true, false).detail).toMatchObject({ from: true, to: false });
  });

  it('records limits as limits', () => {
    expect(one(['imageGeneration', 'maxImagesPerUserPerDay'], undefined, 20)).toMatchObject({ kind: 'limits.changed', detail: { to: 20 } });
    expect(one(['checkpoints', 'retentionDays'], 30, 7).kind).toBe('limits.changed');
    expect(one(['audit', 'retentionDays'], 90, 30).kind).toBe('limits.changed');
  });

  it('never keeps a value at a path that names a secret, however small', () => {
    for (const path of [['providers', 0, 'apiKey'], ['capabilities', 'webSearch', 'apiKey'], ['mcpServers', 'x', 'headers', 'Authorization'], ['capabilities', 'webSearch', 'url'], ['prompts', 'password'], ['hooks', 'Stop', 0, 'env']]) {
      const draft = describeSettingsChange('set', 'global', path, 'old-value', 'new-value')[0]!;
      const text = JSON.stringify(draft);
      expect(text).not.toContain('new-value');
      expect(text).not.toContain('old-value');
    }
  });

  it('drops values that look like credentials, are long, span lines or are paths, wherever they sit', () => {
    for (const value of [CANARY, 'Bearer abcdefghijklmnop', 'https://user:pass@host/x', 'x'.repeat(61), 'line one\nline two', '${secret:openai}', '/Users/someone/private', 'C:\\Users\\someone', { nested: CANARY }, ['a', CANARY]]) {
      const draft = one(['prompts', 'organizationInstructions'], 'before', value);
      expect(JSON.stringify(draft)).not.toContain('CANARY');
      expect(draft.detail).not.toHaveProperty('to');
      expect(draft.target).toBe('prompts.organizationInstructions');
    }
  });

  it('lists the names of the fields that changed in an object, not their values', () => {
    const draft = one(['server'], { signup: 'invite', token: CANARY }, { signup: 'open', token: 'other-secret-token-value' });
    expect(draft.detail).toMatchObject({ fields: 'signup' });
    expect(JSON.stringify(draft)).not.toContain('other-secret');
  });

  it('says a reset is a reset', () => {
    expect(one(['server', 'signup'], 'open', undefined, 'reset')).toMatchObject({ kind: 'settings.reset', detail: { reset: true, from: 'open' } });
  });

  it('notes the layer when it is not the system one', () => {
    expect(describeSettingsChange('set', 'project', ['context', 'autoCompactAt'], 0.8, 0.9)[0]!.detail).toMatchObject({ layer: 'project' });
  });

  it('records models hidden and shown, for text and image models', () => {
    expect(one(['models', 'overrides', 'ollama:llama3', 'hidden'], undefined, true)).toMatchObject({ kind: 'model.hidden', target: 'ollama:llama3', detail: { family: 'text' } });
    expect(one(['models', 'overrides', 'ollama:llama3', 'hidden'], true, false).kind).toBe('model.unhidden');
    expect(one(['models', 'overrides', 'ollama:llama3'], { hidden: true }, { hidden: false }).kind).toBe('model.unhidden');
    expect(one(['models', 'overrides', 'ollama:llama3', 'hidden'], true, undefined, 'reset').kind).toBe('model.unhidden');
    expect(one(['imageModels', 'overrides', 'comfy:x', 'hidden'], false, true)).toMatchObject({ kind: 'model.hidden', detail: { family: 'image' } });
    // Any other edit of a model is a change, and does not say hidden.
    expect(one(['models', 'overrides', 'ollama:llama3', 'temperature'], 0.2, 0.9).kind).toBe('model.changed');
    expect(one(['models', 'overrides', 'ollama:llama3', 'hidden'], true, true).kind).toBe('model.changed');
  });

  it('records connectors by name only, never their command, address, headers or variables', () => {
    const before = { keep: { command: 'node', args: ['a'] }, gone: { command: 'x' }, edit: { command: 'x', env: { TOKEN: CANARY } } };
    const after = { keep: { command: 'node', args: ['a'] }, edit: { command: 'x', env: { TOKEN: `${CANARY}2` } }, fresh: { url: `https://u:${CANARY}@h/mcp`, headers: { Authorization: CANARY } } };
    const drafts = describeSettingsChange('set', 'global', ['mcpServers'], before, after);
    expect(drafts.map((d) => `${d.kind}:${d.target}`).sort()).toEqual(['connector.added:fresh', 'connector.changed:edit', 'connector.removed:gone']);
    expect(JSON.stringify(drafts)).not.toContain('CANARY');
    expect(describeSettingsChange('set', 'global', ['mcpServers', 'solo'], undefined, { command: CANARY })[0]).toMatchObject({ kind: 'connector.added', target: 'solo' });
    expect(describeSettingsChange('reset', 'global', ['mcpServers', 'solo'], { command: 'x' }, undefined)[0]).toMatchObject({ kind: 'connector.removed' });
    expect(describeSettingsChange('set', 'global', ['mcpServers', 'solo', 'env', 'TOKEN'], 'a', CANARY)[0]).toMatchObject({ kind: 'connector.changed', target: 'solo' });
  });

  it('records plugins switched on and off', () => {
    expect(one(['enabledPlugins', 'a@b'], undefined, true)).toMatchObject({ kind: 'plugin.enabled', target: 'a@b' });
    expect(one(['enabledPlugins', 'a@b'], true, false).kind).toBe('plugin.disabled');
    expect(one(['extraKnownMarketplaces'], {}, { x: { source: { source: 'github', repo: 'o/r' } } }).kind).toBe('plugin.changed');
  });

  it('does not crash on any odd input', () => {
    for (const path of [[], [''], [0], ['a', 'b', 'c', 'd', 'e']] as (string | number)[][]) {
      for (const value of [undefined, null, 1, 'x', {}, [], { a: undefined }]) expect(() => describeSettingsChange('set', 'global', path, value, value)).not.toThrow();
    }
  });
});

describe('describing the other admin calls', () => {
  const user = (over: Partial<UserSummary> = {}): UserSummary => ({
    id: 'u1', username: 'bob', name: 'Bob', role: 'user', avatar: null, mustChangePassword: false, hasPassword: true, disabled: false, safeguards: 'inherit', createdAt: 0, lastActiveAt: null, ...over,
  });
  const env = (over: Partial<AuditEnv> = {}): AuditEnv => ({ settings: () => SettingsSchema.parse({}), user: async () => user(), secretIds: async () => new Set(['openai']), ...over });
  /** Runs a rule the way the backend does: `before` first, then `describe`. */
  async function run(name: string, input: unknown, result: unknown, e: AuditEnv = env()) {
    const entry = auditEntry(name)!;
    if (isSkip(entry)) throw new Error(`${name} is not recorded`);
    const before = await (entry.before as ((i: unknown, e: AuditEnv) => unknown) | undefined)?.(input, e);
    const out = (entry.describe as (c: unknown) => unknown)({ input, result, before, env: e });
    return (Array.isArray(out) ? out : out ? [out] : []) as { kind: string; target?: string; summary: string; detail?: Record<string, unknown> }[];
  }

  it('creates, disables, enables, approves and changes roles with the username, not the id', async () => {
    expect(await run('users.create', { username: 'bob', name: 'Bob', role: 'user' }, { user: user(), temporaryPassword: 'Tmp-Pass-123' })).toMatchObject([{ kind: 'account.created', target: 'bob' }]);
    const e = (prev: UserSummary) => env({ user: async () => prev });
    expect(await run('users.update', { id: 'u1', disabled: true }, user({ disabled: true }), e(user()))).toMatchObject([{ kind: 'account.disabled', target: 'bob' }]);
    expect(await run('users.update', { id: 'u1', disabled: false }, user(), e(user({ disabled: true })))).toMatchObject([{ kind: 'account.enabled' }]);
    expect(await run('users.update', { id: 'u1', role: 'admin' }, user({ role: 'admin' }), e(user()))).toMatchObject([{ kind: 'account.role_changed', detail: { from: 'user', to: 'admin' } }]);
    const approved = await run('users.update', { id: 'u1', role: 'user' }, user(), e(user({ role: 'pending' })));
    expect(approved[0]).toMatchObject({ kind: 'account.role_changed', detail: { from: 'pending', to: 'user' } });
    expect(approved[0]!.summary).toContain('Approved');
    const several = await run('users.update', { id: 'u1', role: 'admin', disabled: true, name: 'Robert' }, user({ role: 'admin', disabled: true, name: 'Robert' }), e(user()));
    expect(several.map((d) => d.kind)).toEqual(['account.role_changed', 'account.disabled', 'account.updated']);
    expect(await run('users.update', { id: 'u1' }, user(), e(user()))).toEqual([]);
  });

  it('keeps the username of a deleted account and of a reset password', async () => {
    expect(await run('users.delete', { id: 'u1' }, { ok: true })).toMatchObject([{ kind: 'account.deleted', target: 'bob' }]);
    expect(await run('users.resetPassword', { id: 'u1' }, { temporaryPassword: CANARY })).toMatchObject([{ kind: 'account.password_reset', target: 'bob' }]);
    expect(JSON.stringify(await run('users.resetPassword', { id: 'u1' }, { temporaryPassword: CANARY }))).not.toContain('CANARY');
    // The account vanished between the click and the log: the id is still better than nothing.
    expect(await run('users.delete', { id: 'gone' }, { ok: true }, env({ user: async () => null }))).toMatchObject([{ target: 'gone' }]);
  });

  it('records an invite without its code', async () => {
    const out = await run('invites.create', { role: 'user' }, { invite: { id: 'i1', role: 'user', hint: 'ABCD', expiresAt: 5 }, code: 'ABCD-EFGH-JKMN-PQRS' });
    expect(out).toMatchObject([{ kind: 'invite.created', target: 'i1', detail: { role: 'user' } }]);
    expect(JSON.stringify(out)).not.toContain('ABCD');
  });

  it('records secrets by id and kind: created or rotated, never the value', async () => {
    const input = { id: 'openai', label: 'OpenAI', kind: 'api_key', value: CANARY };
    const rotated = await run('secrets.set', input, {});
    expect(rotated).toMatchObject([{ kind: 'secret.rotated', target: 'openai' }]);
    const created = await run('secrets.set', { ...input, id: 'fresh' }, {});
    expect(created[0]!.kind).toBe('secret.created');
    expect(JSON.stringify([rotated, created])).not.toContain('CANARY');
    expect(await run('secrets.delete', { id: 'openai' }, { ok: true })).toMatchObject([{ kind: 'secret.deleted', target: 'openai' }]);
  });

  it('records providers added, changed and removed, text and image, with the host only and never a key', async () => {
    const settings = SettingsSchema.parse({
      providers: [{ id: 'old', type: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: '${secret:openai}' }],
      imageProviders: [{ id: 'comfy', type: 'comfyui', name: 'Comfy', baseUrl: 'http://10.0.0.5:8188' }],
    });
    const e = env({ settings: () => settings });
    const draft = { id: 'new', type: 'openai-compatible', name: 'Home', baseUrl: `http://user:${CANARY}@10.0.0.9:11434/v1?key=${CANARY}`, apiKey: CANARY, headers: { Authorization: CANARY }, enabled: true };
    const added = await run('providers.save', draft, draft, e);
    expect(added).toMatchObject([{ kind: 'provider.added', target: 'new', detail: { family: 'text', type: 'openai-compatible', host: '10.0.0.9' } }]);
    const changed = await run('providers.save', { ...draft, id: 'old', type: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: CANARY, headers: {} }, draft, e);
    expect(changed).toMatchObject([{ kind: 'provider.changed', target: 'old' }]);
    expect(changed[0]!.detail!.fields).toBe('apiKey');
    expect(await run('providers.remove', { id: 'old' }, { ok: true }, e)).toMatchObject([{ kind: 'provider.removed', target: 'old', detail: { type: 'openai' } }]);
    const image = await run('imageProviders.save', { ...draft, id: 'comfy', type: 'comfyui', baseUrl: 'http://10.0.0.5:8188', headers: {}, apiKey: undefined }, draft, e);
    expect(image).toMatchObject([{ kind: 'provider.changed', detail: { family: 'image' } }]);
    expect(await run('imageProviders.remove', { id: 'comfy' }, { ok: true }, e)).toMatchObject([{ kind: 'provider.removed', detail: { family: 'image' } }]);
    expect(JSON.stringify([added, changed, image])).not.toContain('CANARY');
  });

  it('records identity providers without the client secret', async () => {
    const out = await run('oidc.save', { name: 'Authentik', issuer: 'https://id.example', clientId: 'abc', clientSecret: CANARY, newAccounts: 'pending' }, { id: 'authentik' });
    expect(out).toMatchObject([{ kind: 'identity.saved', target: 'authentik' }]);
    expect(JSON.stringify(out)).not.toContain('CANARY');
  });

  it('records plugin, skill and server calls', async () => {
    expect(await run('plugins.install', { repo: `https://x:${CANARY}@github.com/o/r`, plugin: 'p' }, { id: 'p@o' })).toMatchObject([{ kind: 'plugin.installed', target: 'p@o' }]);
    expect(JSON.stringify(await run('plugins.install', { repo: `https://x:${CANARY}@github.com/o/r`, plugin: 'p' }, { id: 'p@o' }))).not.toContain('CANARY');
    expect(await run('plugins.setEnabled', { id: 'p@o', enabled: false }, { ok: true })).toMatchObject([{ kind: 'plugin.disabled' }]);
    expect(await run('plugins.uninstall', { id: 'p@o' }, { ok: true })).toMatchObject([{ kind: 'plugin.removed' }]);
    expect(await run('skills.install', { source: 'o/r' }, { installed: ['a', 'b'] })).toMatchObject([{ kind: 'skill.installed', target: 'a, b' }]);
    expect(await run('skills.uninstall', { name: 'a' }, { ok: true })).toMatchObject([{ kind: 'skill.removed' }]);
    expect(await run('mcp.signIn', { name: 'github' }, { url: `https://x/?token=${CANARY}` })).toMatchObject([{ kind: 'connector.signed_in', target: 'github' }]);
    expect(JSON.stringify(await run('mcp.signIn', { name: 'github' }, { url: `https://x/?token=${CANARY}` }))).not.toContain('CANARY');
    expect(await run('server.update', {}, {})).toMatchObject([{ kind: 'server.update_started' }]);
  });

  it('records the system instructions by length, not text', async () => {
    const out = await run('instructions.set', { content: `Always say ${CANARY}` }, { ok: true });
    expect(out).toMatchObject([{ kind: 'settings.instructions', detail: { characters: 11 + CANARY.length } }]);
    expect(JSON.stringify(out)).not.toContain('CANARY');
  });

  it('records what an export covered', async () => {
    expect(await run('audit.export', { user: 'bob', kind: 'account' }, { events: [1, 2, 3] })).toMatchObject([{ kind: 'audit.exported', detail: { user: 'bob', kind: 'account', events: 3 } }]);
  });
});
