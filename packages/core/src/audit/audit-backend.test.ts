/** The activity log through the real backend: the RPC gate writes it after admin calls, and only admins read it. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contract, createMemoryTransportPair, createRpcClient, type AppContract, type AuditEvent, type RpcClient } from '@atelier/protocol';
import { createBackend, type Backend } from '../backend/backend.ts';
import { openDatabase } from '../store/db.ts';
import { auditEvents } from '../store/schema.ts';

let dir: string;
let backend: Backend;
let admin: RpcClient<AppContract>;
let errors: string[];

const CANARY = 'sk-ant-api03-CANARYCANARYCANARY0123456789';

async function start(surface: 'web' | 'desktop' = 'web') {
  errors = [];
  backend = await createBackend({
    surface,
    configDir: dir,
    dataDir: dir,
    cipher: { encrypt: async (s) => s, decrypt: async (s) => s },
    env: {},
    logger: { info: () => {}, error: (m) => void errors.push(m) },
    fetch: async () => Promise.reject(new Error('offline')),
  });
}

function connect(ip = '203.0.113.9'): RpcClient<AppContract> {
  const [clientSide, serverSide] = createMemoryTransportPair();
  backend.connect(serverSide, { client: { clientKind: 'web', ip, userAgent: 'test' } });
  return createRpcClient(contract, clientSide);
}

const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { data?: { code?: string } }) => e.data?.code ?? String(e));

/** Everything written so far, oldest first. */
async function events(filter: { kind?: string; user?: string } = {}): Promise<AuditEvent[]> {
  // The log is written after the call has answered; opening the file waits for nothing, so let the queue drain first.
  await new Promise((r) => setTimeout(r, 30));
  return (await admin.call('audit.list', { ...filter, limit: 200 })).events.reverse();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atelier-audit-'));
  await start();
  admin = connect();
  await admin.call('auth.setup', { username: 'ada', name: 'Ada', password: 'correct horse', clientKind: 'web' });
});
afterEach(async () => {
  await backend.dispose();
  await rm(dir, { recursive: true, force: true });
});

