import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoopContract, createRpcClient, peerParticipant, RpcError, type CoopHello, type RunEvent, type SessionSnapshot } from '@atelier/protocol';
import { openDatabase, type Db } from '../store/db.ts';
import { users } from '../store/schema.ts';
import { SessionRepo } from '../sessions/session-repo.ts';
import { CoopHost, keyIdOf, type CoopHostDeps, type HostRoomPort, type PeerChannelPort } from './host.ts';
import { lanes } from './lanes.ts';
import { CoopService } from './service.ts';
import { channelPair, settle } from './test-channels.ts';

let db: Db;
let repo: SessionRepo;
let coop: CoopService;
let host: CoopHost;
let sessionId: string;
let arrive: (peer: PeerChannelPort) => void;
/** The secrets the room accepts handshakes with now. */
let keys: string[] = [];
const emitted: RunEvent[] = [];
const sent: { parts: unknown; by: string }[] = [];
const secrets = new Map<string, string>();
let now = 1_000_000;
let made = 0;

const hello = (name = 'Ben'): CoopHello => ({ name, avatar: null, models: 'host', model: null, version: 'test' });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  db = openDatabase(':memory:');
  repo = new SessionRepo(db);
  await db.insert(users).values({ id: 'u1', username: 'ada', name: 'Ada', role: 'admin', passwordHash: 'x', createdAt: 1, updatedAt: 1 });
  sessionId = (await repo.create({ mode: 'code', userId: 'u1', title: 'Shader' })).id;
  emitted.length = 0;
  sent.length = 0;
  secrets.clear();
  coop = new CoopService({
    db,
    sessionRow: async (id) => (await repo.getRow(id)) ?? null,
    account: async () => ({ name: 'Ada', avatar: null }),
    emit: (_id, event) => emitted.push(event),
    changed: () => undefined,
    watchers: () => new Set(),
    relay: { invite: (s) => host.port.invite(s), knocking: (s) => host.port.knocking(s), peerOnline: (s, p) => host.port.peerOnline(s, p) },
    now: () => now,
  });
  const room: HostRoomPort = { onPeer: (handler) => void (arrive = handler), setSecrets: (list) => void (keys = list), onRelayState: () => undefined, close: async () => undefined };
  const chat = {
    send: async (_s: string, parts: unknown, _p: unknown, by: { id: string }) => (sent.push({ parts, by: by.id }), 'm1'),
    snapshot: async () => ({ session: { id: sessionId }, messages: [], seq: 3 }) as unknown as SessionSnapshot,
    forgetParticipant: async () => undefined,
  };
  const deps = {
    coop,
    transport: { createRoom: async () => ({ roomId: 'R'.repeat(22), hostToken: 'T'.repeat(43) }), openHostRoom: async () => room, deleteRoom: async () => undefined, newSecret: () => String(++made).padStart(43, 'S') },
    relayUrl: () => 'https://relay.test',
    sessionRow: async (id: string) => (await repo.getRow(id)) ?? null,
    hostName: async () => 'Ada',
    secrets: { get: async (id: string) => secrets.get(id), set: async (id: string, v: string) => void secrets.set(id, v), delete: async (id: string) => void secrets.delete(id) },
    chat,
    contextBreakdown: async () => ({ context: null, usage: {} }),
    sessionDiff: async () => ({ diff: '', truncated: false, base: null }),
    artifacts: async () => [],
    taskOutput: async (s: string, t: string, since: number) => ({ output: `${s}:${t}:${since}`, offset: 9, truncated: false, running: false, exitCode: 0 }),
    blob: async () => null,
    upload: async () => ({}),
    sessionHasBlob: async () => false,
    keepAwake: () => undefined,
    stateChanged: () => undefined,
    log: () => undefined,
    now: () => now,
  } as unknown as CoopHostDeps;
  host = new CoopHost(deps);
  await host.open(sessionId);
  await host.invite(sessionId);
});

afterEach(() => {
  vi.useRealTimers();
  db.$client.close();
});

