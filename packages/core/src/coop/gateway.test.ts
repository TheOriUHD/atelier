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
import { CoopGateway, mirrorId, pskSecretId, type CoopGatewayDeps } from './gateway.ts';
import { lanes } from './lanes.ts';
import { peerAdapter, PEER_SELF, peerProviderType, withPeerModels } from './peer-model.ts';
import { peerModelRef } from '@atelier/protocol';
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
    // Its conversation names a sub-agent's session: a tool call that started one.
    'coop.subscribe': async () =>
      ({
        session: { id: 'host-1', title: 'Shader', mode: 'code', model: null, effort: null, status: 'idle' },
        messages: [{ id: 'a1', sessionId: 'host-1', parentId: null, role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'Agent', input: {}, childSessionId: 'agent-1' }], createdAt: 1 }],
        siblings: {},
        seq: 7,
      }) as unknown as SessionSnapshot,
    'coop.subscribeChild': async (input: { sessionId: string }) => (calls.push({ method: 'coop.subscribeChild', input }), { session: { id: input.sessionId, title: 'Agent', mode: 'code' }, messages: [], seq: 2 }) as unknown as SessionSnapshot,
    'coop.unsubscribeChild': record('coop.unsubscribeChild'),
    'coop.unsubscribe': record('coop.unsubscribe'),
    'chat.respond': record('chat.respond'),
    'chat.send': async (input: unknown) => (calls.push({ method: 'chat.send', input }), { userMessageId: 'm1' }),
    'chat.secondOpinion': record('chat.secondOpinion'),
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
    expect(calls.at(-1)).toEqual({ method: 'chat.send', input: { parts: [{ type: 'text', text: 'hi' }] } });
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

  it('runs their own model with its provider’s own model id, through the host’s peer adapter, whatever the provider', async () => {
    // Refs as the guest's registry names them (`<provider id>/<model id>`), and the id each provider must be sent: the
    // ChatGPT Plan said "The 'chatgpt/gpt-6.1-sol' model is not supported" when it got the whole ref.
    const cases: [string, string][] = [
      ['chatgpt/gpt-6.1-sol', 'gpt-6.1-sol'],
      ['openai/gpt-5.2', 'gpt-5.2'],
      ['anthropic/claude-sonnet-5', 'claude-sonnet-5'],
      ['ollama/qwen3:30b', 'qwen3:30b'],
      ['copilot/gpt-5-mini', 'gpt-5-mini'],
      ['lmstudio/openai/gpt-oss-20b', 'openai/gpt-oss-20b'],
    ];
    const received: string[] = [];
    const recording: ProviderAdapter = {
      ...adapter,
      async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
        received.push(request.model);
        yield { type: 'text', delta: 'ok' };
        yield { type: 'finish', reason: 'end' };
      },
    };
    const modelId = (ref: string) => ref.slice(ref.indexOf('/') + 1);
    gateway = new CoopGateway({ ...deps, models: { resolve: async (ref) => ({ adapter: recording, info: { ...modelInfo(ref), modelId: modelId(ref) } }), firstAvailable: async () => undefined } });
    const [[chosen], ...named] = cases as [[string, string], ...[string, string][]];
    const { sessionId } = await gateway.join('u2', INVITE, 'own', chosen);
    // The others they name for one answer each: an @mention, and a second opinion.
    for (const [i, [ref]] of named.entries()) {
      if (i % 2) await gateway.call('u2', 'chat.secondOpinion', { sessionId, messageId: 'a1', model: `own:${ref}` });
      else await gateway.call('u2', 'chat.send', { sessionId, parts: [{ type: 'text', text: 'hi' }], answerWith: `own:${ref}` });
    }
    // The host's side, as backend.ts wraps its registry: none of these are the host's own.
    const host = withPeerModels({ resolve: async () => Promise.reject(new Error('not one of the host’s')), firstAvailable: async () => undefined }, () => peer, () => 'Ben');
    const key = PARTICIPANT.slice('peer:'.length);
    for (const [ref] of cases) {
      const { adapter: theirs, info } = await host.resolve(peerModelRef(key, ref));
      // The host's loop sends the model id it knows, as for any model (chat-service.ts).
      for await (const event of theirs.stream({ model: info.modelId, system: [], messages: [], maxOutputTokens: 10, signal: new AbortController().signal })) expect(event.type).not.toBe('error');
    }
    expect(received).toEqual(cases.map(([, id]) => id));
  });

  it('a failure of their own model says it was theirs, in the host’s session', async () => {
    const failing: ProviderAdapter = {
      ...adapter,
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: 'finish', reason: 'error', error: { code: 'provider_error', message: 'ChatGPT Plan request failed (400): no such model.' } };
      },
    };
    gateway = new CoopGateway({ ...deps, models: { resolve: async (ref) => ({ adapter: failing, info: modelInfo(ref) }), firstAvailable: async () => undefined } });
    await gateway.join('u2', INVITE, 'own', 'chatgpt/gpt-6.1-sol');
    const host = withPeerModels({ resolve: async () => Promise.reject(new Error('no')), firstAvailable: async () => undefined }, () => peer, () => 'Ben');
    const { adapter: theirs } = await host.resolve(peerModelRef(PARTICIPANT.slice(5), 'chatgpt/gpt-6.1-sol'));
    const out: StreamEvent[] = [];
    for await (const event of theirs.stream({ model: 'x', system: [], messages: [], maxOutputTokens: 10, signal: new AbortController().signal })) out.push(event);
    expect(out.at(-1)).toMatchObject({ type: 'finish', reason: 'error', error: { message: 'Ben’s own model (Mine) failed: ChatGPT Plan request failed (400): no such model.' } });
  });

  it('on a server, two accounts in the same room have mirrors, keys and secrets of their own', async () => {
    const used: (string | undefined)[] = [];
    const stored = new Map<string, string>();
    await db.insert(users).values({ id: 'u3', username: 'cy', name: 'Cy', role: 'user', passwordHash: 'x', createdAt: 1, updatedAt: 1 });
    gateway = new CoopGateway({
      ...deps,
      perAccount: true,
      transport: { join: async ({ userId }) => (used.push(userId), channelPair({ guestKey: `key-${userId}`, hostKey: 'key-ada' }).guest) },
      secrets: { get: async (id) => stored.get(id), set: async (id, v) => void stored.set(id, v), delete: async (id) => void stored.delete(id) },
    });
    // Each channel here has no host behind it: joining stops at the hello, after the keys and ids are chosen.
    await Promise.race([gateway.join('u2', INVITE, 'host').catch(() => undefined), settle(20)]);
    await Promise.race([gateway.join('u3', INVITE, 'host').catch(() => undefined), settle(20)]);
    expect(used).toEqual(['u2', 'u3']);
    expect([...stored.keys()].sort()).toEqual([pskSecretId(ROOM, 'u2'), pskSecretId(ROOM, 'u3')].sort());
    expect(pskSecretId(ROOM, 'u2')).not.toBe(pskSecretId(ROOM, 'u3'));
    expect(mirrorId(ROOM, 'host-1', 'u2')).not.toBe(mirrorId(ROOM, 'host-1', 'u3'));
    // A desktop keeps the ids it always had.
    expect(mirrorId(ROOM, 'host-1')).toBe(`coop_${ROOM}_host-1`);
    expect(pskSecretId(ROOM)).toBe(`coop-psk-${ROOM}`);
  });

  it('on a server, a copy keeps only the files its host really sent, and a blob here already is read only once the host sent it', async () => {
    const theirs = 'b'.repeat(64);
    const bytes = Buffer.from('from the host');
    const sentSha = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
    const granted: string[] = [];
    let copied: SessionSnapshot['messages'] = [];
    const { coop } = lanes(pair.host);
    hostServer.close();
    // The host's snapshot names two blobs: one it sends, and another account's of this server that it doesn't have.
    hostServer = serveRpc(
      CoopContract,
      {
        'coop.hello': async () => ({ admitted: true, participantId: PARTICIPANT, hostName: 'Ada', sessionId: 'host-1', title: 'Shader', mode: 'code', fingerprint: ['🐙', '🌵', '🎈', '🚀'] }),
        'coop.state': async () => null,
        'coop.subscribe': async () =>
          ({
            session: { id: 'host-1', title: 'Shader', mode: 'code' },
            messages: [{ id: 'u1', sessionId: 'host-1', parentId: null, role: 'user', parts: [{ type: 'text', text: 'look' }, { type: 'image', blob: theirs, mime: 'image/png' }, { type: 'image', blob: sentSha, mime: 'image/png' }], createdAt: 1 }],
            siblings: {},
            seq: 1,
          }) as unknown as SessionSnapshot,
        'blob.get': async ({ sha256 }: { sha256: string }) => {
          if (sha256 !== sentSha) throw new Error('not in this session');
          return { mime: 'image/png', dataBase64: bytes.toString('base64') };
        },
      } as unknown as Handlers<typeof CoopContract, object>,
      coop,
      {},
    );
    gateway = new CoopGateway({
      ...deps,
      perAccount: true,
      hasBlob: async () => true,
      canRead: async () => false,
      grant: (_userId, sha) => void granted.push(sha),
      saveCopy: async (_userId, snapshot) => ((copied = snapshot.messages), 'copy-1'),
    });
    const { sessionId } = await gateway.join('u2', INVITE, 'host');
    // A blob that is here already but isn't theirs: only the host's own copy of it lets them read it.
    expect(await gateway.fetchBlob('u2', theirs)).toBe(false);
    expect(await gateway.fetchBlob('u2', sentSha)).toBe(true);
    expect(granted).toEqual([sentSha]);
    expect(await gateway.fetchBlob('someone-else', sentSha)).toBe(false);

    hostServer.emit('gone', { reason: 'ended', copy: true });
    await settle(20);
    expect(toUser).toContainEqual({ event: 'sessions.removed', payload: { id: sessionId } });
    expect(JSON.stringify(copied)).not.toContain(theirs);
    expect(JSON.stringify(copied)).toContain(sentSha);
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

  it('opens the transcript of a sub-agent its conversation names, read-only, with its events', async () => {
    const { sessionId } = await gateway.join('u2', INVITE, 'host');
    expect(gateway.owns('u2', 'agent-1')).toBe(false);
    await gateway.call('u2', 'sessions.subscribe', { id: sessionId });
    expect(gateway.owns('u2', 'agent-1')).toBe(true);
    expect(gateway.owns('someone-else', 'agent-1')).toBe(false);
    // One it never heard of isn't asked for.
    await refused(gateway.call('u2', 'sessions.subscribe', { id: 'agent-2' }) as Promise<unknown>, 'not_found');

    const snapshot = (await gateway.call('u2', 'sessions.subscribe', { id: 'agent-1' })) as SessionSnapshot;
    expect(snapshot.session.id).toBe('agent-1');
    expect(calls.at(-1)).toEqual({ method: 'coop.subscribeChild', input: { sessionId: 'agent-1' } });
    hostServer.emit('child.event', { sessionId: 'agent-1', seq: 3, event: { type: 'status', status: 'running' } });
    // A sub-agent of the sub-agent, named in its events, opens too.
    hostServer.emit('child.event', { sessionId: 'agent-1', seq: 4, event: { type: 'tasks', tasks: [{ id: 't', kind: 'agent', title: 'x', command: null, sessionId: 'agent-3', background: true, loop: null, startedAt: 1, endedAt: null, status: 'running', exitCode: null }] } });
    await settle();
    expect(toWindows).toContainEqual({ sessionId: 'agent-1', event: { type: 'status', status: 'running' } });
    expect(gateway.owns('u2', 'agent-3')).toBe(true);
    // Only for reading.
    await refused(gateway.call('u2', 'chat.send', { sessionId: 'agent-1', parts: [{ type: 'text', text: 'hi' }] }) as Promise<unknown>, 'unsupported');
    await gateway.call('u2', 'sessions.unsubscribe', { id: 'agent-1' });
    expect(calls.at(-1)).toEqual({ method: 'coop.unsubscribeChild', input: { sessionId: 'agent-1' } });
    hostServer.emit('child.event', { sessionId: 'agent-1', seq: 5, event: { type: 'status', status: 'idle' } });
    await settle();
    expect(toWindows).not.toContainEqual({ sessionId: 'agent-1', event: { type: 'status', status: 'idle' } });
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
