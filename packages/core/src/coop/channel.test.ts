import { randomBytes } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  createRoom,
  decodeKey,
  deleteRoom,
  encodeKey,
  generateStaticKey,
  joinRoom,
  openHostRoom,
  parseStaticKey,
  serializeStaticKey,
  type CoopTiming,
  type HostRoom,
  type PeerChannel,
  type RelayState,
  type StaticKey,
} from './channel.ts';
import { fingerprint, makeInvite, newInviteSecret, pskFromSecret } from './invite.ts';
import { HandshakeState } from './noise.ts';
import { startCoopRelay, type StandaloneCoopRelay } from './relay-node.ts';

const MiB = 1024 * 1024;
const timing: Partial<CoopTiming> = { backoff: () => 20, handshakeMs: 3000 };

let relay: StandaloneCoopRelay;
const cleanup: (() => unknown)[] = [];

beforeEach(async () => {
  relay = await startCoopRelay({ port: 0, limits: { bytesPerSecond: 512 * MiB, burstBytes: 512 * MiB, heldBytes: 64 * MiB } });
});

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  await relay.close();
});

function once<T extends unknown[]>(emitter: EventEmitter, event: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No ${event} within ${timeoutMs} ms`)), timeoutMs);
    emitter.once(event, (...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args as T);
    });
  });
}

function nextMessage(channel: { onMessage(listener: (m: unknown) => void): () => void }, timeoutMs = 10_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No message in time')), timeoutMs);
    const off = channel.onMessage((message) => {
      clearTimeout(timer);
      off();
      resolve(message);
    });
  });
}

/** Resolves with the state changes until `until`. */
function states(room: HostRoom, until: RelayState): Promise<RelayState[]> {
  const seen: RelayState[] = [];
  return new Promise((resolve) => {
    const listener = (state: RelayState) => {
      seen.push(state);
      if (state === until) {
        room.off('relay-state', listener);
        resolve(seen);
      }
    };
    room.on('relay-state', listener);
  });
}

interface Room {
  roomId: string;
  hostToken: string;
  psk: Uint8Array;
  hostKey: StaticKey;
  host: HostRoom;
  pinned: Set<string>;
}

async function hostRoom(relayUrl = relay.url): Promise<Room> {
  const { roomId, hostToken } = await createRoom(relayUrl);
  const invite = makeInvite(roomId);
  const psk = pskFromSecret(invite.secret);
  const hostKey = generateStaticKey();
  const pinned = new Set<string>();
  const host = await openHostRoom({ relayUrl, roomId, hostToken, psk, staticKey: hostKey, knownPeers: (key) => pinned.has(encodeKey(key)), timing });
  cleanup.push(() => host.close());
  return { roomId, hostToken, psk, hostKey, host, pinned };
}

async function guest(room: Room, name: string, options: { key?: StaticKey; psk?: Uint8Array; hostKey?: Uint8Array; relayUrl?: string } = {}) {
  const key = options.key ?? generateStaticKey();
  const peer = once<[PeerChannel]>(room.host, 'peer');
  peer.catch(() => {});
  const channel = await joinRoom({ relayUrl: options.relayUrl ?? relay.url, roomId: room.roomId, psk: options.psk ?? room.psk, staticKey: key, hello: { name, version: '0.4.3' }, hostKey: options.hostKey, timing });
  cleanup.push(() => channel.close());
  const [hostSide] = await peer;
  return { channel, peer: hostSide, key };
}

/** About 5 MB of JSON that doesn't compress, and 5 MB that does. */
const big = () => ({ kind: 'file', data: randomBytes(3_750_000).toString('base64') });
const compressible = () => ({ kind: 'log', lines: Array.from({ length: 100_000 }, (_, i) => `line ${i}: the build is still running`) });

describe('co-op channels through the Node relay', () => {
  it('connects one host and two guests, with matching fingerprints and pinned keys, and carries small and 5 MB messages both ways', async () => {
    const room = await hostRoom();
    const ada = await guest(room, 'Ada');
    const bob = await guest(room, 'Bob');

    expect(room.host.peers.map((p) => p.hello.name).sort()).toEqual(['Ada', 'Bob']);
    expect(ada.peer.slot).not.toBe(bob.peer.slot);
    expect(ada.peer.remoteStatic).toEqual(ada.key.publicKey);
    expect(ada.peer.known).toBe(false);
    expect(ada.channel.remoteStatic).toEqual(room.hostKey.publicKey);
    expect(ada.peer.fingerprint).toEqual(ada.channel.fingerprint);
    expect(ada.peer.fingerprint).toEqual(fingerprint(ada.channel.handshakeHash));
    expect(ada.peer.handshakeHash).not.toEqual(bob.peer.handshakeHash);

    // Small messages, each way, to each guest.
    const toHost = nextMessage(ada.peer);
    await ada.channel.send({ hello: 'host', n: 1 });
    expect(await toHost).toEqual({ hello: 'host', n: 1 });
    const toBob = nextMessage(bob.channel);
    await bob.peer.send(['to', 'bob', null, true]);
    expect(await toBob).toEqual(['to', 'bob', null, true]);

    // 5 MB, both directions, compressible or not.
    const file = big();
    expect(JSON.stringify(file).length).toBeGreaterThan(5_000_000);
    const fileAtHost = nextMessage(ada.peer);
    await ada.channel.send(file);
    expect(await fileAtHost).toEqual(file);
    const log = compressible();
    const logAtBob = nextMessage(bob.channel);
    await bob.peer.send(log);
    expect(await logAtBob).toEqual(log);
    const fileAtAda = nextMessage(ada.channel);
    await ada.peer.send(file);
    expect(await fileAtAda).toEqual(file);

    // Messages keep their order, and a message sent before anyone listens still arrives.
    await Promise.all([1, 2, 3].map((n) => bob.channel.send({ n })));
    const got: unknown[] = [];
    await new Promise<void>((resolve) =>
      bob.peer.onMessage((m) => {
        got.push(m);
        if (got.length === 3) resolve();
      }),
    );
    expect(got).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('tells the host when a guest leaves, and the other guest carries on', async () => {
    const room = await hostRoom();
    const ada = await guest(room, 'Ada');
    const bob = await guest(room, 'Bob');
    const closed = new Promise((resolve) => bob.peer.onClose(resolve));
    const left = once<[PeerChannel, string]>(room.host, 'peer-left');
    bob.channel.close();
    const [peer, reason] = await left;
    expect(peer).toBe(bob.peer);
    expect(reason).toBe('left');
    expect(await closed).toBe('left');
    expect(bob.peer.open).toBe(false);
    await expect(bob.peer.send({})).rejects.toMatchObject({ code: 'closed' });
    await expect(bob.channel.send({})).rejects.toMatchObject({ code: 'closed' });
    expect(room.host.peers).toEqual([ada.peer]);
    const message = nextMessage(ada.channel);
    await ada.peer.send('still here');
    expect(await message).toBe('still here');
  });

  it("keeps the guests' sessions through a dropped host link, without new handshakes", async () => {
    const room = await hostRoom();
    const ada = await guest(room, 'Ada');
    const bob = await guest(room, 'Bob');
    let handshakes = 0;
    room.host.on('peer', () => handshakes++);
    const relayStates = states(room.host, 'connected');
    const adaAway = once<[boolean]>(ada.channel, 'host');
    const adaBack = once(ada.channel, 'reconnected');
    const bobBack = once(bob.channel, 'reconnected');

    room.host.dropLinkForTest();
    expect(await adaAway).toEqual([false]);
    expect(await relayStates).toEqual(['reconnecting', 'connected']);
    await Promise.all([adaBack, bobBack]);

    expect(handshakes).toBe(0);
    expect(room.host.peers.sort((a, b) => a.slot - b.slot)).toEqual([ada.peer, bob.peer].sort((a, b) => a.slot - b.slot));
    const atHost = nextMessage(ada.peer);
    await ada.channel.send({ after: 'the drop' });
    expect(await atHost).toEqual({ after: 'the drop' });
    const atBob = nextMessage(bob.channel);
    const file = big();
    await bob.peer.send(file);
    expect(await atBob).toEqual(file);
  });

  it('re-joins a guest whose link dropped, with a fresh handshake the host recognises by its pinned key', async () => {
    const room = await hostRoom();
    const ada = await guest(room, 'Ada');
    room.pinned.add(ada.peer.remoteKey);
    const left = once<[PeerChannel, string]>(room.host, 'peer-left');
    const rejoined = once<[PeerChannel]>(room.host, 'peer');
    const reconnected = once(ada.channel, 'reconnected');
    const firstHash = ada.channel.handshakeHash;

    ada.channel.dropLinkForTest();
    const [oldPeer, reason] = await left;
    expect(oldPeer).toBe(ada.peer);
    expect(reason).toBe('left');
    const [peer] = await rejoined;
    await reconnected;
    expect(peer).not.toBe(ada.peer);
    expect(peer.slot).not.toBe(ada.peer.slot);
    expect(peer.remoteStatic).toEqual(ada.key.publicKey);
    expect(peer.known).toBe(true);
    expect(ada.channel.handshakeHash).not.toEqual(firstHash);
    expect(peer.fingerprint).toEqual(ada.channel.fingerprint);

    const atHost = nextMessage(peer);
    await ada.channel.send('back again');
    expect(await atHost).toBe('back again');
    const atAda = nextMessage(ada.channel);
    await peer.send({ welcome: 'back' });
    expect(await atAda).toEqual({ welcome: 'back' });
  });

  it('starts over with the host that restarted and lost the sessions', async () => {
    const room = await hostRoom();
    const ada = await guest(room, 'Ada');
    const reconnected = once(ada.channel, 'reconnected');
    room.host.close();
    // The same host, a new process: same token and key, no sessions.
    const again = await openHostRoom({ relayUrl: relay.url, roomId: room.roomId, hostToken: room.hostToken, psk: room.psk, staticKey: room.hostKey, timing });
    cleanup.push(() => again.close());
    const [peer] = await once<[PeerChannel]>(again, 'peer');
    await reconnected;
    expect(peer.remoteStatic).toEqual(ada.key.publicKey);
    const atHost = nextMessage(peer);
    await ada.channel.send('hello, new host');
    expect(await atHost).toBe('hello, new host');
  });

  it('waits for a host that is not there yet', async () => {
    const { roomId, hostToken } = await createRoom(relay.url);
    const psk = pskFromSecret(newInviteSecret());
    const statuses: string[] = [];
    const joining = joinRoom({ relayUrl: relay.url, roomId, psk, staticKey: generateStaticKey(), hello: { name: 'Early', version: '1' }, onStatus: (s) => statuses.push(s), timing });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(statuses).toEqual(['connecting', 'waiting-for-host']);
    const host = await openHostRoom({ relayUrl: relay.url, roomId, hostToken, psk, staticKey: generateStaticKey(), timing });
    cleanup.push(() => host.close());
    const channel = await joining;
    cleanup.push(() => channel.close());
    expect(statuses).toEqual(['connecting', 'waiting-for-host', 'handshaking']);
    expect(host.peers.map((p) => p.hello.name)).toEqual(['Early']);
  });

  it('refuses a guest with a wrong invite, and a host whose key is not the pinned one', async () => {
    const room = await hostRoom();
    const wrong = joinRoom({ relayUrl: relay.url, roomId: room.roomId, psk: pskFromSecret(newInviteSecret()), staticKey: generateStaticKey(), hello: { name: 'Mallory', version: '1' }, timing });
    await expect(wrong).rejects.toMatchObject({ code: 'refused' });
    expect(room.host.peers).toEqual([]);
    const impostor = joinRoom({ relayUrl: relay.url, roomId: room.roomId, psk: room.psk, staticKey: generateStaticKey(), hello: { name: 'Ada', version: '1' }, hostKey: generateStaticKey().publicKey, timing });
    await expect(impostor).rejects.toMatchObject({ code: 'host_key_changed' });
    await expect(joinRoom({ relayUrl: relay.url, roomId: 'AAAAAAAAAAAAAAAAAAAAAA', psk: room.psk, staticKey: generateStaticKey(), hello: { name: 'Ada', version: '1' }, timing })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('lets the host remove a guest, and stops at three guests', async () => {
    const room = await hostRoom();
    const guests = [await guest(room, 'A'), await guest(room, 'B'), await guest(room, 'C')];
    await expect(joinRoom({ relayUrl: relay.url, roomId: room.roomId, psk: room.psk, staticKey: generateStaticKey(), hello: { name: 'D', version: '1' }, timing })).rejects.toMatchObject({ code: 'full' });
    const closed = new Promise((resolve) => guests[0]!.channel.onClose(resolve));
    guests[0]!.peer.close();
    expect(await closed).toBe('removed');
    expect(guests[0]!.channel.open).toBe(false);
    expect(room.host.peers).toHaveLength(2);
  });

  it('closes everything when the host deletes the room', async () => {
    const room = await hostRoom();
    const ada = await guest(room, 'Ada');
    const guestClosed = new Promise((resolve) => ada.channel.onClose(resolve));
    const hostStates = states(room.host, 'closed');
    await deleteRoom(relay.url, room.roomId, room.hostToken);
    expect(await guestClosed).toBe('room-closed');
    expect((await hostStates).at(-1)).toBe('closed');
    expect(ada.peer.open).toBe(false);
    // Deleting it again is fine; joining it isn't.
    await deleteRoom(relay.url, room.roomId, room.hostToken);
    await expect(joinRoom({ relayUrl: relay.url, roomId: room.roomId, psk: room.psk, staticKey: generateStaticKey(), hello: { name: 'Late', version: '1' }, timing })).rejects.toMatchObject({ code: 'not_found' });
  });

  it("paces itself under a slow room's rate, and the message still arrives whole", async () => {
    const slow = await startCoopRelay({ port: 0, limits: { bytesPerSecond: 2 * MiB, burstBytes: 512 * 1024 } });
    cleanup.push(() => slow.close());
    const room = await hostRoom(slow.url);
    const ada = await guest(room, 'Ada', { relayUrl: slow.url });
    const payload = { data: randomBytes(1_500_000).toString('base64') };
    const started = Date.now();
    const atHost = nextMessage(ada.peer);
    await ada.channel.send(payload);
    expect(await atHost).toEqual(payload);
    // 2 MB at 2 MiB/s after a 256 KiB burst (the client's half of the room's): most of a second.
    expect(Date.now() - started).toBeGreaterThan(600);
  });

  it('speaks the documented frames, and keeps a session through a replayed first message', async () => {
    const room = await hostRoom();
    const key = generateStaticKey();
    const ws = new WebSocket(`${relay.url.replace('http', 'ws')}/v1/rooms/${room.roomId}?role=guest`);
    cleanup.push(() => ws.terminate());
    const binary: Uint8Array[] = [];
    let wake: (() => void) | null = null;
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      binary.push(new Uint8Array(data as Buffer));
      wake?.();
    });
    const next = async () => {
      while (!binary.length) await new Promise<void>((resolve) => (wake = resolve));
      return binary.shift()!;
    };
    await new Promise((resolve) => ws.once('open', resolve));
    const frame = (type: number, attempt: number, message: Uint8Array) => {
      const out = Buffer.alloc(5 + message.length);
      out[0] = type;
      out.writeUInt32LE(attempt, 1);
      out.set(message, 5);
      return out;
    };
    const handshake = new HandshakeState({ initiator: true, staticKey: key, psk: room.psk, prologue: new TextEncoder().encode(`atelier coop v1\n${room.roomId}`) });
    const first = frame(1, 7, handshake.writeMessage());
    ws.send(first);
    const second = await next();
    expect([second[0], Buffer.from(second).readUInt32LE(1)]).toEqual([2, 7]);
    handshake.readMessage(second.subarray(5));
    const peerEvent = once<[PeerChannel]>(room.host, 'peer');
    ws.send(frame(3, 7, handshake.writeMessage(Buffer.from(JSON.stringify({ name: 'By hand', version: '1' })))));
    const [peer] = await peerEvent;
    expect(peer.hello.name).toBe('By hand');
    const transport = handshake.split();
    // The host's confirmation: [4][nonce 0][the plaintext [0], encrypted].
    const confirm = await next();
    expect([confirm[0], Buffer.from(confirm).readBigUInt64LE(1)]).toEqual([4, 0n]);
    expect(transport.receive.decrypt(confirm.subarray(9))).toEqual(Uint8Array.of(0));

    // Anyone (the relay, say) can send the first message again: the session stays.
    let left = false;
    room.host.on('peer-left', () => (left = true));
    ws.send(first);
    expect((await next())[0]).toBe(2);
    // A one-chunk message through the session: [1][flags][id][index][count] and the JSON.
    const json = Buffer.from(JSON.stringify({ still: 'here' }));
    const plain = Buffer.alloc(14 + json.length);
    plain[0] = 1;
    plain.writeUInt32LE(1, 2);
    plain.writeUInt32LE(0, 6);
    plain.writeUInt32LE(1, 10);
    plain.set(json, 14);
    const nonce = Buffer.alloc(8);
    nonce.writeBigUInt64LE(BigInt(transport.send.nonce));
    const message = nextMessage(peer);
    ws.send(Buffer.concat([Uint8Array.of(4), nonce, transport.send.encrypt(plain)]));
    expect(await message).toEqual({ still: 'here' });
    expect(left).toBe(false);
    expect(peer.open).toBe(true);
  });

  it('refuses what JSON or the size limit cannot carry', async () => {
    const room = await hostRoom();
    const ada = await guest(room, 'Ada');
    await expect(ada.channel.send(undefined)).rejects.toThrow(TypeError);
    await expect(ada.peer.send('x'.repeat(65 * MiB))).rejects.toMatchObject({ code: 'too_large' });
    const message = nextMessage(ada.peer);
    await ada.channel.send('fine after that');
    expect(await message).toBe('fine after that');
  });
});

describe('co-op keys', () => {
  it('stores a static key as base64 and reads it back', () => {
    const key = generateStaticKey();
    const text = serializeStaticKey(key);
    expect(text).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(parseStaticKey(text)).toEqual(key);
    expect(decodeKey(encodeKey(key.publicKey))).toEqual(key.publicKey);
    expect(() => decodeKey('short')).toThrow(TypeError);
  });
});