describe('the activity log behind the RPC gate', () => {
  it('records an admin settings change with who, from where, the path and the small old and new values', async () => {
    await admin.call('settings.set', { layer: 'global', path: ['server', 'signup'], value: 'open' });
    const [change] = (await events({ kind: 'settings' }));
    expect(change).toMatchObject({ kind: 'settings.changed', actor: 'ada', ip: '203.0.113.9', target: 'server.signup', detail: { from: 'invite', to: 'open' } });
    expect(change!.actorId).toEqual(expect.any(String));
  });

  it('records the people calls and the invite, and the invite being used from another address', async () => {
    const { user, temporaryPassword } = await admin.call('users.create', { username: 'bob', name: 'Bob', role: 'user' });
    await admin.call('users.update', { id: user.id, role: 'admin' });
    await admin.call('users.update', { id: user.id, disabled: true });
    await admin.call('users.update', { id: user.id, disabled: false });
    await admin.call('users.resetPassword', { id: user.id });
    const { code: invite } = await admin.call('invites.create', { role: 'user' });
    const stranger = connect('198.51.100.4');
    await stranger.call('auth.acceptInvite', { invite, username: 'cy', name: 'Cy', password: 'cy-password-1', clientKind: 'web' });
    await admin.call('users.delete', { id: user.id });

    const all = await events();
    expect(all.map((e) => `${e.kind}:${e.target ?? ''}`)).toEqual(
      expect.arrayContaining([
        'account.created:bob', 'account.role_changed:bob', 'account.disabled:bob', 'account.enabled:bob', 'account.password_reset:bob',
        'invite.created:' + all.find((e) => e.kind === 'invite.created')!.target, 'account.created:cy', 'invite.used:' + all.find((e) => e.kind === 'invite.used')!.target, 'account.deleted:bob',
      ]),
    );
    expect(all.find((e) => e.kind === 'invite.used')).toMatchObject({ actor: 'cy', ip: '198.51.100.4' });
    expect(all.find((e) => e.kind === 'account.deleted')).toMatchObject({ actor: 'ada', target: 'bob' });
    // Neither the temporary password nor the invite code is in anything.
    expect(JSON.stringify(all)).not.toContain(temporaryPassword);
    expect(JSON.stringify(all)).not.toContain(invite.replace(/-/g, ''));
  });

  it('records sign-ins and failed sign-ins over the RPC, with the address and no password', async () => {
    await connect('192.0.2.1').call('auth.login', { username: 'ada', password: 'Wrong-Password-1', clientKind: 'web' }).catch(() => undefined);
    await connect('192.0.2.2').call('auth.login', { username: 'ada', password: 'correct horse', clientKind: 'web' });
    const rows = await events({ kind: 'signin' });
    expect(rows.map((e) => `${e.kind}:${e.ip}`)).toEqual(expect.arrayContaining(['signin.failed:192.0.2.1', 'signin.success:192.0.2.2']));
    expect(JSON.stringify(rows)).not.toMatch(/Wrong-Password|correct horse/);
  });

  it('records secrets by id, providers (text and image), connectors, plugins and models without any secret value', async () => {
    await admin.call('secrets.set', { id: 'openai', label: 'OpenAI', kind: 'api_key', value: CANARY });
    await admin.call('secrets.set', { id: 'openai', label: 'OpenAI', kind: 'api_key', value: `${CANARY}2` });
    await admin.call('providers.save', { id: 'home', type: 'ollama', name: 'Home', baseUrl: 'http://10.0.0.5:11434', headers: { Authorization: CANARY }, enabled: true });
    await admin.call('providers.save', { id: 'home', type: 'ollama', name: 'Home', baseUrl: 'http://10.0.0.5:11434', headers: {}, enabled: false });
    await admin.call('imageProviders.save', { id: 'comfy', type: 'comfyui', name: 'Comfy', baseUrl: 'http://10.0.0.6:8188', enabled: true } as never);
    await admin.call('settings.set', { layer: 'global', path: ['mcpServers', 'files'], value: { command: 'node', args: ['server.js'], env: { TOKEN: CANARY } } });
    await admin.call('settings.set', { layer: 'global', path: ['models', 'overrides', 'home:llama3', 'hidden'], value: true });
    await admin.call('settings.set', { layer: 'global', path: ['models', 'overrides', 'home:llama3', 'hidden'], value: false });
    await admin.call('settings.set', { layer: 'global', path: ['imageGeneration', 'maxImagesPerUserPerDay'], value: 20 });
    await admin.call('settings.set', { layer: 'global', path: ['enabledPlugins', 'p@m'], value: false });
    await admin.call('providers.remove', { id: 'home' });
    await admin.call('imageProviders.remove', { id: 'comfy' });
    await admin.call('secrets.delete', { id: 'openai' });
    await admin.call('instructions.set', { content: `Use ${CANARY}` });

    const all = await events();
    const kinds = all.map((e) => e.kind);
    for (const kind of ['secret.created', 'secret.rotated', 'secret.deleted', 'provider.added', 'provider.changed', 'provider.removed', 'connector.added', 'model.hidden', 'model.unhidden', 'limits.changed', 'plugin.disabled', 'settings.instructions']) {
      expect(kinds, kind).toContain(kind);
    }
    expect(all.filter((e) => e.kind.startsWith('provider.')).map((e) => e.detail?.family)).toEqual(expect.arrayContaining(['text', 'image']));
    expect(all.find((e) => e.kind === 'connector.added')).toMatchObject({ target: 'files' });
    expect(JSON.stringify(all)).not.toContain('CANARY');
  });

  it('does not record calls that failed, or that only read', async () => {
    const me = (await admin.call('account.get', {})).id;
    expect(await code(admin.call('users.delete', { id: me }))).toBe('forbidden');
    await code(admin.call('settings.set', { layer: 'global', path: ['server', 'signup'], value: 'not-a-policy' }));
    await admin.call('users.list', {});
    await admin.call('providers.status', {});
    await admin.call('invites.list', {});
    expect((await events()).filter((e) => e.kind !== 'signin.success' && e.kind !== 'account.created')).toEqual([]);
  });

  it('is for admins only, to read and to export', async () => {
    const { user, temporaryPassword } = await admin.call('users.create', { username: 'bob', name: 'Bob', role: 'user' });
    expect(user.role).toBe('user');
    const bob = connect();
    await bob.call('auth.login', { username: 'bob', password: temporaryPassword, clientKind: 'web' });
    await bob.call('account.changePassword', { current: temporaryPassword, next: 'bob-new-password' });
    expect(await code(bob.call('audit.list', {}))).toBe('forbidden');
    expect(await code(bob.call('audit.export', {}))).toBe('forbidden');
    expect(await code(connect().call('audit.list', {}))).toBe('unauthenticated');
  });

  it('exports as JSON with the retention period, and records that it did', async () => {
    await admin.call('settings.set', { layer: 'global', path: ['server', 'signup'], value: 'open' });
    await new Promise((r) => setTimeout(r, 30));
    const out = await admin.call('audit.export', { kind: 'settings' });
    expect(out).toMatchObject({ retentionDays: 90, truncated: false });
    expect(out.events.map((e) => e.kind)).toEqual(['settings.changed']);
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
    expect((await events({ kind: 'audit' }))[0]).toMatchObject({ kind: 'audit.exported', actor: 'ada', detail: { kind: 'settings', events: 1 } });
  });

  it('keeps the retention period in settings and reports it', async () => {
    expect((await admin.call('audit.list', {})).retentionDays).toBe(90);
    await admin.call('settings.set', { layer: 'global', path: ['audit', 'retentionDays'], value: 30 });
    expect((await admin.call('audit.list', {})).retentionDays).toBe(30);
    expect(await code(admin.call('settings.set', { layer: 'global', path: ['audit', 'retentionDays'], value: 3 }))).toBe('invalid_setting');
    expect(await code(admin.call('settings.set', { layer: 'global', path: ['audit', 'retentionDays'], value: 4000 }))).toBe('invalid_setting');
    expect((await events({ kind: 'limits' }))[0]).toMatchObject({ target: 'audit.retentionDays', detail: { from: 90, to: 30 } });
  });

  it('never fails a call because the log cannot be written', async () => {
    const db = openDatabase(join(dir, 'atelier.db'));
    await db.run(sql`drop table audit_events`);
    db.$client.close();
    await expect(admin.call('settings.set', { layer: 'global', path: ['server', 'signup'], value: 'open' })).resolves.toEqual({ ok: true });
    await expect(admin.call('users.create', { username: 'bob', name: 'Bob', role: 'user' })).resolves.toMatchObject({ user: { username: 'bob' } });
    await new Promise((r) => setTimeout(r, 30));
    expect(errors).toContain('the activity log could not be written');
  });

  it('survives a restart: events written before it are still listed', async () => {
    await admin.call('settings.set', { layer: 'global', path: ['server', 'signup'], value: 'open' });
    await new Promise((r) => setTimeout(r, 30));
    await backend.dispose();
    await start();
    const again = connect();
    await again.call('auth.login', { username: 'ada', password: 'correct horse', clientKind: 'web' });
    admin = again;
    expect((await events({ kind: 'settings' })).map((e) => e.target)).toEqual(['server.signup']);
  });

  it('prunes events past the retention period when the backend starts', async () => {
    const db = openDatabase(join(dir, 'atelier.db'));
    await db.insert(auditEvents).values({ id: 'old', at: Date.now() - 120 * 24 * 3600_000, kind: 'settings.changed', actorId: null, actor: 'ada', target: 'x', summary: 'old one', detail: null, ip: null });
    db.$client.close();
    await backend.dispose();
    await start();
    admin = connect();
    await admin.call('auth.login', { username: 'ada', password: 'correct horse', clientKind: 'web' });
    await new Promise((r) => setTimeout(r, 100));
    expect((await events()).map((e) => e.summary)).not.toContain('old one');
  });
});

describe('a desktop app on its own backend', () => {
  it('writes nothing: it has one person and no page for it', async () => {
    await backend.dispose();
    await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp(join(tmpdir(), 'atelier-audit-'));
    await start('desktop');
    const own = connect();
    await own.call('auth.setupLocal', { name: 'Ada', clientKind: 'desktop' });
    await own.call('settings.set', { layer: 'global', path: ['server', 'signup'], value: 'open' });
    await new Promise((r) => setTimeout(r, 30));
    const db = openDatabase(join(dir, 'atelier.db'));
    const rows = await db.select().from(auditEvents).all();
    db.$client.close();
    expect(rows).toEqual([]);
    admin = own;
    expect((await own.call('auth.status', {})).local).toBe(true);
  });

});
