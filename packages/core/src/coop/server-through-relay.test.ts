/**
 * Co-op between a server and another computer, end to end on this machine: a relay on Node, two whole backends (an
 * Atelier server with several accounts, and a desktop), their real hosts, gateways and encrypted channels, driven through
 * the app contract as their windows do. Models are a fake OpenAI-compatible provider on each side, so it shows whose
 * model answered.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contract, CoopContract, createMemoryTransportPair, createRpcClient, parseInviteFragment, RpcError, type AppContract, type RpcClient, type SessionSnapshot } from '@atelier/protocol';
import { createBackend, type Backend } from '../backend/backend.ts';
import { jsonResponse, sse, streamResponse } from '../providers/__fixtures__/harness.ts';
import { generateStaticKey, joinRoom } from './channel.ts';
import { pskFromSecret } from './invite.ts';
import { lanes } from './lanes.ts';
import { startCoopRelay, type StandaloneCoopRelay } from './relay-node.ts';

const HTTP_FIXTURE = fileURLToPath(new URL('../mcp/__fixtures__/http-server.ts', import.meta.url));
const mocks: ChildProcess[] = [];

/** Core's mock MCP server over HTTP, open to anyone; its URL. */
async function mcpMock(): Promise<string> {
  const mock = spawn(process.execPath, [HTTP_FIXTURE], { env: { ...process.env, MOCK_OPEN: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
  mocks.push(mock);
  return new Promise<string>((resolve, reject) => {
    createInterface({ input: mock.stdout! }).once('line', resolve);
    mock.once('exit', (exitCode) => reject(new Error(`the mock MCP server exited (${exitCode})`)));
  });
}

/** A request a backend's fake provider got: the model id, the tools offered, the last message. */
interface Seen {
  model: string;
  tools: string[];
  last: string;
}

let relay: StandaloneCoopRelay;
const dirs: string[] = [];
const backends: Backend[] = [];

beforeEach(async () => {
  relay = await startCoopRelay({ port: 0 });
});

afterEach(async () => {
  for (const b of backends.splice(0)) await b.dispose().catch(() => undefined);
  for (const m of mocks.splice(0)) m.kill();
  await relay.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const until = async (check: () => unknown | Promise<unknown>, ms = 20_000): Promise<void> => {
  const end = Date.now() + ms;
  for (;;) {
    if (await Promise.resolve(check()).catch(() => false)) return;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof RpcError ? String((e.data as { code?: string } | undefined)?.code) : String(e)));

/** A backend with a fake provider answering "answer from <name>", recording what it was sent. */
async function start(surface: 'web' | 'desktop', name: string, seen: Seen[]): Promise<Backend> {
  const dir = await mkdtemp(join(tmpdir(), `atelier-coop-${surface}-`));
  dirs.push(dir);
  const backend = await createBackend({
    surface,
    configDir: dir,
    dataDir: dir,
    cipher: { encrypt: async (s) => s, decrypt: async (s) => s },
    env: { ATELIER_COOP_RELAY: relay.url },
    logger: { info: () => {}, error: () => {} },
    fetch: async (url, init) => {
      // Only the fake provider is faked: a connector's own address is reached for real.
      if (!String(url).startsWith('http://fake.test/')) return fetch(url, init);
      if (!String(url).endsWith('/chat/completions')) return jsonResponse({ data: [] });
      const body = JSON.parse(String(init.body)) as { model: string; tools?: { function?: { name: string } }[]; messages: unknown[] };
      seen.push({ model: body.model, tools: (body.tools ?? []).map((t) => t.function?.name ?? ''), last: JSON.stringify(body.messages.at(-1)) });
      return streamResponse(sse([{ data: { choices: [{ index: 0, delta: { content: `answer from ${name}` }, finish_reason: 'stop' }] } }, { data: { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } } }], true));
    },
  });
  backends.push(backend);
  return backend;
}

function window(backend: Backend, kind: 'web' | 'desktop'): RpcClient<AppContract> {
  const [clientSide, serverSide] = createMemoryTransportPair();
  backend.connect(serverSide, { client: { clientKind: kind, ip: '127.0.0.1', userAgent: 'test' } });
  return createRpcClient(contract, clientSide);
}

const PROVIDERS = [{ id: 'fake', type: 'openai-compatible', name: 'Fake', baseUrl: 'http://fake.test/v1', headers: {}, enabled: true }];

/** A server with its admin, Ada, and a second account. */
async function server(seen: Seen[]) {
  const backend = await start('web', 'the server', seen);
  const ada = window(backend, 'web');
  await ada.call('auth.setup', { username: 'ada', name: 'Ada', password: 'correct horse', clientKind: 'web' });
  await ada.call('settings.set', { layer: 'global', path: ['providers'], value: PROVIDERS });
  const account = async (username: string, name: string) => {
    const { temporaryPassword } = await ada.call('users.create', { username, name, role: 'user' });
    const c = window(backend, 'web');
    await c.call('auth.login', { username, password: temporaryPassword, clientKind: 'web' });
    await c.call('account.changePassword', { current: temporaryPassword, next: `${username}-new-password` });
    return c;
  };
  return { backend, ada, account };
}

/** A desktop and its one person, Ben. */
async function desktop(seen: Seen[]) {
  const backend = await start('desktop', 'the desktop', seen);
  const ben = window(backend, 'desktop');
  await ben.call('auth.setup', { username: 'ben', name: 'Ben', password: 'correct horse', clientKind: 'desktop' });
  await ben.call('settings.set', { layer: 'global', path: ['providers'], value: PROVIDERS });
  return { backend, ben };
}

/** A turn's request (not a title's: those offer no tools) whose last message says `text`. */
const turn = (seen: Seen[], text: string) => seen.find((r) => r.tools.length > 0 && r.last.includes(text));

const texts = (snapshot: SessionSnapshot) => snapshot.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])));

