import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP, contract, createMemoryTransportPair, createRpcClient, LOOP_MAX_PER_SESSION, LOOP_MAX_PER_USER, type AppContract, type RpcClient } from '@atelier/protocol';
import { ArtifactRepo } from '../artifacts/artifact-repo.ts';
import { SessionRepo } from '../sessions/session-repo.ts';
import { TEMPORARY_MAX_IDLE_MS } from '../sessions/temporary.ts';
import { openDatabase } from '../store/db.ts';
import { jsonResponse, sse, streamResponse } from '../providers/__fixtures__/harness.ts';
import { hostRunnerBinary, spawnRunner, type RunnerChannel } from '../workspaces/runner-client.ts';
import { ServerUpdates } from '../server-updates/server-updates.ts';
import { createBackend, type Backend } from './backend.ts';

let dir: string;
let backend: Backend;
let client: RpcClient<AppContract>;
let projectEvents: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atelier-backend-'));
  backend = await createBackend({
    surface: 'web',
    configDir: dir,
    dataDir: dir,
    cipher: { encrypt: async (s) => s, decrypt: async (s) => s },
    env: {},
    logger: { info: () => {}, error: () => {} },
    fetch: async () => Promise.reject(new Error('offline')),
  });
  client = connect();
  await client.call('auth.setup', { username: 'ada', name: 'Ada', password: 'correct horse', clientKind: 'web' });
  projectEvents = 0;
  client.on('projects.changed', () => projectEvents++);
});

function connect(token?: string): RpcClient<AppContract> {
  const [clientSide, serverSide] = createMemoryTransportPair();
  backend.connect(serverSide, { ...(token ? { token } : {}), client: { clientKind: 'web', ip: '127.0.0.1', userAgent: 'test' } });
  return createRpcClient(contract, clientSide);
}

async function signedIn(username: string, password: string): Promise<RpcClient<AppContract>> {
  const c = connect();
  await c.call('auth.login', { username, password, clientKind: 'web' });
  return c;
}

const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { data?: { code?: string } }) => e.data?.code ?? String(e));

afterEach(async () => {
  await backend.dispose();
  await rm(dir, { recursive: true, force: true });
});

describe('personal session controls', () => {
  it('defaults remote access on and enforces account and session opt-outs for a second login', async () => {
    const other = await signedIn('ada', 'correct horse');
    const session = await client.call('sessions.create', { mode: 'chat' });
    expect(session).toMatchObject({ remoteControl: true, thinking: true });
    expect(await code(other.call('sessions.subscribe', { id: session.id }))).toBe('ok');
    await client.call('sessions.update', { id: session.id, remoteControl: false, thinking: false });
    expect(await code(other.call('sessions.subscribe', { id: session.id }))).toBe('not_found');
    expect(await other.call('sessions.list', {})).toEqual([]);
    expect(await code(client.call('sessions.subscribe', { id: session.id }))).toBe('ok');
    await client.call('sessions.update', { id: session.id, remoteControl: true });
    await client.call('prefs.set', { path: ['remoteControl'], value: false });
    expect(await code(other.call('sessions.subscribe', { id: session.id }))).toBe('not_found');
    expect(await code(client.call('sessions.subscribe', { id: session.id }))).toBe('ok');
    await client.call('prefs.set', { path: ['remoteControl'], value: true });
    expect(await code(other.call('sessions.subscribe', { id: session.id }))).toBe('ok');
  });
});

describe('backend projects', () => {
  it('announces project changes when chats join or leave a project, so chat counts stay current', async () => {
    const project = await client.call('projects.create', { name: 'Docs', description: '' });
    const loose = await client.call('sessions.create', { mode: 'chat' });
    projectEvents = 0;

    const inProject = await client.call('sessions.create', { mode: 'chat', projectId: project.id });
    expect(projectEvents).toBe(1);
    await client.call('sessions.update', { id: loose.id, projectId: project.id });
    expect(projectEvents).toBe(2);
    expect((await client.call('projects.list', {}))[0]!.sessionCount).toBe(2);

    await client.call('sessions.update', { id: loose.id, title: 'Renamed' });
    expect(projectEvents).toBe(2);
    await client.call('sessions.update', { id: loose.id, projectId: null });
    await client.call('sessions.delete', { id: inProject.id });
    expect(projectEvents).toBe(4);
    expect((await client.call('projects.list', {}))[0]!.sessionCount).toBe(0);
  });
});

describe('session groups, archive, unread and fork', () => {
  it('files sessions under the person’s groups, archives and marks them quietly, and forks', async () => {
    const group = await client.call('groups.create', { name: 'Aperture' });
    expect(await client.call('groups.list', {})).toEqual([expect.objectContaining({ id: group.id, name: 'Aperture', collapsed: false })]);
    expect(await client.call('groups.update', { id: group.id, collapsed: true })).toMatchObject({ collapsed: true });
    expect(await code(client.call('groups.update', { id: 'nope', name: 'x' }))).toBe('not_found');

    const s = await client.call('sessions.create', { mode: 'code', groupId: group.id });
    expect(s.groupId).toBe(group.id);
    const before = (await client.call('sessions.list', { mode: 'code' }))[0]!.updatedAt;
    // Housekeeping doesn't count as activity.
    const moved = await client.call('sessions.update', { id: s.id, groupId: null, unread: true });
    expect(moved).toMatchObject({ groupId: null, finishedUnseen: true, updatedAt: before });
    expect(await code(client.call('sessions.update', { id: s.id, groupId: 'nope' }))).toBe('not_found');
    await client.call('sessions.markSeen', { id: s.id });
    expect((await client.call('sessions.list', { mode: 'code' }))[0]).toMatchObject({ finishedUnseen: false });

    await client.call('sessions.update', { id: s.id, archived: true });
    expect(await client.call('sessions.list', { mode: 'code' })).toEqual([]);
    expect(await client.call('sessions.list', { mode: 'code', archived: 'archived' })).toEqual([expect.objectContaining({ id: s.id })]);
    await client.call('sessions.update', { id: s.id, archived: false, groupId: group.id });

    const copy = await client.call('sessions.fork', { id: s.id });
    expect(copy).toMatchObject({ mode: 'code', groupId: group.id });
    expect(copy.id).not.toBe(s.id);

    await client.call('groups.delete', { id: group.id });
    expect((await client.call('sessions.list', { mode: 'code' })).every((x) => x.groupId === null)).toBe(true);
    expect(await client.call('groups.list', {})).toEqual([]);
  });
});

describe('pins', () => {
  it('pins a project without counting it as an update', async () => {
    const project = await client.call('projects.create', { name: 'Docs', description: '' });
    const pinned = await client.call('projects.update', { id: project.id, pinned: true });
    expect(pinned.pinnedAt).toEqual(expect.any(Number));
    expect(pinned.updatedAt).toBe(project.updatedAt);
    expect((await client.call('projects.list', {}))[0]!.pinnedAt).toBe(pinned.pinnedAt);
    expect((await client.call('projects.update', { id: project.id, pinned: false })).pinnedAt).toBeNull();
  });

  it('keeps Research on a session until it is switched off', async () => {
    const created = await client.call('sessions.create', { mode: 'chat', research: true, connectorsOff: ['github'] });
    expect(created).toMatchObject({ research: true, connectorsOff: ['github'] });
    const off = await client.call('sessions.update', { id: created.id, research: false });
    expect(off).toMatchObject({ research: false, connectorsOff: ['github'] });
    expect((await client.call('sessions.list', {}))[0]).toMatchObject({ research: false, produced: false });
  });

  it('keeps Ultracode for Code sessions only; Chat and Cowork get Max', async () => {
    const chat = await client.call('sessions.create', { mode: 'chat', effort: 'ultracode' });
    expect(chat.effort).toBe('max');
    expect((await client.call('sessions.update', { id: chat.id, effort: 'ultracode' })).effort).toBe('max');
    const code = await client.call('sessions.create', { mode: 'code' });
    expect((await client.call('sessions.update', { id: code.id, effort: 'ultracode' })).effort).toBe('ultracode');
    expect((await client.call('sessions.update', { id: code.id, effort: 'xhigh' })).effort).toBe('xhigh');
  });
});

