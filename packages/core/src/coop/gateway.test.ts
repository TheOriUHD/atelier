import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CoopContract,
  createRpcClient,
  lentToolName,
  makeInviteUrl,
  PeerContract,
  RpcError,
  serveRpc,
  type Handlers,
  type ModelInfo,
  type RpcServerConnection,
  type SessionSnapshot,
} from '@atelier/protocol';
import { openDatabase, type Db } from '../store/db.ts';
import { coopMemberships, users } from '../store/schema.ts';
import type { ModelResolver } from '../agent/chat-service.ts';
import type { ChatRequest, ProviderAdapter, StreamEvent } from '../providers/types.ts';
import { CoopGateway, mirrorId, type CoopGatewayDeps } from './gateway.ts';
import { lanes } from './lanes.ts';
import { peerAdapter, PEER_SELF, peerProviderType, withPeerModels } from './peer-model.ts';
import { channelPair, settle, type ChannelPair } from './test-channels.ts';

const ROOM = 'R'.repeat(22);
const INVITE = makeInviteUrl(ROOM, 'S'.repeat(43), { hostName: 'Ada', title: 'Shader', mode: 'code' });
const PARTICIPANT = 'peer:abcdefgh12345678';

let db: Db;
let deps: CoopGatewayDeps;
let gateway: CoopGateway;
let pair: ChannelPair;
let hostServer: RpcServerConnection<typeof CoopContract>;
let peer: ReturnType<typeof createRpcClient<typeof PeerContract>>;
const toUser: { event: string; payload: unknown }[] = [];
const toWindows: { sessionId: string; event: unknown }[] = [];
const calls: { method: string; input: unknown }[] = [];
const lentCalls: unknown[] = [];
const streamed: ChatRequest[] = [];

const modelInfo = (ref: string) => ({ ref, providerId: 'p', modelId: 'm', displayName: 'Mine', contextLength: 100_000, maxOutput: 8000, capabilities: {}, tier: 'full', source: 'catalog', hidden: false, favorite: false, order: 0 }) as unknown as ModelInfo;
const adapter: ProviderAdapter = {
  type: 'anthropic',
  listModels: async () => [],
  health: async () => ({ ok: true, latencyMs: null, warnings: [] }),
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    streamed.push(request);
    yield { type: 'text', delta: 'hello' };
    yield { type: 'usage', usage: { input: 10, output: 2 } };
    yield { type: 'finish', reason: 'end' };
  },
};

beforeEach(async () => {
  db = openDatabase(':memory:');
  await db.insert(users).values({ id: 'u2', username: 'ben', name: 'Ben', role: 'admin', passwordHash: 'x', createdAt: 1, updatedAt: 1 });
  toUser.length = toWindows.length = calls.length = lentCalls.length = streamed.length = 0;
  pair = channelPair({ guestKey: 'key-ben', hostKey: 'key-ada' });
  // The host's side of the channel: a few CoopContract answers, and a client of the guest's PeerContract.
  const { coop, peer: peerLane } = lanes(pair.host);
  const record = (method: string) => async (input: unknown) => (calls.push({ method, input }), { ok: true as const });
  const handlers = {
    'coop.hello': async () => ({ admitted: true, participantId: PARTICIPANT, hostName: 'Ada', sessionId: 'host-1', title: 'Shader', mode: 'code', fingerprint: ['🐙', '🌵', '🎈', '🚀'] }),
    'coop.subscribe': async () => ({ session: { id: 'host-1', title: 'Shader', mode: 'code', model: null, effort: null, status: 'idle' }, messages: [], siblings: {}, seq: 7 }) as unknown as SessionSnapshot,
    'coop.unsubscribe': record('coop.unsubscribe'),
    'chat.respond': record('chat.respond'),
    'chat.send': async (input: unknown) => (calls.push({ method: 'chat.send', input }), { userMessageId: 'm1' }),
    'coop.leave': record('coop.leave'),
    'coop.models': async () => ({}) as never,
  } as unknown as Handlers<typeof CoopContract, object>;
  hostServer = serveRpc(CoopContract, handlers, coop, {});
  peer = createRpcClient(PeerContract, peerLane);
  const models: ModelResolver = { resolve: async (ref) => ({ adapter, info: modelInfo(ref) }), firstAvailable: async () => undefined };
  deps = {
    db,
    relayUrl: () => 'https://relay.test',
    transport: { join: async () => pair.guest },
    secrets: { get: async () => 'S'.repeat(43), set: async () => undefined, delete: async () => undefined },
    profile: async () => ({ name: 'Ben', avatar: null }),
    version: 'test',
    emitToUser: ((_userId: string, event: string, payload: unknown) => void toUser.push({ event, payload })) as never,
    emitSession: (sessionId, _seq, event) => void toWindows.push({ sessionId, event }),
    models,
    limit: async () => null,
    recordUsage: () => undefined,
    connectorTools: async () => [{ name: 'mcp__mail__send', description: 'Send mail', inputSchema: {}, readOnly: false, call: async (input) => (lentCalls.push(input), { content: [{ type: 'text', text: 'sent' }] }) }],
    hasBlob: async () => true,
    putBlob: async () => 'x',
    saveCopy: async () => 'copy-1',
    ownsGroup: async (_userId: string, groupId: string) => groupId === 'g-mine',
    log: () => undefined,
  };
  gateway = new CoopGateway(deps);
});