describe('people on a server join a session on someone’s computer', () => {
  it('knock with their own account’s key, are let in one by one, write as themselves, answer with their own models, and keep a copy', { timeout: 90_000 }, async () => {
    const serverSeen: Seen[] = [];
    const desktopSeen: Seen[] = [];
    const { ben } = await desktop(desktopSeen);
    const { backend: srv, ada, account } = await server(serverSeen);
    const cy = await account('cy', 'Cy');

    // Ben's chat, with one exchange, shared through the relay.
    const session = await ben.call('sessions.create', { mode: 'chat', model: 'fake/m' });
    await ben.call('sessions.update', { id: session.id, title: 'Shader' });
    await ben.call('chat.send', { sessionId: session.id, parts: [{ type: 'text', text: 'the shader plan' }] });
    await until(async () => texts(await ben.call('sessions.subscribe', { id: session.id })).includes('answer from the desktop'));
    await ben.call('coop.start', { sessionId: session.id });
    const { url } = await ben.call('coop.invite', { sessionId: session.id });

    // Ada, signed in to the server, joins from the link: she knocks, and both sides see the same four emoji.
    const joined = await ada.call('coop.join', { invite: url, models: 'host' });
    expect(joined.waiting).toBe(true);
    await until(async () => ((await ben.call('coop.state', { sessionId: session.id }))?.knocking.length ?? 0) === 1);
    const [knock] = (await ben.call('coop.state', { sessionId: session.id }))!.knocking;
    expect(knock).toMatchObject({ name: 'Ada', fingerprint: joined.fingerprint });
    await ben.call('coop.admit', { sessionId: session.id, knockId: knock!.id, allow: true });
    await until(async () => (await ada.call('coop.state', { sessionId: joined.sessionId })) !== null);

    // The mirror is in her sidebar on the server, and the conversation so far in it.
    expect((await ada.call('sessions.list', {})).find((s) => s.id === joined.sessionId)).toMatchObject({ title: 'Shader', coop: { mirror: true, hostName: 'Ben' } });
    expect(texts(await ada.call('sessions.subscribe', { id: joined.sessionId }))).toContain('the shader plan');
    // Nobody else on her server sees it, nor reaches it.
    expect((await cy.call('sessions.list', {})).some((s) => s.id === joined.sessionId)).toBe(false);
    expect(await code(cy.call('sessions.subscribe', { id: joined.sessionId }))).toBe('not_found');

    // Cy joins with the same link: a knock of his own, not let in as Ada; a mirror of his own.
    const cyJoined = await cy.call('coop.join', { invite: url, models: 'host' });
    expect(cyJoined.waiting).toBe(true);
    expect(cyJoined.sessionId).not.toBe(joined.sessionId);
    await until(async () => ((await ben.call('coop.state', { sessionId: session.id }))?.knocking.length ?? 0) === 1);
    const [cyKnock] = (await ben.call('coop.state', { sessionId: session.id }))!.knocking;
    expect(cyKnock).toMatchObject({ name: 'Cy' });
    expect(cyKnock!.id).not.toBe(knock!.id);
    await ben.call('coop.admit', { sessionId: session.id, knockId: cyKnock!.id, allow: true });
    await until(async () => (await ben.call('coop.state', { sessionId: session.id }))?.participants.length === 3);
    const people = (await ben.call('coop.state', { sessionId: session.id }))!.participants;
    expect(people.map((p) => [p.name, p.kind])).toEqual([['Ben', 'account'], ['Ada', 'peer'], ['Cy', 'peer']]);
    expect(new Set(people.map((p) => p.id)).size).toBe(3);

    // Ada writes: it is her message in Ben's session, answered on Ben's model (he shares his).
    await ada.call('chat.queue', { sessionId: joined.sessionId, parts: [{ type: 'text', text: 'calmer waves' }] });
    await until(async () => texts(await ben.call('sessions.subscribe', { id: session.id })).filter((t) => t === 'answer from the desktop').length === 2);
    const hostView = await ben.call('sessions.subscribe', { id: session.id });
    expect(hostView.messages.find((m) => texts({ messages: [m] } as SessionSnapshot).includes('calmer waves'))?.author).toBe(people[1]!.id);

    // Now with her own model, on her server account: the server's provider answers, sent the bare model id.
    await ada.call('coop.models', { sessionId: joined.sessionId, models: 'own', model: 'fake/m' });
    const before = serverSeen.length;
    await ada.call('chat.queue', { sessionId: joined.sessionId, parts: [{ type: 'text', text: 'my own model please' }] });
    await until(async () => texts(await ben.call('sessions.subscribe', { id: session.id })).includes('answer from the server'));
    const asked = turn(serverSeen.slice(before), 'my own model please');
    expect(asked?.model).toBe('m');
    expect(desktopSeen.some((r) => r.last.includes('my own model please'))).toBe(false);

    // She leaves: the host lets guests keep a copy, which becomes a chat of her own on the server.
    await ada.call('coop.leave', { sessionId: joined.sessionId });
    await until(async () => (await ada.call('sessions.list', {})).some((s) => s.title === 'Shader (co-op)'));
    const copy = (await ada.call('sessions.list', {})).find((s) => s.title === 'Shader (co-op)')!;
    expect(texts(await ada.call('sessions.subscribe', { id: copy.id }))).toEqual(expect.arrayContaining(['the shader plan', 'calmer waves', 'answer from the server']));
    await until(async () => (await ben.call('coop.state', { sessionId: session.id }))?.participants.length === 2);

    // The server starting again joins Cy back by himself, with his own key.
    await srv.dispose();
    backends.splice(backends.indexOf(srv), 1);
    await until(async () => !(await ben.call('coop.state', { sessionId: session.id }))?.participants.find((p) => p.name === 'Cy')?.online);
  });
});