/** A guest's computer connecting with device key `key`: its client of the host's CoopContract. */
function guest(key: string) {
  const pair = channelPair({ guestKey: key });
  arrive(pair.host);
  const client = createRpcClient(CoopContract, lanes(pair.guest).coop);
  const events: { name: string; payload: unknown }[] = [];
  for (const name of ['admitted', 'gone', 'session.event', 'child.event'] as const) client.on(name, (payload) => events.push({ name, payload }));
  let closed = false;
  pair.guest.onClose(() => (closed = true));
  return { client, events, pair, closed: () => closed };
}

const refused = async (p: Promise<unknown>, code: string) => {
  const error = await p.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(RpcError);
  expect((error as RpcError).data).toMatchObject({ code });
};

describe('co-op host across computers', () => {
  it('a guest knocks, is let in after the host sees their fingerprint, and then acts as themselves', async () => {
    const ben = guest('key-ben');
    const welcome = await ben.client.call('coop.hello', hello());
    expect(welcome).toMatchObject({ admitted: false, hostName: 'Ada', title: 'Shader', fingerprint: ['🐙', '🌵', '🎈', '🚀'] });
    expect(host.port.knocking(sessionId)).toEqual([{ id: keyIdOf('key-ben'), name: 'Ben', fingerprint: ['🐙', '🌵', '🎈', '🚀'] }]);
    // Nothing before the host lets them in.
    await refused(ben.client.call('chat.send', { parts: [{ type: 'text', text: 'hi' }] }), 'forbidden');
    await refused(ben.client.call('coop.subscribe', {}), 'forbidden');

    await host.admit(sessionId, keyIdOf('key-ben'), true);
    await settle();
    expect(ben.events.map((e) => e.name)).toContain('admitted');
    const id = peerParticipant(keyIdOf('key-ben'));
    expect(await coop.participant(sessionId, id)).toMatchObject({ kind: 'peer', peerKey: 'key-ben', role: 'editor', name: 'Ben' });
    expect(host.port.knocking(sessionId)).toEqual([]);

    await ben.client.call('chat.send', { parts: [{ type: 'text', text: 'slower waves' }] });
    expect(sent).toEqual([{ parts: [{ type: 'text', text: 'slower waves' }], by: id }]);
  });

  it('forwards run events only to admitted guests who subscribed', async () => {
    const ben = guest('key-ben');
    await ben.client.call('coop.hello', hello());
    host.forward(sessionId, 4, { type: 'typing', participantId: 'x' });
    await host.admit(sessionId, keyIdOf('key-ben'), true);
    await settle();
    host.forward(sessionId, 5, { type: 'typing', participantId: 'x' });
    await ben.client.call('coop.subscribe', {});
    host.forward(sessionId, 6, { type: 'typing', participantId: 'x' });
    await settle();
    expect(ben.events.filter((e) => e.name === 'session.event').map((e) => (e.payload as { seq: number }).seq)).toEqual([6]);
  });

  it('a viewer watches but cannot send', async () => {
    const ben = guest('key-ben');
    await ben.client.call('coop.hello', hello());
    await host.admit(sessionId, keyIdOf('key-ben'), true);
    await settle();
    await coop.setRole(sessionId, peerParticipant(keyIdOf('key-ben')), 'viewer');
    await refused(ben.client.call('chat.send', { parts: [{ type: 'text', text: 'hi' }] }), 'forbidden');
    await expect(ben.client.call('coop.subscribe', {})).resolves.toMatchObject({ seq: 3 });
  });

  it('a declined guest is told and let go', async () => {
    const ben = guest('key-ben');
    await ben.client.call('coop.hello', hello());
    await host.admit(sessionId, keyIdOf('key-ben'), false);
    await settle();
    expect(ben.events).toContainEqual({ name: 'gone', payload: { reason: 'declined', copy: false } });
    vi.advanceTimersByTime(2000);
    expect(ben.closed()).toBe(true);
    expect(await coop.participant(sessionId, peerParticipant(keyIdOf('key-ben')))).toBeNull();
  });

  it('someone let in before comes back without asking; a new device needs a live invite', async () => {
    const first = guest('key-ben');
    await first.client.call('coop.hello', hello());
    await host.admit(sessionId, keyIdOf('key-ben'), true);
    await settle();
    first.pair.drop();
    // The invite lapses; Ben's known device still comes straight back.
    now += 25 * 3600_000;
    const again = guest('key-ben');
    expect(await again.client.call('coop.hello', hello())).toMatchObject({ admitted: true });
    const stranger = guest('key-eve');
    await refused(stranger.client.call('coop.hello', hello('Eve')), 'forbidden');
  });

  it('a removed guest is told, and their device key no longer lets them in', async () => {
    const ben = guest('key-ben');
    await ben.client.call('coop.hello', hello());
    await host.admit(sessionId, keyIdOf('key-ben'), true);
    await settle();
    const id = peerParticipant(keyIdOf('key-ben'));
    await coop.remove(sessionId, id);
    host.removed(sessionId, id);
    await settle();
    expect(ben.events).toContainEqual({ name: 'gone', payload: { reason: 'removed', copy: false } });
    vi.advanceTimersByTime(1000);
    expect(ben.closed()).toBe(true);
    const back = guest('key-ben');
    expect(await back.client.call('coop.hello', hello())).toMatchObject({ admitted: false });
  });

  it('a file outside the session is not handed out', async () => {
    const ben = guest('key-ben');
    await ben.client.call('coop.hello', hello());
    await host.admit(sessionId, keyIdOf('key-ben'), true);
    await settle();
    await refused(ben.client.call('blob.get', { sha256: 'a'.repeat(64) }), 'not_found');
    // Nor attached to a message.
    await refused(ben.client.call('chat.send', { parts: [{ type: 'image', mime: 'image/png', blob: 'a'.repeat(64) }] }), 'forbidden');
  });

  it('ending co-op tells guests whether they may keep a copy, lets them fetch it, and nothing more', async () => {
    const ben = guest('key-ben');
    await ben.client.call('coop.hello', hello());
    await host.admit(sessionId, keyIdOf('key-ben'), true);
    await settle();
    await host.close(sessionId);
    await coop.end(sessionId);
    await settle();
    expect(ben.events).toContainEqual({ name: 'gone', payload: { reason: 'ended', copy: true } });
    await expect(ben.client.call('coop.subscribe', {})).resolves.toMatchObject({ seq: 3 });
    await refused(ben.client.call('chat.send', { parts: [{ type: 'text', text: 'one more' }] }), 'forbidden');
    vi.advanceTimersByTime(5000);
    expect(ben.closed()).toBe(true);
  });

  it('a guest let in gets their own secret; a new link withdraws the old one, and removal withdraws theirs', async () => {
    const invite = keys[0]!;
    expect(keys).toEqual([invite]);
    const ben = guest('key-ben');
    await ben.client.call('coop.hello', hello());
    await host.admit(sessionId, keyIdOf('key-ben'), true);
    await settle();
    const admitted = ben.events.find((e) => e.name === 'admitted')!.payload as { memberSecret: string };
    expect(admitted.memberSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(keys).toEqual([invite, admitted.memberSecret]);
    // Coming back on a known device, they're told it again.
    ben.pair.drop();
    const back = guest('key-ben');
    expect(await back.client.call('coop.hello', hello())).toMatchObject({ admitted: true, memberSecret: admitted.memberSecret });

    // A new link: the old one's key is gone, Ben's stays.
    const { url } = await host.invite(sessionId);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(invite);
    expect(url).toContain(keys[0]!);
    expect(keys[1]).toBe(admitted.memberSecret);

    // Removed: Ben's key goes too.
    const id = peerParticipant(keyIdOf('key-ben'));
    await coop.remove(sessionId, id);
    host.removed(sessionId, id);
    expect(keys).toEqual([keys[0]]);
    expect(secrets.has(`coop-member-${sessionId}-${id.replace(':', '_')}`)).toBe(false);
  });

  it('when the invite lapses, only members’ keys are left', async () => {
    const ben = guest('key-ben');
    await ben.client.call('coop.hello', hello());
    await host.admit(sessionId, keyIdOf('key-ben'), true);
    await settle();
    expect(keys).toHaveLength(2);
    now += 24 * 3600_000 + 2000;
    vi.advanceTimersByTime(24 * 3600_000 + 2000);
    expect(keys).toHaveLength(1);
  });

  it('room for four people at most', async () => {
    for (const key of ['k1', 'k2', 'k3']) {
      const g = guest(key);
      await g.client.call('coop.hello', hello(key));
      await host.admit(sessionId, keyIdOf(key), true);
      await settle();
    }
    const fifth = guest('k4');
    await fifth.client.call('coop.hello', hello('k4'));
    await expect(host.admit(sessionId, keyIdOf('k4'), true)).rejects.toThrow('room for four');
    await settle();
    expect(fifth.events.map((e) => e.name)).not.toContain('admitted');
    expect((await coop.list(sessionId)).length).toBe(4);
  });

  it('a guest’s connection that closes after the host shut down changes nothing (the database may be gone)', async () => {
    const ben = guest('key-ben');
    await ben.client.call('coop.hello', hello());
    await host.admit(sessionId, keyIdOf('key-ben'), true);
    await settle();
    const presence = vi.spyOn(coop, 'presence');
    await host.shutdown();
    ben.pair.drop();
    await settle();
    expect(presence).not.toHaveBeenCalled();
  });

  it('a guest follows a sub-agent’s or track’s session of the shared one, never a side chat or another session', async () => {
    const ben = guest('key-ben');
    await ben.client.call('coop.hello', hello());
    await host.admit(sessionId, keyIdOf('key-ben'), true);
    await settle();
    const agent = (await repo.create({ mode: 'code', userId: 'u1', parentSessionId: sessionId })).id;
    const nested = (await repo.create({ mode: 'code', userId: 'u1', parentSessionId: agent })).id;
    const side = (await repo.create({ mode: 'code', userId: 'u1', parentSessionId: sessionId, overrides: { sideChat: true } })).id;
    const underSide = (await repo.create({ mode: 'code', userId: 'u1', parentSessionId: side })).id;
    const other = (await repo.create({ mode: 'code', userId: 'u1' })).id;

    await expect(ben.client.call('coop.subscribeChild', { sessionId: agent })).resolves.toBeTruthy();
    await expect(ben.client.call('coop.subscribeChild', { sessionId: nested })).resolves.toBeTruthy();
    for (const refusedId of [side, underSide, other, sessionId, 'nope']) await refused(ben.client.call('coop.subscribeChild', { sessionId: refusedId }), 'not_found');

    host.forward(agent, 4, { type: 'status', status: 'running' } as RunEvent);
    host.forward(other, 5, { type: 'status', status: 'running' } as RunEvent);
    await settle();
    expect(ben.events.filter((e) => e.name === 'child.event')).toEqual([{ name: 'child.event', payload: { sessionId: agent, seq: 4, event: { type: 'status', status: 'running' } } }]);
    await ben.client.call('coop.unsubscribeChild', { sessionId: agent });
    host.forward(agent, 6, { type: 'status', status: 'idle' } as RunEvent);
    await settle();
    expect(ben.events.filter((e) => e.name === 'child.event')).toHaveLength(1);
  });

  it('a guest reads a background command’s output in the shared session, once let in', async () => {
    const ben = guest('key-ben');
    await ben.client.call('coop.hello', hello());
    await expect(ben.client.call('tasks.output', { taskId: 't1', since: 0 })).rejects.toBeInstanceOf(RpcError);
    await host.admit(sessionId, keyIdOf('key-ben'), true);
    await settle();
    expect(await ben.client.call('tasks.output', { taskId: 't1', since: 4 })).toMatchObject({ output: `${sessionId}:t1:4`, offset: 9 });
  });

  it('someone who knocked but wasn’t let in can’t follow a sub-agent', async () => {
    const eve = guest('key-eve');
    await eve.client.call('coop.hello', hello('Eve'));
    const agent = (await repo.create({ mode: 'code', userId: 'u1', parentSessionId: sessionId })).id;
    await expect(eve.client.call('coop.subscribeChild', { sessionId: agent })).rejects.toBeInstanceOf(RpcError);
  });
});