afterEach(() => db.$client.close());

const refused = async (p: Promise<unknown>, code: string) => {
  const error = await p.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(RpcError);
  expect((error as RpcError).data).toMatchObject({ code });
};

describe('co-op gateway on the guest’s computer', () => {
  it('joining mirrors the host’s session, and its calls go to the host', async () => {
    const { sessionId, waiting } = await gateway.join('u2', INVITE, 'host');
    expect(sessionId).toBe(mirrorId(ROOM, 'host-1'));
    expect(waiting).toBe(false);
    expect(gateway.owns('u2', sessionId)).toBe(true);
    expect(gateway.owns('someone-else', sessionId)).toBe(false);
    const snapshot = (await gateway.call('u2', 'sessions.subscribe', { id: sessionId })) as SessionSnapshot;
    expect(snapshot.session).toMatchObject({ id: sessionId, workspaceId: null, coop: { mirror: true, hostName: 'Ada' } });
    await gateway.call('u2', 'chat.send', { sessionId, parts: [{ type: 'text', text: 'hi' }] });
    expect(calls.at(-1)).toEqual({ method: 'chat.send', input: { parentId: null, parts: [{ type: 'text', text: 'hi' }] } });
    // The host's events reach the windows here under the mirror's id.
    hostServer.emit('session.event', { seq: 8, event: { type: 'typing', participantId: 'x' } });
    await settle();
    expect(toWindows).toContainEqual({ sessionId, event: { type: 'typing', participantId: 'x' } });
    // What a guest can't do in someone else's session isn't forwarded at all.
    await refused(gateway.call('u2', 'sessions.move', { id: sessionId, workspaceId: 'w' }) as Promise<unknown>, 'unsupported');
    expect((await gateway.list('u2')).map((s) => s.id)).toEqual([sessionId]);
  });

  it('runs their own model only, the one they chose, and keeps replay data to their own thinking', async () => {
    await gateway.join('u2', INVITE, 'own', 'p/mine');
    await refused(peer.call('model.describe', { ref: 'p/other' }), 'forbidden');
    await expect(peer.call('model.describe', { ref: 'p/mine' })).resolves.toMatchObject({ ref: 'p/mine' });
    const events: unknown[] = [];
    peer.on('model.event', ({ event }) => events.push(event));
    const messages = [
      { id: 'a', sessionId: 's', parentId: null, role: 'assistant', parts: [{ type: 'thinking', text: 'mine', replay: 'sig', provider: PEER_SELF }], createdAt: 1 },
    ];
    await peer.call('model.stream', { streamId: 's1', request: { model: 'p/mine', system: [], messages, maxOutputTokens: 100 } });
    await settle();
    expect(events).toEqual([{ type: 'text', delta: 'hello' }, { type: 'usage', usage: { input: 10, output: 2 } }, { type: 'finish', reason: 'end' }]);
    expect((streamed[0]!.messages[0]!.parts[0] as { provider: string }).provider).toBe('anthropic');
  });

  it('their connectors are lent only when they say so, and each call only after they allowed it', async () => {
    const { sessionId } = await gateway.join('u2', INVITE, 'host');
    await gateway.call('u2', 'sessions.subscribe', { id: sessionId });
    expect(await peer.call('mcp.list', {})).toEqual([]);
    await refused(peer.call('mcp.call', { name: 'mcp__mail__send', input: { to: 'x' } }), 'forbidden');
    await gateway.call('u2', 'coop.lend', { sessionId, lend: true });
    expect((await peer.call('mcp.list', {})).map((t) => t.name)).toEqual(['mcp__mail__send']);
    // Lending isn't allowing: a call nobody asked them about doesn't run.
    await refused(peer.call('mcp.call', { name: 'mcp__mail__send', input: { to: 'x' } }), 'forbidden');

    // The session asks them, they allow it: that exact call runs, once.
    const toolName = lentToolName(PARTICIPANT.slice(5), 'mcp__mail__send');
    hostServer.emit('session.event', { seq: 9, event: { type: 'pending', pending: { kind: 'permission', id: 'q1', approver: PARTICIPANT, payload: { callId: 'c', toolName, input: { to: 'x' }, reason: '', suggestedRule: '' } } } });
    await settle();
    await gateway.call('u2', 'chat.respond', { sessionId, interactionId: 'q1', answer: { behavior: 'allow' } });
    await refused(peer.call('mcp.call', { name: 'mcp__mail__send', input: { to: 'someone else' } }), 'forbidden');
    await expect(peer.call('mcp.call', { name: 'mcp__mail__send', input: { to: 'x' } })).resolves.toMatchObject({ content: [{ type: 'text', text: 'sent' }] });
    await refused(peer.call('mcp.call', { name: 'mcp__mail__send', input: { to: 'x' } }), 'forbidden');
    expect(lentCalls).toEqual([{ to: 'x' }]);

    // A question for someone else (the host's own) gives them nothing.
    hostServer.emit('session.event', { seq: 10, event: { type: 'pending', pending: { kind: 'permission', id: 'q2', approver: 'account:u1', payload: { callId: 'c', toolName, input: { to: 'y' }, reason: '', suggestedRule: '' } } } });
    await settle();
    await gateway.call('u2', 'chat.respond', { sessionId, interactionId: 'q2', answer: { behavior: 'allow' } });
    await refused(peer.call('mcp.call', { name: 'mcp__mail__send', input: { to: 'y' } }), 'forbidden');
  });

  it('files the mirror in their own sidebar (their name for it, pinned, group, archived, unread) and asks the host nothing', async () => {
    const { sessionId } = await gateway.join('u2', INVITE, 'host');
    const before = calls.length;
    await gateway.call('u2', 'sessions.update', { id: sessionId, title: 'Our shader', pinned: true, groupId: 'g-mine' });
    await gateway.call('u2', 'sessions.update', { id: sessionId, unread: true });
    const [summary] = await gateway.list('u2');
    expect(summary).toMatchObject({ id: sessionId, title: 'Our shader', groupId: 'g-mine', finishedUnseen: true, pinnedAt: expect.any(Number) });
    expect(toUser.at(-1)).toMatchObject({ event: 'sessions.changed', payload: { id: sessionId, finishedUnseen: true } });
    await gateway.call('u2', 'sessions.markSeen', { id: sessionId });
    expect((await gateway.list('u2'))[0]!.finishedUnseen).toBe(false);
    // The window shows their name for it too.
    expect(((await gateway.call('u2', 'sessions.subscribe', { id: sessionId })) as SessionSnapshot).session.title).toBe('Our shader');
    // Someone else's group, and the session's own settings (the host's), are refused.
    await refused(gateway.call('u2', 'sessions.update', { id: sessionId, groupId: 'g-theirs' }) as Promise<unknown>, 'not_found');
    await refused(gateway.call('u2', 'sessions.update', { id: sessionId, model: 'p/other' }) as Promise<unknown>, 'forbidden');
    await gateway.call('u2', 'sessions.update', { id: sessionId, archived: true, title: '' });
    expect((await gateway.list('u2'))[0]).toMatchObject({ title: 'Shader', archivedAt: expect.any(Number) });
    // Nothing of it reached the host.
    expect(calls.slice(before).filter((c) => c.method !== 'coop.subscribe')).toEqual([]);
    // It is kept: Atelier starting again lists it as they filed it.
    await gateway.call('u2', 'sessions.update', { id: sessionId, title: 'Our shader' });
    expect((await new CoopGateway(deps).list('u2'))[0]).toMatchObject({ title: 'Our shader', groupId: 'g-mine', archivedAt: expect.any(Number) });
  });

  it('an ended session without a copy can still be removed after Atelier started again', async () => {
    const { sessionId } = await gateway.join('u2', INVITE, 'host');
    gateway.shutdown();
    await db.update(coopMemberships).set({ endedAt: 5 });
    const again = new CoopGateway(deps);
    await again.resume();
    expect(again.owns('u2', sessionId)).toBe(true);
    expect((await again.list('u2'))[0]).toMatchObject({ id: sessionId, coop: { ended: true } });
    await again.call('u2', 'sessions.delete', { id: sessionId });
    expect(await again.list('u2')).toEqual([]);
  });

  it('when the host’s computer is away, windows hear it and calls say so calmly', async () => {
    const { sessionId } = await gateway.join('u2', INVITE, 'host');
    pair.hostPresent(false);
    expect(toWindows).toContainEqual({ sessionId, event: { type: 'host_away', away: true } });
    await refused(gateway.call('u2', 'chat.send', { sessionId, parts: [{ type: 'text', text: 'hi' }] }) as Promise<unknown>, 'host_away');
  });

  it('when co-op ends with a copy allowed, the conversation becomes a session of their own', async () => {
    const { sessionId } = await gateway.join('u2', INVITE, 'host');
    hostServer.emit('gone', { reason: 'ended', copy: true });
    await settle(10);
    expect(toUser).toContainEqual({ event: 'sessions.removed', payload: { id: sessionId } });
    expect(await gateway.list('u2')).toEqual([]);
  });
});