describe('a session on a server, shared with someone on another computer', () => {
  it('the host makes an invite link, lets the guest in, and their message runs in the session', { timeout: 90_000 }, async () => {
    const serverSeen: Seen[] = [];
    const { ada } = await server(serverSeen);
    const { ben } = await desktop([]);
    const session = await ada.call('sessions.create', { mode: 'chat', model: 'fake/m' });
    await ada.call('sessions.update', { id: session.id, title: 'Water' });
    await ada.call('coop.start', { sessionId: session.id });
    // Co-op on a server starts on the server; the link opens its room on the relay.
    expect(await ada.call('coop.state', { sessionId: session.id })).toMatchObject({ via: 'server', invites: true, hostedOn: 'server' });
    const { url } = await ada.call('coop.invite', { sessionId: session.id });
    expect(parseInviteFragment(url)?.meta).toMatchObject({ hostName: 'Ada', title: 'Water', on: 'server' });

    const joined = await ben.call('coop.join', { invite: url, models: 'host' });
    await until(async () => ((await ada.call('coop.state', { sessionId: session.id }))?.knocking.length ?? 0) === 1);
    // The host's sidebar knows someone knocks (her notifications go by it).
    expect((await ada.call('sessions.list', {})).find((s) => s.id === session.id)?.coop?.knocking).toEqual([{ id: expect.any(String), name: 'Ben' }]);
    const [knock] = (await ada.call('coop.state', { sessionId: session.id }))!.knocking;
    await ada.call('coop.admit', { sessionId: session.id, knockId: knock!.id, allow: true });
    await until(async () => (await ben.call('coop.state', { sessionId: joined.sessionId })) !== null);
    // Ben takes part through the relay, in a session that runs on a server.
    expect(await ben.call('coop.state', { sessionId: joined.sessionId })).toMatchObject({ via: 'relay', hostedOn: 'server', role: 'editor' });

    await ben.call('chat.queue', { sessionId: joined.sessionId, parts: [{ type: 'text', text: 'hello from Ben' }] });
    await until(async () => texts(await ada.call('sessions.subscribe', { id: session.id })).includes('answer from the server'));
    await until(async () => texts(await ben.call('sessions.subscribe', { id: joined.sessionId })).includes('answer from the server'));

    // Ada ends co-op: Ben keeps a copy on his computer.
    await ada.call('coop.end', { sessionId: session.id });
    await until(async () => (await ben.call('sessions.list', {})).some((s) => s.title === 'Water (co-op)'), 30_000);
  });

  it('a guest from another computer reaches nothing of the server beyond the session: no other session, blob, account or shared connector', { timeout: 90_000 }, async () => {
    const serverSeen: Seen[] = [];
    const { backend: srv, ada, account } = await server(serverSeen);
    const bob = await account('bob', 'Bob');
    // A connector the admin shares with the server's accounts.
    await ada.call('settings.set', { layer: 'global', path: ['mcpServers', 'mock'], value: { type: 'http', url: await mcpMock() } });
    await until(async () => (await ada.call('mcp.status', {})).some((s) => s.name === 'mock' && s.state === 'ready'), 30_000);

    // Bob's own session with a file; another of Ada's, private.
    const bobs = await bob.call('sessions.create', { mode: 'chat', model: 'fake/m' });
    const bobFile = await bob.call('files.upload', { name: 'secret.txt', mime: 'text/plain', dataBase64: Buffer.from('bob’s secret').toString('base64'), sessionId: bobs.id });
    await bob.call('chat.send', { sessionId: bobs.id, parts: [{ type: 'text', text: 'bob private' }] });
    const private_ = await ada.call('sessions.create', { mode: 'chat', model: 'fake/m' });
    const adaFile = await ada.call('files.upload', { name: 'notes.txt', mime: 'text/plain', dataBase64: Buffer.from('ada’s notes').toString('base64'), sessionId: private_.id });
    await ada.call('chat.send', { sessionId: private_.id, parts: [{ type: 'text', text: 'ada private' }] });
    await until(async () => (await ada.call('sessions.subscribe', { id: private_.id })).messages.length >= 2 && (await bob.call('sessions.subscribe', { id: bobs.id })).messages.length >= 2);
    const privateMessage = (await ada.call('sessions.subscribe', { id: private_.id })).messages[0]!.id;
    const bobMessage = (await bob.call('sessions.subscribe', { id: bobs.id })).messages[0]!.id;

    // The shared one: Ada's own turn has the server's shared connector.
    const shared = await ada.call('sessions.create', { mode: 'chat', model: 'fake/m' });
    await ada.call('chat.send', { sessionId: shared.id, parts: [{ type: 'text', text: 'host turn' }] });
    await until(() => turn(serverSeen, 'host turn'));
    expect(turn(serverSeen, 'host turn')!.tools.some((t) => t.startsWith('mcp__mock'))).toBe(true);
    await ada.call('coop.start', { sessionId: shared.id });
    const { url } = await ada.call('coop.invite', { sessionId: shared.id });

    // Someone on another computer with the link, speaking the co-op contract directly: not only what an app would send.
    const invite = parseInviteFragment(url)!;
    const channel = await joinRoom({ relayUrl: relay.url, roomId: invite.roomId, psk: pskFromSecret(invite.secret), staticKey: generateStaticKey(), hello: { name: 'Mal', version: 'test' } });
    const mal = createRpcClient(CoopContract, lanes(channel).coop);
    expect(await mal.call('coop.hello', { name: 'Mal', avatar: null, models: 'host', model: null, version: 'test' })).toMatchObject({ admitted: false });
    // Nothing before the host lets them in.
    expect(await code(mal.call('coop.subscribe', {}))).toBe('forbidden');
    await until(async () => ((await ada.call('coop.state', { sessionId: shared.id }))?.knocking.length ?? 0) === 1);
    await ada.call('coop.admit', { sessionId: shared.id, knockId: (await ada.call('coop.state', { sessionId: shared.id }))!.knocking[0]!.id, allow: true });
    await until(async () => (await mal.call('coop.state', {}).catch(() => null)) !== null);

    // Other people's and the host's other files, sessions and messages: refused, and nothing of them shows.
    for (const sha of [bobFile.blob, adaFile.blob]) expect(await code(mal.call('blob.get', { sha256: sha }))).toBe('not_found');
    for (const id of [bobs.id, private_.id]) expect(await code(mal.call('coop.subscribeChild', { sessionId: id }))).toBe('not_found');
    for (const messageId of [privateMessage, bobMessage]) {
      expect(await code(mal.call('chat.retry', { messageId }))).not.toBe('ok');
      expect(await code(mal.call('chat.edit', { messageId, parts: [{ type: 'text', text: 'x' }] }))).not.toBe('ok');
      expect(await code(mal.call('chat.react', { messageId, emoji: '👍', on: true }))).not.toBe('ok');
      expect(await code(mal.call('chat.send', { parentId: messageId, parts: [{ type: 'text', text: 'branch off it' }] }))).not.toBe('ok');
    }
    expect(await code(mal.call('chat.send', { parts: [{ type: 'document', blob: bobFile.blob, name: 'secret.txt', mime: 'text/plain' } as never] }))).toBe('forbidden');
    expect(await code(mal.call('tasks.output', { taskId: 'nothing', since: 0 }))).toBe('not_found');
    const seenByMal = JSON.stringify(await mal.call('coop.subscribe', {}));
    for (const leak of ['ada private', 'bob private', privateMessage, bobMessage]) expect(seenByMal).not.toContain(leak);
    // The server's blob routes don't hand Bob's file to the session's people either.
    expect(await srv.blobSource((await ada.call('account.get', {})).id, bobFile.blob)).toBeUndefined();

    // Mal's own turn: answered on the host's model, without the server's shared connector (that is for its accounts).
    await mal.call('chat.send', { parts: [{ type: 'text', text: 'guest turn' }] });
    // Mal's computer serves nothing back (it lends no connectors, has no models): the turn doesn't wait on it for ever.
    await until(() => turn(serverSeen, 'guest turn'), 30_000);
    expect(turn(serverSeen, 'guest turn')!.tools.some((t) => t.startsWith('mcp__'))).toBe(false);
    channel.close();
  });
});
