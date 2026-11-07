/**
 * Co-op between two computers end to end, on this machine: a relay on Node, the host's backend side (host.ts) and the
 * guest's (gateway.ts), talking through the real encrypted channel.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { peerParticipant, type ModelInfo, type SessionSnapshot } from '@atelier/protocol';
import { openDatabase, type Db } from '../store/db.ts';
import { users } from '../store/schema.ts';
import { SessionRepo } from '../sessions/session-repo.ts';
import { encodeKey, generateStaticKey } from './channel.ts';
import { CoopGateway, type CoopGatewayDeps } from './gateway.ts';
import { CoopHost, keyIdOf, type CoopHostDeps } from './host.ts';
import { startCoopRelay, type StandaloneCoopRelay } from './relay-node.ts';
import { CoopService } from './service.ts';
import { relayTransport } from './transport.ts';

let relay: StandaloneCoopRelay;
let hostDb: Db;
let guestDb: Db;
let host: CoopHost;
let gateway: CoopGateway;
let coop: CoopService;
let sessionId: string;
const sent: { text: string; by: string }[] = [];
const guestKey = generateStaticKey();
const guestSecrets = new Map<string, string>();
let guestDeps: CoopGatewayDeps;

const until = async (check: () => boolean | Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

beforeEach(async () => {
  relay = await startCoopRelay({ port: 0 });
  sent.length = 0;
  hostDb = openDatabase(':memory:');
  guestDb = openDatabase(':memory:');
  await hostDb.insert(users).values({ id: 'u1', username: 'ada', name: 'Ada', role: 'admin', passwordHash: 'x', createdAt: 1, updatedAt: 1 });
  await guestDb.insert(users).values({ id: 'u2', username: 'ben', name: 'Ben', role: 'admin', passwordHash: 'x', createdAt: 1, updatedAt: 1 });
  const repo = new SessionRepo(hostDb);
  sessionId = (await repo.create({ mode: 'code', userId: 'u1', title: 'Shader' })).id;
  coop = new CoopService({
    db: hostDb,
    sessionRow: async (id) => (await repo.getRow(id)) ?? null,
    account: async () => ({ name: 'Ada', avatar: null }),
    emit: () => undefined,
    changed: () => undefined,
    watchers: () => new Set(),
    relay: { invite: (s) => host.port.invite(s), knocking: (s) => host.port.knocking(s), peerOnline: (s, p) => host.port.peerOnline(s, p) },
  });
  const hostKey = generateStaticKey();
  const hostSecrets = new Map<string, string>();
  host = new CoopHost({
    coop,
    transport: relayTransport(async () => hostKey),
    relayUrl: () => relay.url,
    sessionRow: async (id: string) => (await repo.getRow(id)) ?? null,
    hostName: async () => 'Ada',
    secrets: { get: async (id: string) => hostSecrets.get(id), set: async (id: string, v: string) => void hostSecrets.set(id, v), delete: async (id: string) => void hostSecrets.delete(id) },
    chat: {
      send: async (_s: string, parts: { type: string; text?: string }[], _p: unknown, by: { id: string }) => (sent.push({ text: parts[0]?.text ?? '', by: by.id }), 'm1'),
      snapshot: async () => ({ session: { id: sessionId, title: 'Shader', mode: 'code', model: null, effort: null, status: 'idle' }, messages: [], siblings: {}, seq: 1 }) as unknown as SessionSnapshot,
      forgetParticipant: async () => undefined,
    },
    contextBreakdown: async () => ({ context: null, usage: {} }),
    sessionDiff: async () => ({ diff: '', truncated: false, base: null }),
    artifacts: async () => [],
    blob: async () => null,
    upload: async () => ({}),
    sessionHasBlob: async () => false,
    keepAwake: () => undefined,
    stateChanged: () => undefined,
    log: () => undefined,
  } as unknown as CoopHostDeps);
  guestSecrets.clear();
  gateway = new CoopGateway((guestDeps = {
    db: guestDb,
    relayUrl: () => relay.url,
    transport: relayTransport(async () => guestKey),
    secrets: { get: async (id: string) => guestSecrets.get(id), set: async (id: string, v: string) => void guestSecrets.set(id, v), delete: async (id: string) => void guestSecrets.delete(id) },
    profile: async () => ({ name: 'Ben', avatar: null }),
    version: 'test',
    emitToUser: (() => undefined) as never,
    emitSession: () => undefined,
    models: { resolve: async () => ({ adapter: {} as never, info: {} as ModelInfo }), firstAvailable: async () => undefined },
    limit: async () => null,
    recordUsage: () => undefined,
    connectorTools: async () => [],
    hasBlob: async () => true,
    putBlob: async () => '',
    saveCopy: async () => null,
    log: () => undefined,
  }));
});

afterEach(async () => {
  gateway.shutdown();
  await host.shutdown();
  await relay.close();
  hostDb.$client.close();
  guestDb.$client.close();
});

describe('co-op through the relay', () => {
  it('invite, knock with matching emoji, admit, and a guest’s message reaches the host’s session as theirs', async () => {
    await host.open(sessionId);
    const { url } = await host.invite(sessionId);
    expect(url).toMatch(/^https:\/\/atelierhq\.dev\/join#v1\./);

    const joined = await gateway.join('u2', url, 'host');
    expect(joined.waiting).toBe(true);
    await until(() => host.port.knocking(sessionId).length === 1);
    const [knock] = host.port.knocking(sessionId);
    expect(knock).toMatchObject({ name: 'Ben' });
    expect(knock!.fingerprint).toHaveLength(4);

    await host.admit(sessionId, knock!.id, true);
    const id = peerParticipant(keyIdOf(encodeKey(guestKey.publicKey)));
    await until(async () => (await coop.participant(sessionId, id)) !== null);
    await until(async () => (await gateway.call('u2', 'coop.state', { sessionId: joined.sessionId }).catch(() => null)) !== null);

    const snapshot = (await gateway.call('u2', 'sessions.subscribe', { id: joined.sessionId })) as SessionSnapshot;
    expect(snapshot.session).toMatchObject({ id: joined.sessionId, title: 'Shader', coop: { mirror: true } });
    await gateway.call('u2', 'chat.send', { sessionId: joined.sessionId, parts: [{ type: 'text', text: 'slower waves' }] });
    expect(sent).toEqual([{ text: 'slower waves', by: id }]);

    // The host makes a new link: the old one no longer gets anyone in. Ben's computer restarts and comes back with his
    // own secret, without asking.
    await host.invite(sessionId);
    gateway.shutdown();
    gateway = new CoopGateway(guestDeps);
    await gateway.resume();
    await until(async () => (await gateway.call('u2', 'coop.state', { sessionId: joined.sessionId }).catch(() => null)) !== null, 15_000);
    await gateway.call('u2', 'chat.send', { sessionId: joined.sessionId, parts: [{ type: 'text', text: 'back again' }] });
    expect(sent.at(-1)).toEqual({ text: 'back again', by: id });
    expect(host.port.knocking(sessionId)).toEqual([]);

    // Someone with the old link can't even begin.
    const stranger = new CoopGateway({ ...guestDeps, db: guestDb, transport: relayTransport(async () => generateStaticKey()) });
    await expect(stranger.join('u2', url.replace(/#v1\.[^.]+\./, (m) => m), 'host').then(() => 'joined', (e: unknown) => String(e))).resolves.not.toBe('joined');
  }, 40_000);
});