describe('artifacts page', () => {
  it('lists the person’s own artifacts across chats, newest first, a page at a time and by type', async () => {
    const { code: invite } = await client.call('invites.create', { role: 'user' });
    const bob = connect();
    await bob.call('auth.acceptInvite', { invite, username: 'bob', name: 'Bob', password: 'bob-password', clientKind: 'web' });
    const first = await client.call('sessions.create', { mode: 'chat' });
    const second = await client.call('sessions.update', { id: (await client.call('sessions.create', { mode: 'chat' })).id, title: 'Charts' });
    const bobs = await bob.call('sessions.create', { mode: 'chat' });

    // Artifacts are made by the model's artifact tool; write them the way it does, through a second connection.
    const db = openDatabase(join(dir, 'atelier.db'));
    const repo = new ArtifactRepo(db);
    const make = (sessionId: string, title: string, type: 'html' | 'svg' = 'html') => repo.create({ sessionId, identifier: title, type, title, language: null, content: '<p>x</p>', messageId: null });
    const page = await make(first.id, 'Page');
    await new Promise((r) => setTimeout(r, 2));
    await make(second.id, 'Logo', 'svg');
    await new Promise((r) => setTimeout(r, 2));
    const chart = await make(second.id, 'Chart');
    await make(bobs.id, 'Not yours');
    await new Promise((r) => setTimeout(r, 2));
    // A new version moves an artifact to the top.
    await repo.addVersion((await repo.findByIdentifier(first.id, 'Page'))!, '<p>y</p>', null);
    db.$client.close();

    const all = await client.call('artifacts.listAll', {});
    expect(all.items.map((a) => [a.title, a.sessionTitle, a.versions])).toEqual([
      ['Page', '', 2],
      ['Chart', 'Charts', 1],
      ['Logo', 'Charts', 1],
    ]);
    expect(all.nextCursor).toBeNull();

    const one = await client.call('artifacts.listAll', { limit: 1 });
    expect(one.items.map((a) => a.id)).toEqual([page.id]);
    const two = await client.call('artifacts.listAll', { limit: 1, cursor: one.nextCursor! });
    expect(two.items.map((a) => a.id)).toEqual([chart.id]);
    expect((await client.call('artifacts.listAll', { type: 'svg' })).items.map((a) => a.title)).toEqual(['Logo']);
    expect((await bob.call('artifacts.listAll', {})).items.map((a) => a.title)).toEqual(['Not yours']);
    await expect(client.call('artifacts.listAll', { cursor: 'nonsense' })).rejects.toThrow('Invalid params');
  });
});