describe('a guest’s model as the host runs it', () => {
  it('streams the guest’s events, strips others’ replay data, and fails the turn when they go away', async () => {
    const [a, b] = (await import('@atelier/protocol')).createMemoryTransportPair();
    const seen: unknown[] = [];
    const box: { server?: RpcServerConnection<typeof PeerContract> } = {};
    const handlers = {
      'model.stream': async ({ streamId, request }: { streamId: string; request: { messages: unknown[] } }) => {
        seen.push(request.messages);
        box.server!.emit('model.event', { streamId, event: { type: 'text', delta: 'hi' } });
        box.server!.emit('model.event', { streamId, event: { type: 'finish', reason: 'end' } });
        return { ok: true as const };
      },
      'model.cancel': async () => ({ ok: true as const }),
    } as unknown as Handlers<typeof PeerContract, object>;
    box.server = serveRpc(PeerContract, handlers, b, {});
    const client = createRpcClient(PeerContract, a);
    const model = peerAdapter(client, 'abcdefgh12345678', 'p/mine');
    expect(model.type).toBe(peerProviderType('abcdefgh12345678'));
    const messages = [
      { id: '1', role: 'assistant', parts: [{ type: 'thinking', text: 'host', replay: 'host-sig', provider: 'anthropic' }] },
      { id: '2', role: 'assistant', parts: [{ type: 'thinking', text: 'guest', replay: 'guest-sig', provider: model.type }] },
    ];
    const out: StreamEvent[] = [];
    for await (const e of model.stream({ model: 'x', system: [], messages: messages as never, maxOutputTokens: 10, signal: new AbortController().signal })) out.push(e);
    expect(out).toEqual([{ type: 'text', delta: 'hi' }, { type: 'finish', reason: 'end' }]);
    expect(seen[0]).toEqual([
      { id: '1', role: 'assistant', parts: [{ type: 'thinking', text: 'host' }] },
      { id: '2', role: 'assistant', parts: [{ type: 'thinking', text: 'guest', replay: 'guest-sig', provider: PEER_SELF }] },
    ]);

    // Their computer stops answering mid-request: nothing comes back, and the turn ends when it is stopped.
    const [c] = (await import('@atelier/protocol')).createMemoryTransportPair();
    const gone = peerAdapter(createRpcClient(PeerContract, { ...c, send: () => undefined }), 'k', 'p/mine');
    const failed: StreamEvent[] = [];
    const controller = new AbortController();
    const done = (async () => {
      for await (const e of gone.stream({ model: 'x', system: [], messages: [], maxOutputTokens: 10, signal: controller.signal })) failed.push(e);
    })();
    controller.abort();
    await done;
    expect(failed.at(-1)).toMatchObject({ type: 'finish', reason: 'aborted' });
  });
});

describe('the host’s resolver with guests’ models', () => {
  it('keeps every method of the registry it wraps, and refuses a guest who isn’t connected', async () => {
    class Registry {
      async resolve(ref: string) {
        return { adapter: {} as ProviderAdapter, info: modelInfo(ref) };
      }
      async firstAvailable() {
        return 'p/first';
      }
      async listModels() {
        return [modelInfo('p/a')];
      }
      async assertVisible() {}
      avoidSwap(ref: string) {
        return ref;
      }
    }
    const models = withPeerModels(new Registry(), () => null);
    expect(await models.firstAvailable()).toBe('p/first');
    expect((await models.listModels!()).map((m) => m.ref)).toEqual(['p/a']);
    expect((await models.resolve('p/x')).info.ref).toBe('p/x');
    await expect(models.resolve('peer-abcdefgh12345678/p/mine')).rejects.toThrow('isn’t connected');
  });
});