describe('temporary chats', () => {
  const platform = () => ({
    surface: 'web' as const,
    configDir: dir,
    dataDir: dir,
    cipher: { encrypt: async (s: string) => s, decrypt: async (s: string) => s },
    env: {},
    logger: { info: () => {}, error: () => {} },
    fetch: async () => Promise.reject(new Error('offline')),
  });
  /** A second window of Ada's, with the function that closes it. */
  const secondWindow = async () => {
    const [clientSide, serverSide] = createMemoryTransportPair();
    const close = backend.connect(serverSide, { client: { clientKind: 'web', ip: '127.0.0.1', userAgent: 'test' } });
    const c = createRpcClient(contract, clientSide);
    await c.call('auth.login', { username: 'ada', password: 'correct horse', clientKind: 'web' });
    return { c, close };
  };
  // Asks without opening it, which would keep it.
  const exists = async (c: RpcClient<AppContract>, id: string) => (await code(c.call('sideChats.list', { sessionId: id }))) === 'ok';

  it('stays out of lists, search, project counts and the artifacts page', async () => {
    const project = await client.call('projects.create', { name: 'Docs', description: '' });
    const kept = await client.call('sessions.create', { mode: 'chat' });
    const temp = await client.call('sessions.create', { mode: 'chat', temporary: true, projectId: project.id });
    expect(temp.temporary).toBe('private');
    await client.call('sessions.update', { id: temp.id, title: 'Secret plans' });

    const db = openDatabase(join(dir, 'atelier.db'));
    const repo = new SessionRepo(db);
    await repo.insertMessage({ id: 'm1', sessionId: temp.id, parentId: null, role: 'user', parts: [{ type: 'text', text: 'zebracorn' }], model: null, usage: null, stopReason: null, error: null, kind: 'normal', summarizesThroughId: null });
    await new ArtifactRepo(db).create({ sessionId: temp.id, identifier: 'a', type: 'html', title: 'Hidden', language: null, content: '<p>x</p>', messageId: null });
    db.$client.close();

    expect((await client.call('sessions.list', { archived: 'all' })).map((s) => s.id)).toEqual([kept.id]);
    expect(await client.call('sessions.list', { query: 'zebracorn' })).toEqual([]);
    expect(await client.call('sessions.list', { query: 'Secret' })).toEqual([]);
    expect(await client.call('sessions.list', { projectId: project.id })).toEqual([]);
    expect((await client.call('projects.list', {}))[0]!.sessionCount).toBe(0);
    expect((await client.call('artifacts.listAll', {})).items).toEqual([]);
    // Only chats are temporary.
    expect(await code(client.call('sessions.create', { mode: 'code', temporary: true }))).toBe('unsupported');
    expect(await code(client.call('sessions.continueInCowork', { id: temp.id }))).toBe('unsupported');
  });

  it('starts in the mode the person chose in Settings', async () => {
    await client.call('prefs.set', { path: ['privacy', 'temporaryChats'], value: 'fresh' });
    expect((await client.call('sessions.create', { mode: 'chat', temporary: true })).temporary).toBe('fresh');
    expect((await client.call('sessions.create', { mode: 'chat' })).temporary).toBeNull();
  });

  it('is deleted when the last window that has it open leaves it', async () => {
    const other = await secondWindow();
    const temp = await client.call('sessions.create', { mode: 'chat', temporary: true });
    await client.call('sessions.subscribe', { id: temp.id });
    await other.c.call('sessions.subscribe', { id: temp.id });
    const removed: string[] = [];
    client.on('sessions.removed', ({ id }) => removed.push(id));

    expect(await client.call('sessions.leave', { id: temp.id })).toEqual({ deleted: false });
    expect(await other.c.call('sessions.leave', { id: temp.id })).toEqual({ deleted: true });
    expect(await exists(client, temp.id)).toBe(false);
    expect(removed).toEqual([temp.id]);

    // Leaving an ordinary chat only unsubscribes.
    const kept = await client.call('sessions.create', { mode: 'chat' });
    expect(await client.call('sessions.leave', { id: kept.id })).toEqual({ deleted: false });
    expect(await exists(client, kept.id)).toBe(true);
    other.close();
  });

  it('is deleted a minute after its window closes, unless a window opens it again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const closing = await secondWindow();
      const gone = await client.call('sessions.create', { mode: 'chat', temporary: true });
      const reopened = await client.call('sessions.create', { mode: 'chat', temporary: true });
      await closing.c.call('sessions.subscribe', { id: gone.id });
      await closing.c.call('sessions.subscribe', { id: reopened.id });
      closing.close();
      await client.call('sessions.subscribe', { id: reopened.id });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await exists(client, gone.id)).toBe(true);
      await vi.advanceTimersByTimeAsync(31_000);
      expect(await exists(client, gone.id)).toBe(false);
      expect(await exists(client, reopened.id)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is swept on start when it has been idle for a day, and soon after when nobody reopens it', async () => {
    const old = await client.call('sessions.create', { mode: 'chat', temporary: true });
    const recent = await client.call('sessions.create', { mode: 'chat', temporary: true });
    const kept = await client.call('sessions.create', { mode: 'chat' });
    await backend.dispose();
    const db = openDatabase(join(dir, 'atelier.db'));
    db.$client.prepare('UPDATE sessions SET updated_at = ? WHERE id IN (?, ?)').run(Date.now() - TEMPORARY_MAX_IDLE_MS - 1000, old.id, kept.id);
    db.$client.close();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      backend = await createBackend(platform());
      client = await signedIn('ada', 'correct horse');
      expect(await exists(client, old.id)).toBe(false);
      expect(await exists(client, kept.id)).toBe(true);
      expect(await exists(client, recent.id)).toBe(true);
      await vi.advanceTimersByTimeAsync(61_000);
      expect(await exists(client, recent.id)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('slash menu', () => {
  it('offers skills people may start and custom commands, a skill winning a shared name', async () => {
    const add = async (path: string, text: string) => {
      await mkdir(join(dir, path, '..'), { recursive: true });
      await writeFile(join(dir, path), text);
    };
    await add('skills/pdf/SKILL.md', '---\nname: pdf\ndescription: Work with PDFs\nargument-hint: <file>\n---\nBody');
    await add('skills/quiet/SKILL.md', '---\nname: quiet\ndescription: Background only\nuser-invocable: false\n---\nBody');
    await add('commands/pdf.md', 'Shadowed by the skill');
    await add('commands/standup.md', '---\ndescription: Draft my standup\n---\nList what I did.');
    expect(await client.call('slash.list', {})).toEqual([
      { name: 'pdf', description: 'Work with PDFs', kind: 'skill', argumentHint: '<file>' },
      { name: 'standup', description: 'Draft my standup', kind: 'command' },
    ]);
  });
});

describe('system instructions', () => {
  it('reloads connectors and extension lists, and keeps no logs for unknown connectors', async () => {
    let changes = 0;
    client.on('extensions.changed', () => changes++);
    expect(await client.call('developer.reload', {})).toEqual({ ok: true });
    await vi.waitFor(() => expect(changes).toBe(1));
    expect(await code(client.call('mcp.logs', { name: 'nope' }))).toBe('not_found');
    expect(await client.call('developer.requests', {})).toEqual([]);
  });

  it('tells windows when a skill appears in this machine’s folders', async () => {
    let changes = 0;
    client.on('extensions.changed', () => changes++);
    // Give the watcher a moment to start on folders that don't exist yet.
    await new Promise((r) => setTimeout(r, 300));
    await mkdir(join(dir, 'skills', 'hello'), { recursive: true });
    await writeFile(join(dir, 'skills', 'hello', 'SKILL.md'), '---\nname: hello\ndescription: Says hello.\n---\nHi.');
    await vi.waitFor(() => expect(changes).toBeGreaterThan(0), { timeout: 2000 });
    expect((await client.call('skills.list', {})).map((s) => s.name)).toContain('hello');
  });

  it('lets an admin read and write the system AGENTS.md', async () => {
    expect(await client.call('instructions.get', {})).toEqual({ content: '' });
    await client.call('instructions.set', { content: 'Use pnpm.' });
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toBe('Use pnpm.');
    expect(await client.call('instructions.get', {})).toEqual({ content: 'Use pnpm.' });
  });
});

describe('accounts', () => {
  it('keeps each user’s chats and projects to themselves', async () => {
    const { temporaryPassword } = await client.call('users.create', { username: 'bob', name: 'Bob', role: 'user' });
    const bob = await signedIn('bob', temporaryPassword);
    expect(await code(bob.call('sessions.list', {}))).toBe('password_change_required');
    await bob.call('account.changePassword', { current: temporaryPassword, next: 'bob-new-password' });

    const adaChat = await client.call('sessions.create', { mode: 'chat' });
    await bob.call('sessions.create', { mode: 'chat' });
    expect(await bob.call('sessions.list', {})).toHaveLength(1);
    expect(await client.call('sessions.list', {})).toHaveLength(1);
    expect(await code(bob.call('sessions.subscribe', { id: adaChat.id }))).toBe('not_found');
    expect(await code(bob.call('chat.send', { sessionId: adaChat.id, parts: [{ type: 'text', text: 'hi' }] }))).toBe('not_found');
    await client.call('projects.create', { name: 'Private', description: '' });
    expect(await bob.call('projects.list', {})).toEqual([]);
  });

  it('refuses admin procedures to regular users and anonymous connections', async () => {
    const { code: invite } = await client.call('invites.create', { role: 'user' });
    const anon = connect();
    expect(await code(anon.call('sessions.list', {}))).toBe('unauthenticated');
    await anon.call('auth.acceptInvite', { invite, username: 'cy', name: 'Cy', password: 'cy-password', clientKind: 'web' });
    expect(await code(anon.call('providers.status', {}))).toBe('forbidden');
    expect(await code(anon.call('users.list', {}))).toBe('forbidden');
    expect(await code(anon.call('settings.set', { layer: 'global', path: ['server', 'signup'], value: 'open' }))).toBe('forbidden');
    expect(await code(anon.call('instructions.set', { content: 'x' }))).toBe('forbidden');
    expect(await code(anon.call('developer.requests', {}))).toBe('forbidden');
    expect(await code(anon.call('mcp.logs', { name: 'x' }))).toBe('forbidden');
    expect(await code(anon.call('usage.summary', { days: 7, timezoneOffset: 0, everyone: true }))).toBe('forbidden');
    expect(await anon.call('usage.summary', { days: 7, timezoneOffset: 0 })).toEqual([]);
    expect(await anon.call('stats.summary', { mode: 'code', days: 7, timezoneOffset: 0 })).toMatchObject({ sessions: 0, tokens: 0, days: [], models: [] });
    // Invites are single use.
    expect(await code(connect().call('auth.acceptInvite', { invite, username: 'dee', name: 'Dee', password: 'dee-password', clientKind: 'web' }))).toBe('invalid_invite');
  });

  it('holds open sign-ups until an admin approves them', async () => {
    expect(await code(connect().call('auth.signup', { username: 'eve', name: 'Eve', password: 'eve-password' }))).toBe('signup_closed');
    await client.call('settings.set', { layer: 'global', path: ['server', 'signup'], value: 'open' });
    await connect().call('auth.signup', { username: 'eve', name: 'Eve', password: 'eve-password' });
    expect(await code(signedIn('eve', 'eve-password'))).toBe('pending');
    const eve = (await client.call('users.list', {})).find((u) => u.username === 'eve')!;
    await client.call('users.update', { id: eve.id, role: 'user' });
    expect(await (await signedIn('eve', 'eve-password')).call('account.get', {})).toMatchObject({ username: 'eve', role: 'user' });
  });

  it('signs out other sessions on "log out everywhere" and never removes the last admin', async () => {
    const other = await signedIn('ada', 'correct horse');
    let signedOut = 0;
    other.on('auth.signedOut', () => signedOut++);
    await client.call('account.logoutEverywhere', {});
    expect(signedOut).toBe(1);
    expect(await code(other.call('sessions.list', {}))).toBe('unauthenticated');

    const again = await signedIn('ada', 'correct horse');
    const me = await again.call('account.get', {});
    expect(await code(again.call('users.update', { id: me.id, role: 'user' }))).toBe('last_admin');
  });

  it('shows people only the safeguards that apply to them, and admins all of them', async () => {
    const { code: invite } = await client.call('invites.create', { role: 'user' });
    const bob = connect();
    const { user } = await bob.call('auth.acceptInvite', { invite, username: 'bob', name: 'Bob', password: 'bob-password', clientKind: 'web' });
    const bobsSettings: { safeguards: unknown }[] = [];
    bob.on('settings.changed', (s) => bobsSettings.push(s.effective as { safeguards: unknown }));
    const safeguards = async (c: RpcClient<AppContract>) => ((await c.call('settings.get', {})).effective as { safeguards: unknown }).safeguards;
    const none = { enabled: false, categories: { sexual: false, hate: false, harassment: false, selfHarm: false }, profile: 'adult', crisisResources: '' };

    // Off for everyone: nothing applies, so nothing of the admin's settings shows.
    await client.call('settings.set', { layer: 'global', path: ['safeguards', 'crisisResources'], value: 'Call the 24-hour line.' });
    await client.call('settings.set', { layer: 'global', path: ['safeguards', 'categories', 'harassment'], value: true });
    expect(await safeguards(bob)).toEqual(none);
    // On for everyone: what applies, without the helpline text.
    await client.call('settings.set', { layer: 'global', path: ['safeguards', 'enabled'], value: true });
    const on = { enabled: true, categories: { sexual: true, hate: true, harassment: true, selfHarm: false }, profile: 'adult', crisisResources: '' };
    expect(await safeguards(bob)).toEqual(on);
    expect(bobsSettings.at(-1)!.safeguards).toEqual(on);
    // Turned off for Bob alone: nothing again, and his open windows hear it at once.
    await client.call('users.update', { id: user!.id, safeguards: 'off' });
    expect(await safeguards(bob)).toEqual(none);
    expect(bobsSettings.at(-1)!.safeguards).toEqual(none);
    // On for Bob while off for everyone.
    await client.call('settings.set', { layer: 'global', path: ['safeguards', 'enabled'], value: false });
    await client.call('users.update', { id: user!.id, safeguards: 'on' });
    expect(await safeguards(bob)).toEqual(on);
    expect(await safeguards(client)).toEqual({ enabled: false, categories: { sexual: true, hate: true, harassment: true, selfHarm: false }, profile: 'adult', crisisResources: 'Call the 24-hour line.' });
  });

  it('stores preferences per user and validates them', async () => {
    await client.call('prefs.set', { path: ['appearance', 'theme'], value: 'dark' });
    expect((await client.call('prefs.get', {})).appearance.theme).toBe('dark');
    expect(await code(client.call('prefs.set', { path: ['appearance', 'theme'], value: 'neon' }))).toBe('invalid_setting');
    // A person can't put an admin's setting into their own preferences.
    expect(await code(client.call('prefs.set', { path: ['safeguards'], value: 'off' }))).toBe('invalid_setting');
  });

  it('keeps a device id to each account that registers it', async () => {
    const mac = '6f1c2c8e-8a39-4a8e-9d55-0f0b6f5f6d7a';
    await client.call('devices.register', { id: mac, name: 'Ada’s Mac', platform: 'macOS' });
    // This connection is now another of Ada's devices; the Mac has no connection of Ada's.
    await client.call('devices.register', { id: '0b5e2a1d-3c4f-4e6a-8b7c-9d0e1f2a3b4c', name: 'Ada’s PC', platform: 'Windows' });
    const { temporaryPassword } = await client.call('users.create', { username: 'bob', name: 'Bob', role: 'user' });
    const bob = await signedIn('bob', temporaryPassword);
    await bob.call('account.changePassword', { current: temporaryPassword, next: 'bob-new-password' });
    await bob.call('devices.register', { id: mac, name: 'Bob’s copy', platform: 'Linux' });

    expect((await client.call('account.devices', {})).find((d) => d.id === mac)).toMatchObject({ name: 'Ada’s Mac', online: false });
    expect(await bob.call('account.devices', {})).toMatchObject([{ id: mac, name: 'Bob’s copy', online: true, current: true }]);
  });
});

describe('connectors', () => {
  it('shows connectors to everyone but their details only to admins, and starts no programs on the web', async () => {
    const changes: unknown[] = [];
    client.on('mcp.changed', (list) => changes.push(list));
    await client.call('settings.set', { layer: 'global', path: ['mcpServers', 'local'], value: { command: 'npx', args: ['-y', 'some-server'], env: { TOKEN: '${secret:local}' } } });
    const refused = { name: 'local', type: 'stdio', state: 'error', error: expect.stringContaining('only the desktop app'), tools: [] };
    expect(await client.call('mcp.status', {})).toEqual([refused]);
    expect(changes).toContainEqual([refused]);
    expect(await client.call('mcp.test', { name: 'local' })).toEqual(refused);
    expect(await code(client.call('mcp.test', { name: 'other' }))).toBe('not_found');
    expect(await code(client.call('mcp.import', {}))).toBe('unsupported');

    const { code: invite } = await client.call('invites.create', { role: 'user' });
    const user = connect();
    await user.call('auth.acceptInvite', { invite, username: 'cy', name: 'Cy', password: 'cy-password', clientKind: 'web' });
    expect(await user.call('mcp.status', {})).toEqual([{ name: 'local', type: 'stdio', state: 'error', tools: [] }]);
    expect(await code(user.call('mcp.test', { name: 'local' }))).toBe('forbidden');
    expect(await code(user.call('mcp.import', {}))).toBe('forbidden');
    expect((await user.call('settings.get', {})).effective).toMatchObject({ mcpServers: {} });

    await client.call('settings.set', { layer: 'global', path: ['hooks'], value: { Stop: [{ hooks: [{ type: 'command', command: 'notify-admin' }] }] } });
    await client.call('settings.set', { layer: 'global', path: ['capabilities', 'webSearch'], value: { enabled: true, provider: 'brave', apiKey: '${secret:brave}' } });
    await client.call('settings.set', { layer: 'global', path: ['prompts', 'organizationInstructions'], value: 'Mention the staff discount.' });
    const seen = JSON.stringify((await user.call('settings.get', {})).effective);
    expect(seen).not.toContain('notify-admin');
    expect(seen).not.toContain('secret:brave');
    expect(seen).not.toContain('staff discount');
    expect((await user.call('settings.get', {})).effective).toMatchObject({ capabilities: { webSearch: { enabled: true, provider: 'brave' } } });
  });
  it('keeps a session’s connector switches', async () => {
    const created = await client.call('sessions.create', { mode: 'chat', connectorsOff: ['github'] });
    expect(created.connectorsOff).toEqual(['github']);
    await client.call('sessions.update', { id: created.id, title: 'Renamed' });
    const updated = await client.call('sessions.update', { id: created.id, connectorsOff: ['github', 'notion'] });
    expect(updated).toMatchObject({ title: 'Renamed', connectorsOff: ['github', 'notion'] });
    expect((await client.call('sessions.list', {})).find((s) => s.id === created.id)?.connectorsOff).toEqual(['github', 'notion']);
  });

  it('says which provider or connector uses a secret', async () => {
    await client.call('secrets.set', { id: 'shared', label: 'Shared key', kind: 'api_key', value: 'sk-test-1234567890' });
    await client.call('settings.set', { layer: 'global', path: ['providers'], value: [{ id: 'acme', type: 'openai-compatible', name: 'Acme', baseUrl: 'http://127.0.0.1:9', apiKey: '${secret:shared}' }] });
    await client.call('settings.set', { layer: 'global', path: ['mcpServers', 'docs'], value: { type: 'http', url: 'https://mcp.example.com', headers: { Authorization: 'Bearer ${secret:shared}' } } });
    const [shared] = await client.call('secrets.list', {});
    expect(shared!.usedBy).toEqual(['providers.acme', 'mcpServers.docs.headers.Authorization']);
  });

  it('keeps people’s own secrets out of settings', async () => {
    const value = { type: 'http', url: 'https://collector.example/mcp', headers: { Authorization: 'Bearer ${secret:github-user-someone}' } };
    expect(await code(client.call('settings.set', { layer: 'global', path: ['mcpServers', 'leak'], value }))).toBe('forbidden');
    expect(await code(client.call('settings.set', { layer: 'global', path: ['capabilities', 'webSearch', 'apiKey'], value: '${secret:github-user-someone}' }))).toBe('forbidden');
    expect(await code(client.call('secrets.set', { id: 'github-user-someone', label: 'x', kind: 'github', value: 'x' }))).toBe('forbidden');
  });
});

const runnerDir = join(import.meta.dirname, '../../../../runner/bin');

describe('the ChatGPT subscription', () => {
  it('is available on a server and reports an unreachable sign-in service', async () => {
    expect(await client.call('chatgpt.status', {})).toEqual({ available: true, signedIn: false, signingIn: false });
    expect(await code(client.call('chatgpt.signIn', {}))).toBe('chatgpt_sign_in_failed');
    expect(await client.call('chatgpt.cancel', {})).toEqual({ ok: true });
  });

  it('uses device authorization on a server without a localhost callback', async () => {
    const home = await mkdtemp(join(tmpdir(), 'atelier-chatgpt-web-'));
    const requests: string[] = [];
    const web = await createBackend({
      surface: 'web', configDir: home, dataDir: home, env: {},
      cipher: { encrypt: async (s) => s, decrypt: async (s) => s },
      logger: { info: () => {}, error: () => {} },
      fetch: async (url) => {
        requests.push(String(url));
        if (String(url).endsWith('/deviceauth/usercode')) return jsonResponse({ device_auth_id: 'device-id', user_code: 'ABCD-1234', interval: '5' });
        return new Response(null, { status: 403 });
      },
    });
    try {
      const [clientSide, serverSide] = createMemoryTransportPair();
      web.connect(serverSide, { client: { clientKind: 'web', ip: '127.0.0.1', userAgent: 'test' } });
      const c = createRpcClient(contract, clientSide);
      expect(await code(c.call('chatgpt.signIn', {}))).not.toBe('ok');
      await c.call('auth.setup', { username: 'ada', name: 'Ada', password: 'correct horse', clientKind: 'web' });
      expect(await c.call('chatgpt.signIn', {})).toEqual({ url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' });
      expect(await c.call('chatgpt.status', {})).toMatchObject({ available: true, signingIn: true, device: { userCode: 'ABCD-1234' } });
      expect(requests).toContain('https://auth.openai.com/api/accounts/deviceauth/usercode');
      await c.call('chatgpt.cancel', {});
      expect(await c.call('chatgpt.status', {})).toMatchObject({ signingIn: false });
    } finally {
      await web.dispose();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('starts the browser sign-in on the desktop and can cancel it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'atelier-chatgpt-'));
    const desktop = await createBackend({
      surface: 'desktop',
      configDir: home,
      dataDir: join(home, 'data'),
      cipher: { encrypt: async (s) => s, decrypt: async (s) => s },
      // Port 0: any free one, so the test doesn't compete for the callback port.
      env: { ATELIER_CHATGPT_CALLBACK_PORT: '0' },
      logger: { info: () => {}, error: () => {} },
      fetch: async () => Promise.reject(new Error('offline')),
    });
    try {
      const [clientSide, serverSide] = createMemoryTransportPair();
      desktop.connect(serverSide, { client: { clientKind: 'desktop', ip: '127.0.0.1', userAgent: 'test' } });
      const c = createRpcClient(contract, clientSide);
      await c.call('auth.setup', { username: 'ada', name: 'Ada', password: 'correct horse', clientKind: 'desktop' });
      expect(await c.call('chatgpt.status', {})).toMatchObject({ available: true, signedIn: false, signingIn: false });
      const { url } = await c.call('chatgpt.signIn', {});
      expect(new URL(url).origin).toBe('https://auth.openai.com');
      expect(await c.call('chatgpt.status', {})).toMatchObject({ signingIn: true });
      await c.call('chatgpt.cancel', {});
      expect(await c.call('chatgpt.status', {})).toMatchObject({ signingIn: false, signedIn: false });
    } finally {
      await desktop.dispose();
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('GitHub Copilot', () => {
  it('can be signed in to on a server, and says why when GitHub can’t be reached', async () => {
    expect(await client.call('copilot.status', {})).toEqual({ signedIn: false, signingIn: false });
    expect(await code(client.call('copilot.signIn', {}))).toBe('copilot_sign_in_failed');
    expect(await client.call('copilot.cancel', {})).toEqual({ ok: true });
    expect(await client.call('copilot.signOut', {})).toEqual({ ok: true });
  });
});

describe('sessions without a folder', () => {
  it('get no scratch folder on the web, and none in Chat', async () => {
    expect(await code(client.call('sessions.create', { mode: 'code', scratch: {} }))).toBe('workspace_unavailable');
    expect(await code(client.call('sessions.create', { mode: 'chat', scratch: {} }))).toBe('unsupported');
    expect(await client.call('workspaces.list', {})).toEqual([]);
  });

  it.skipIf(!existsSync(hostRunnerBinary(runnerDir)))('each get a scratch folder of their own on the desktop, kept when the session goes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'atelier-desktop-'));
    const desktop = await createBackend({
      surface: 'desktop',
      configDir: home,
      dataDir: join(home, 'data'),
      runnerDir,
      cipher: { encrypt: async (s) => s, decrypt: async (s) => s },
      env: {},
      logger: { info: () => {}, error: () => {} },
      fetch: async () => Promise.reject(new Error('offline')),
    });
    try {
      const [clientSide, serverSide] = createMemoryTransportPair();
      desktop.connect(serverSide, { client: { clientKind: 'desktop', ip: '127.0.0.1', userAgent: 'test' } });
      const c = createRpcClient(contract, clientSide);
      await c.call('auth.setup', { username: 'ada', name: 'Ada', password: 'correct horse', clientKind: 'desktop' });
      const me = await c.call('account.get', {});
      const announced: number[] = [];
      c.on('workspaces.changed', (list) => announced.push(list.length));
      const first = await c.call('sessions.create', { mode: 'code', scratch: {} });
      const second = await c.call('sessions.create', { mode: 'work', scratch: {} });
      const folders = await c.call('workspaces.list', {});
      expect(folders.map((w) => w.id).sort()).toEqual([first.workspaceId, second.workspaceId].sort());
      expect(announced).toEqual([1, 2]);
      const scratch = folders.find((w) => w.id === first.workspaceId)!;
      expect(scratch).toMatchObject({ kind: 'local', scratch: true, available: true });
      expect(scratch.root).toBe(join(await realpath(join(home, 'data')), 'scratch-workspaces', me.id, scratch.name));
      expect(await code(c.call('sessions.create', { mode: 'code', scratch: {}, workspaceId: scratch.id }))).toBe('unsupported');

      // A scratch folder leaves the list with the last session that used it (/clear continues in it), never the disk.
      const cleared = await c.call('sessions.create', { mode: 'code', workspaceId: scratch.id });
      await c.call('sessions.delete', { id: first.id });
      expect((await c.call('workspaces.list', {})).map((w) => w.id).sort()).toEqual([first.workspaceId, second.workspaceId].sort());
      await c.call('sessions.delete', { id: cleared.id });
      expect((await c.call('workspaces.list', {})).map((w) => w.id)).toEqual([second.workspaceId]);
      expect(announced.at(-1)).toBe(1);
      expect(existsSync(scratch.root)).toBe(true);
      await c.call('privacy.deleteConversations', {});
      expect(await c.call('workspaces.list', {})).toEqual([]);
    } finally {
      await desktop.dispose();
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('personal instructions', () => {
  it.skipIf(!existsSync(hostRunnerBinary(runnerDir)))('reach a server session from the person’s own preferences, never another person’s', async () => {
    const home = await mkdtemp(join(tmpdir(), 'atelier-server-'));
    const systems: string[] = [];
    const reply = sse([{ data: { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] } }, { data: { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } } }], true);
    const server = await createBackend({
      surface: 'web',
      configDir: home,
      dataDir: home,
      cipher: { encrypt: async (s) => s, decrypt: async (s) => s },
      env: {},
      logger: { info: () => {}, error: () => {} },
      fetch: async (url, init) => {
        if (!String(url).endsWith('/chat/completions')) return jsonResponse({ data: [] });
        const body = JSON.parse(String(init.body)) as { messages: { role: string; content: unknown }[] };
        systems.push(JSON.stringify(body.messages.filter((m) => m.role === 'system')));
        return streamResponse(reply);
      },
    });
    const runners = new Map<string, RunnerChannel>();
    try {
      const signIn = () => {
        const [clientSide, serverSide] = createMemoryTransportPair();
        server.connect(serverSide, { client: { clientKind: 'web', ip: '127.0.0.1', userAgent: 'test' } });
        return createRpcClient(contract, clientSide);
      };
      const ada = signIn();
      await ada.call('auth.setup', { username: 'ada', name: 'Ada', password: 'correct horse', clientKind: 'web' });
      await ada.call('settings.set', { layer: 'global', path: ['providers'], value: [{ id: 'fake', type: 'openai-compatible', name: 'Fake', baseUrl: 'http://fake.test/v1', headers: {}, enabled: true }] });
      await ada.call('prefs.set', { path: ['personalization', 'atelierMd'], value: 'Ada likes tabs.' });
      await writeFile(join(home, 'ATELIER.md'), 'Server-wide rule.');
      const { temporaryPassword } = await ada.call('users.create', { username: 'bob', name: 'Bob', role: 'user' });
      const bob = signIn();
      await bob.call('auth.login', { username: 'bob', password: temporaryPassword, clientKind: 'web' });
      await bob.call('account.changePassword', { current: temporaryPassword, next: 'bob-new-password' });
      const { token } = await bob.call('auth.login', { username: 'bob', password: 'bob-new-password', clientKind: 'desktop' });
      await bob.call('prefs.set', { path: ['personalization', 'atelierMd'], value: 'Bob likes spaces.' });

      // Bob's desktop lends its runner to the server, as the desktop app does over its device link.
      const device = { id: '6f1c0a52-4a8e-4d7a-9f53-1d2a3b4c5d6e', name: 'Laptop', platform: process.platform };
      await bob.call('devices.register', device);
      let link: { receive(text: string): void } | null = null;
      link = await server.linkDevice(
        {
          send: (frame) => {
            if (frame.t === 'open') {
              const runner = spawnRunner({ binaryPath: hostRunnerBinary(runnerDir), roots: [frame.root] });
              runners.set(frame.channel, runner);
              runner.onLine((line) => link!.receive(JSON.stringify({ t: 'line', channel: frame.channel, line })));
              link!.receive(JSON.stringify({ t: 'opened', channel: frame.channel }));
            } else if (frame.t === 'line') runners.get(frame.channel)?.send(frame.line);
            else if (frame.t === 'close') runners.get(frame.channel)?.kill();
          },
          close: () => {},
        },
        token,
        device,
      );
      expect(link).not.toBeNull();
      const project = join(home, 'bob-project');
      await mkdir(project);
      await writeFile(join(project, 'ATELIER.md'), 'Project rule.');
      const workspace = await bob.call('workspaces.addLocal', { path: project });
      const session = await bob.call('sessions.create', { mode: 'code', workspaceId: workspace.id, model: 'fake/m' });
      await bob.call('chat.send', { sessionId: session.id, parts: [{ type: 'text', text: 'hi' }] });
      // The session's own request, not the one that titles it.
      const prompt = () => systems.find((text) => text.includes('Working directory'));
      await vi.waitFor(() => expect(prompt()).toBeDefined(), { timeout: 10_000 });
      const system = prompt()!;
      expect(system).toContain('Bob likes spaces.');
      expect(system).not.toContain('Ada likes tabs.');
      expect(system.indexOf('Server-wide rule.')).toBeLessThan(system.indexOf('Bob likes spaces.'));
      expect(system.indexOf('Bob likes spaces.')).toBeLessThan(system.indexOf('Project rule.'));
    } finally {
      for (const runner of runners.values()) runner.kill();
      await server.dispose();
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('a desktop lending itself to a server', () => {
  it.skipIf(!existsSync(hostRunnerBinary(runnerDir)))('takes SSH hosts and folders for sessions without one from the person’s desktop', async () => {
    const home = await mkdtemp(join(tmpdir(), 'atelier-lend-'));
    const server = await createBackend({ surface: 'web', configDir: home, dataDir: home, cipher: { encrypt: async (s) => s, decrypt: async (s) => s }, env: {}, logger: { info: () => {}, error: () => {} } });
    const runners = new Map<string, RunnerChannel>();
    try {
      const signIn = () => {
        const [clientSide, serverSide] = createMemoryTransportPair();
        server.connect(serverSide, { client: { clientKind: 'web', ip: '127.0.0.1', userAgent: 'test' } });
        return createRpcClient(contract, clientSide);
      };
      const browser = signIn();
      await browser.call('auth.setup', { username: 'ada', name: 'Ada', password: 'correct horse', clientKind: 'web' });
      const desktop = signIn();
      const { token } = await desktop.call('auth.login', { username: 'ada', password: 'correct horse', clientKind: 'desktop' });
      const device = { id: '6f1c0a52-4a8e-4d7a-9f53-1d2a3b4c5d6e', name: 'Laptop', platform: process.platform };
      await desktop.call('devices.register', device);
      expect((await desktop.call('app.info', {})).deviceLink).toEqual({ protocol: 2, services: ['runner', 'scratch', 'ssh'] });

      const scratchBase = join(home, 'laptop-scratch');
      let link: { receive(text: string): void } | null = null;
      const reply = (frame: object) => link!.receive(JSON.stringify(frame));
      link = await server.linkDevice(
        {
          send: (frame) => {
            if (frame.t === 'req') {
              const { request } = frame;
              if (request.op === 'ssh.hosts') return reply({ t: 'res', id: frame.id, ok: true, value: ['gpu', 'pi'] });
              if (request.op === 'scratch.create') {
                const root = join(scratchBase, request.user, request.name);
                void mkdir(root, { recursive: true }).then(() => reply({ t: 'res', id: frame.id, ok: true, value: { root } }));
                return;
              }
              return reply({ t: 'res', id: frame.id, ok: false, code: 'unsupported', error: 'Not here.' });
            }
            if (frame.t === 'open') {
              const runner = spawnRunner({ binaryPath: hostRunnerBinary(runnerDir), roots: [frame.root] });
              runners.set(frame.channel, runner);
              runner.onLine((line) => reply({ t: 'line', channel: frame.channel, line }));
              reply({ t: 'opened', channel: frame.channel });
            } else if (frame.t === 'line') runners.get(frame.channel)?.send(frame.line);
            else if (frame.t === 'close') runners.get(frame.channel)?.kill();
          },
          close: () => {},
        },
        token,
        device,
      );
      reply({ t: 'hello', hello: { protocol: 2, app: '0.2.8', services: ['runner', 'scratch', 'ssh'], lending: { scratch: true, ssh: ['gpu'] }, home: '/Users/ada', sep: '/', os: 'darwin', arch: 'arm64' } });

      expect((await desktop.call('account.devices', {}))[0]).toMatchObject({ current: true, online: true, services: ['runner', 'scratch', 'ssh'], lending: { scratch: true, ssh: ['gpu'] } });
      // The desktop's own ~/.ssh/config, asked of it; a browser has no desktop to ask.
      expect(await desktop.call('workspaces.sshHosts', {})).toEqual(['gpu', 'pi']);
      expect(await browser.call('workspaces.sshHosts', {})).toEqual([]);
      await desktop.call('ssh.save', { name: 'GPU', host: 'gpu', port: null, keyPath: null, folder: null });
      expect(await code(browser.call('ssh.save', { name: 'Pi', host: 'pi', port: null, keyPath: null, folder: null }))).toBe('forbidden');

      // A Code session started on the desktop without a folder gets one made there.
      const session = await desktop.call('sessions.create', { mode: 'code', scratch: {} });
      const folder = (await desktop.call('workspaces.list', {})).find((w) => w.id === session.workspaceId)!;
      expect(folder).toMatchObject({ kind: 'local', deviceId: device.id, scratch: true, available: true });
      expect(folder.root.startsWith(join(scratchBase))).toBe(true);
    } finally {
      for (const runner of runners.values()) runner.kill();
      await server.dispose();
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);
});

/** Stands in for `gh codespace ssh -c <name> -- <command>`: runs the command here, in HOME=FAKE_SSH_HOME, where `/workspaces/` is. */
const FAKE_GH = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const command = args.slice(args.indexOf('--') + 1).join(' ').replace(/(?<![\\w.-])\\/workspaces\\//g, process.env.FAKE_SSH_HOME + '/workspaces/');
const child = spawn('/bin/sh', ['-c', command], { stdio: 'inherit', env: { ...process.env, HOME: process.env.FAKE_SSH_HOME } });
child.on('close', (code) => process.exit(code ?? 1));
`;

describe('a codespace folder', () => {
  it.skipIf(!existsSync(join(runnerDir, 'checksums.json')) || process.platform === 'win32')(
    'runs none of its repository’s hooks and reads none of its instruction files until the person trusts it',
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'atelier-codespace-'));
      const codespaceHome = join(home, 'codespace-home');
      const checkout = join(codespaceHome, 'workspaces', 'site');
      await mkdir(join(checkout, '.atelier'), { recursive: true });
      // What the repository brings itself: a hook that runs a command, and an instruction file.
      await writeFile(join(checkout, '.atelier', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'touch hook-ran' }] }] } }));
      await writeFile(join(checkout, 'AGENTS.md'), 'Project rule from the codespace.');
      const gh = join(home, 'fake-gh.mjs');
      await writeFile(gh, FAKE_GH);
      await chmod(gh, 0o755);
      process.env.FAKE_SSH_HOME = codespaceHome;
      const prompts: string[] = [];
      const reply = sse([{ data: { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] } }, { data: { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } } }], true);
      const codespace = { name: 'site-abc', display_name: 'site', state: 'Available', repository: { full_name: 'acme/site', name: 'site' } };
      const server = await createBackend({
        surface: 'web',
        configDir: home,
        dataDir: home,
        runnerDir,
        cipher: { encrypt: async (s) => s, decrypt: async (s) => s },
        env: { ATELIER_GH: gh },
        logger: { info: () => {}, error: () => {} },
        fetch: async (url, init) => {
          const target = String(url);
          if (target.endsWith('/chat/completions')) {
            const body = JSON.parse(String(init.body)) as { messages: { role: string; content: unknown }[] };
            const system = JSON.stringify(body.messages.filter((m) => m.role === 'system'));
            if (system.includes('Working directory')) prompts.push(system);
            return streamResponse(reply);
          }
          if (target === 'https://api.github.com/user') return jsonResponse({ login: 'ada' });
          if (target.includes('/user/codespaces?')) return jsonResponse({ codespaces: [codespace] });
          if (target.includes('/user/codespaces/site-abc')) return jsonResponse(codespace);
          return jsonResponse({ data: [] });
        },
      });
      try {
        const [clientSide, serverSide] = createMemoryTransportPair();
        server.connect(serverSide, { client: { clientKind: 'web', ip: '127.0.0.1', userAgent: 'test' } });
        const ada = createRpcClient(contract, clientSide);
        await ada.call('auth.setup', { username: 'ada', name: 'Ada', password: 'correct horse', clientKind: 'web' });
        await ada.call('settings.set', { layer: 'global', path: ['providers'], value: [{ id: 'fake', type: 'openai-compatible', name: 'Fake', baseUrl: 'http://fake.test/v1', headers: {}, enabled: true }] });
        await ada.call('github.connectToken', { token: 'ghp_0123456789abcdef' });
        const changed: boolean[][] = [];
        ada.on('workspaces.changed', (list) => changed.push(list.map((w) => w.trusted === true)));

        // Opened the way a client that never asked would: the folder exists, and is not trusted.
        const added = await ada.call('workspaces.addCodespace', { name: 'site-abc' });
        expect(added).toMatchObject({ kind: 'codespace', host: 'site-abc', trusted: false });
        expect(await ada.call('workspaces.list', {})).toEqual([expect.objectContaining({ id: added.id, trusted: false })]);
        const start = async (n: number) => {
          const session = await ada.call('sessions.create', { mode: 'code', workspaceId: added.id, model: 'fake/m' });
          await ada.call('chat.send', { sessionId: session.id, parts: [{ type: 'text', text: 'hi' }] });
          await vi.waitFor(() => expect(prompts).toHaveLength(n), { timeout: 15_000 });
          return prompts[n - 1]!;
        };

        const before = await start(1);
        expect(before).not.toContain('Project rule from the codespace.');
        // The hook is awaited before the first request reaches the model: had it run, its file would be there.
        expect(existsSync(join(added.root, 'hook-ran'))).toBe(false);

        const trusted = await ada.call('workspaces.trust', { id: added.id });
        expect(trusted).toMatchObject({ id: added.id, trusted: true });
        expect(changed.at(-1)).toEqual([true]);
        expect(await code(ada.call('workspaces.trust', { id: 'nope' }))).toBe('not_found');

        const after = await start(2);
        expect(after).toContain('Project rule from the codespace.');
        expect(existsSync(join(added.root, 'hook-ran'))).toBe(true);
      } finally {
        await server.dispose();
        delete process.env.FAKE_SSH_HOME;
        await rm(home, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

describe('loops', () => {
  it(`starts ${LOOP_MAX_PER_SESSION} in a session at most, and ${LOOP_MAX_PER_USER} of one person’s`, async () => {
    const sessions = [];
    for (let i = 0; i <= LOOP_MAX_PER_USER / LOOP_MAX_PER_SESSION; i++) sessions.push(await client.call('sessions.create', { mode: 'work' }));
    const start = (sessionId: string) => client.call('loops.start', { sessionId, prompt: 'ping', intervalMs: 3_600_000 });
    for (const s of sessions.slice(0, -1)) for (let i = 0; i < LOOP_MAX_PER_SESSION; i++) await start(s.id);
    await expect(start(sessions[0]!.id)).rejects.toMatchObject({ message: expect.stringMatching(/^This session already has 5 loops running/), data: { code: 'limit' } });
    await expect(start(sessions.at(-1)!.id)).rejects.toMatchObject({ message: expect.stringMatching(/^You already have 20 loops running/), data: { code: 'limit' } });
    await client.call('loops.stop', { sessionId: sessions[0]!.id, target: '1' });
    expect(await start(sessions.at(-1)!.id)).toMatchObject({ intervalMs: 3_600_000 });
  });
});

describe('"Run on this computer"', () => {
  let localDir: string;
  let local: Backend;

  beforeEach(async () => {
    localDir = await mkdtemp(join(tmpdir(), 'atelier-local-'));
    local = await createBackend({
      surface: 'desktop',
      configDir: localDir,
      dataDir: localDir,
      cipher: { encrypt: async (s) => s, decrypt: async (s) => s },
      env: {},
      logger: { info: () => {}, error: () => {} },
      fetch: async () => Promise.reject(new Error('offline')),
    });
  });

  afterEach(async () => {
    await local.dispose();
    await rm(localDir, { recursive: true, force: true });
  });

  const connectLocal = (token?: string) => {
    const [clientSide, serverSide] = createMemoryTransportPair();
    local.connect(serverSide, { ...(token ? { token } : {}), client: { clientKind: 'desktop', userAgent: 'test' } });
    return createRpcClient(contract, clientSide);
  };

  it('sets up the owner from a name alone and signs them in again without a password', async () => {
    const first = connectLocal();
    expect(await first.call('auth.status', {})).toMatchObject({ local: true, setupRequired: true, user: null });
    const { token, user } = await first.call('auth.setupLocal', { name: 'Ada Lovelace', clientKind: 'desktop' });
    expect(user).toMatchObject({ username: 'ada.lovelace', name: 'Ada Lovelace', role: 'admin' });
    expect(await code(first.call('auth.setupLocal', { name: 'Eve', clientKind: 'desktop' }))).toBe('setup_done');

    expect(await connectLocal(token).call('account.get', {})).toMatchObject({ id: user.id });
    const later = connectLocal();
    expect((await later.call('auth.localSignIn', { clientKind: 'desktop' })).user.id).toBe(user.id);
    expect(await later.call('sessions.list', {})).toEqual([]);
    // Nobody signs in with the password it was given: it was random and never shown.
    expect(await code(connectLocal().call('auth.login', { username: 'ada.lovelace', password: 'ada.lovelace', clientKind: 'desktop' }))).toBe('invalid_credentials');
  });

  it('keeps an install that was set up with a password: the owner is signed in without it', async () => {
    const first = connectLocal();
    const { user } = await first.call('auth.setup', { username: 'ada', name: 'Ada', password: 'correct horse', clientKind: 'desktop' });
    expect((await connectLocal().call('auth.localSignIn', { clientKind: 'desktop' })).user.id).toBe(user.id);
    expect((await connectLocal().call('auth.login', { username: 'ada', password: 'correct horse', clientKind: 'desktop' })).user.id).toBe(user.id);
  });

  it('refuses everything but unlocking while the screen lock is on, in every window', async () => {
    const owner = connectLocal();
    const { token } = await owner.call('auth.setupLocal', { name: 'Ada', clientKind: 'desktop' });
    expect(await owner.call('lock.status', {})).toMatchObject({ enabled: false, locked: false });
    expect(await code(owner.call('lock.setAutoLock', { minutes: 5 }))).toBe('not_set');
    await owner.call('lock.set', { lock: { kind: 'pin', secret: '2468' } });
    await owner.call('lock.setAutoLock', { minutes: 15 });

    const other = connectLocal(token);
    const seen: boolean[] = [];
    other.on('lock.changed', (s) => seen.push(s.locked));
    expect(await owner.call('lock.lock', {})).toMatchObject({ locked: true, autoLockMinutes: 15 });
    for (const c of [owner, other]) {
      expect(await code(c.call('sessions.list', {}))).toBe('locked');
      expect(await code(c.call('lock.clear', { current: '2468' }))).toBe('locked');
    }
    expect(await other.call('auth.status', {})).toMatchObject({ local: true });
    expect(await code(other.call('lock.unlock', { secret: '1111' }))).toBe('wrong_secret');
    expect(await other.call('lock.unlock', { secret: '2468' })).toMatchObject({ locked: false });
    expect(await owner.call('sessions.list', {})).toEqual([]);
    expect(seen).toEqual([true, false]);

    expect(await code(owner.call('lock.clear', { current: '0000' }))).toBe('wrong_secret');
    expect(await owner.call('lock.clear', { current: '2468' })).toMatchObject({ enabled: false });
  });

  it('starts locked after a restart and opens for the OS account’s check', async () => {
    const owner = connectLocal();
    const { token } = await owner.call('auth.setupLocal', { name: 'Ada', clientKind: 'desktop' });
    await owner.call('lock.set', { lock: { kind: 'password', secret: 'open sesame' } });
    await local.dispose();
    local = await createBackend({
      surface: 'desktop',
      configDir: localDir,
      dataDir: localDir,
      cipher: { encrypt: async (s) => s, decrypt: async (s) => s },
      env: {},
      logger: { info: () => {}, error: () => {} },
    });
    const relaunched = connectLocal(token);
    expect(await relaunched.call('lock.status', {})).toMatchObject({ enabled: true, kind: 'password', locked: true });
    expect(await code(relaunched.call('account.get', {}))).toBe('locked');
    await local.removeScreenLock();
    expect(await relaunched.call('account.get', {})).toMatchObject({ name: 'Ada' });
  });

  it('has no local sign-in or screen lock on a server', async () => {
    expect(await code(connect().call('auth.localSignIn', { clientKind: 'web' }))).toBe('unsupported');
    expect(await code(client.call('lock.lock', {}))).toBe('unsupported');
    expect(await client.call('auth.status', {})).toMatchObject({ local: false });
  });
});

describe('side chats', () => {
  it('start beside a session, stay out of its lists, and go when it is deleted', async () => {
    const main = await client.call('sessions.create', { mode: 'code' });
    const side = await client.call('sideChats.start', { sessionId: main.id });
    expect(await client.call('sideChats.list', { sessionId: main.id })).toEqual([expect.objectContaining({ id: side.id })]);
    expect((await client.call('sessions.list', {})).map((s) => s.id)).not.toContain(side.id);
    await expect(client.call('sideChats.start', { sessionId: side.id })).rejects.toMatchObject({ data: { code: 'unsupported' } });
    await client.call('sessions.delete', { id: main.id });
    await expect(client.call('sessions.subscribe', { id: side.id })).rejects.toMatchObject({ data: { code: 'not_found' } });
  });
});

describe('server updates', () => {
  it('are for admins, ask the updater, and have no place on the desktop app’s own backend', async () => {
    const home = await mkdtemp(join(tmpdir(), 'atelier-server-updates-'));
    const asked: string[] = [];
    const serverUpdates = new ServerUpdates({
      version: '0.1.8',
      feed: 'https://feed.test',
      updater: { url: 'http://updater:7341', secretFile: join(home, 'updater-secret') },
      image: 'ghcr.io/theoriuhd/atelier',
      fetch: async (input, init) => {
        const url = String(input);
        asked.push(`${init?.method ?? 'GET'} ${url}`);
        if (url.endsWith('latest.yml')) return new Response('version: 0.1.9\n');
        if (url.endsWith('/status')) return Response.json({ services: { atelier: { image: 'ghcr.io/theoriuhd/atelier:latest', source: false } }, job: { state: 'idle', message: null, startedAt: null, finishedAt: null } });
        return Response.json({}, { status: 202 });
      },
    });
    const server = await createBackend({
      surface: 'web',
      configDir: home,
      dataDir: home,
      cipher: { encrypt: async (s) => s, decrypt: async (s) => s },
      env: {},
      logger: { info: () => {}, error: () => {} },
      serverUpdates,
    });
    const local = await createBackend({
      surface: 'desktop',
      configDir: join(home, 'local'),
      dataDir: join(home, 'local'),
      cipher: { encrypt: async (s) => s, decrypt: async (s) => s },
      env: {},
      logger: { info: () => {}, error: () => {} },
    });
    const open = (b: Backend) => {
      const [clientSide, serverSide] = createMemoryTransportPair();
      b.connect(serverSide, { client: { clientKind: 'web', ip: '127.0.0.1', userAgent: 'test' } });
      return createRpcClient(contract, clientSide);
    };
    try {
      const ada = open(server);
      await ada.call('auth.setup', { username: 'ada', name: 'Ada', password: 'correct horse', clientKind: 'web' });
      expect(await ada.call('server.updates', {})).toMatchObject({ version: '0.1.8', latest: { version: '0.1.9' }, install: 'updater' });
      await ada.call('server.update', {});
      expect(asked).toContain('POST http://updater:7341/update');

      const { code: invite } = await ada.call('invites.create', { role: 'user' });
      const cy = open(server);
      await cy.call('auth.acceptInvite', { invite, username: 'cy', name: 'Cy', password: 'cy-password', clientKind: 'web' });
      expect(await code(cy.call('server.updates', {}))).toBe('forbidden');
      expect(await code(cy.call('server.update', {}))).toBe('forbidden');
      // Everyone may know the server's version: clients compare it with their own.
      expect((await cy.call('app.info', {})).version).toBe(APP.version);

      const me = open(local);
      await me.call('auth.setupLocal', { name: 'Me', clientKind: 'desktop' });
      expect(await me.call('server.updates', {})).toBeNull();
      expect(await code(me.call('server.update', {}))).toBe('not_supported');
    } finally {
      await server.dispose();
      await local.dispose();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('turn a source-built server’s update into a clear refusal', async () => {
    const home = await mkdtemp(join(tmpdir(), 'atelier-server-updates-'));
    const server = await createBackend({
      surface: 'web',
      configDir: home,
      dataDir: home,
      cipher: { encrypt: async (s) => s, decrypt: async (s) => s },
      env: {},
      logger: { info: () => {}, error: () => {} },
      serverUpdates: new ServerUpdates({ version: '0.1.8', feed: null }),
    });
    try {
      const [clientSide, serverSide] = createMemoryTransportPair();
      server.connect(serverSide, { client: { clientKind: 'web', ip: '127.0.0.1', userAgent: 'test' } });
      const ada = createRpcClient(contract, clientSide);
      await ada.call('auth.setup', { username: 'ada', name: 'Ada', password: 'correct horse', clientKind: 'web' });
      expect(await ada.call('server.updates', {})).toMatchObject({ install: 'source', latest: null });
      expect(await code(ada.call('server.update', {}))).toBe('source_build');
    } finally {
      await server.dispose();
      await rm(home, { recursive: true, force: true });
    }
  });
});
