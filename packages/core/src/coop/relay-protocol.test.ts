import { describe, expect, it } from 'vitest';
import {
  bearer,
  CloseCode,
  DEFAULT_LIMITS,
  fromBase64Url,
  hashToken,
  MAX_GUEST_FRAME,
  MAX_HOST_FRAME,
  newHostToken,
  newRoomId,
  parseJoin,
  RateLimiter,
  Room,
  roomPath,
  sameText,
  toBase64Url,
  type RelayLimits,
  type RoomAction,
} from './relay-protocol.ts';

const T0 = 1_000_000;
const token = newHostToken();
const tokenHash = await hashToken(token);

function room(limits?: Partial<RelayLimits>) {
  return Room.create(newRoomId(), tokenHash, T0, limits);
}

function join(r: Room, id: string, role: 'host' | 'guest', now = T0, hash: string | null = tokenHash) {
  const result = r.join({ id, role, tokenHash: role === 'host' ? hash : null, ip: '203.0.113.7' }, now);
  if (!result.ok) throw new Error(`${id} was refused: ${result.status}`);
  return result;
}

const texts = (actions: RoomAction[], to?: string) => actions.filter((a) => a.type === 'text' && (!to || a.to === to)).map((a) => (a.type === 'text' ? (a.text === 'pong' ? a.text : JSON.parse(a.text)) : null));
const sends = (actions: RoomAction[]) => actions.filter((a) => a.type === 'send').map((a) => (a.type === 'send' ? { to: a.to, data: [...a.data] } : null));
const closes = (actions: RoomAction[]) => actions.filter((a) => a.type === 'close').map((a) => (a.type === 'close' ? { to: a.to, code: a.code } : null));

describe('a co-op room', () => {
  it('lets the host in only with its token', () => {
    const r = room();
    expect(r.join({ id: 'h', role: 'host', tokenHash: null, ip: 'x' }, T0)).toMatchObject({ ok: false, status: 403 });
    expect(r.join({ id: 'h', role: 'host', tokenHash: '0'.repeat(64), ip: 'x' }, T0)).toMatchObject({ ok: false, status: 403 });
    const host = join(r, 'h', 'host');
    expect(host.conn).toMatchObject({ id: 'h', role: 'host', slot: 0 });
    expect(texts(host.actions)).toEqual([{ t: 'welcome', role: 'host', room: r.id, slots: [], limits: { maxFrame: MAX_HOST_FRAME, bytesPerSecond: DEFAULT_LIMITS.bytesPerSecond, burstBytes: DEFAULT_LIMITS.burstBytes, pingMs: DEFAULT_LIMITS.pingMs } }]);
    expect(r.hostConnected).toBe(true);
  });

  it('gives guests slots, tells the host, and stops at four people including the host', () => {
    const r = room();
    const a = join(r, 'a', 'guest');
    expect(a.conn.slot).toBe(1);
    expect(texts(a.actions)).toEqual([expect.objectContaining({ t: 'welcome', role: 'guest', slot: 1, host: false })]);
    const host = join(r, 'h', 'host');
    expect(texts(host.actions, 'h')).toEqual([expect.objectContaining({ t: 'welcome', slots: [1] })]);
    expect(texts(host.actions, 'a')).toEqual([{ t: 'host', present: true }]);
    const b = join(r, 'b', 'guest');
    expect(texts(b.actions, 'h')).toEqual([{ t: 'joined', slot: 2 }]);
    expect(texts(b.actions, 'b')).toEqual([expect.objectContaining({ slot: 2, host: true })]);
    join(r, 'c', 'guest');
    expect(r.join({ id: 'd', role: 'guest', ip: 'x' }, T0)).toMatchObject({ ok: false, status: 409 });
    expect(r.slots).toEqual([1, 2, 3]);

    // A guest who leaves frees the place, but the next one gets a new slot number.
    expect(texts(r.disconnect('b', T0), 'h')).toEqual([{ t: 'left', slot: 2 }]);
    expect(join(r, 'd', 'guest').conn.slot).toBe(4);
    expect(r.disconnect('nobody', T0)).toEqual([]);
  });

  it('wraps slot numbers after 255 and skips the ones in use', () => {
    const r = Room.restore({ ...room().record, nextSlot: 255 }, [{ id: 'x', role: 'guest', slot: 1, ip: 'x', openedAt: T0 }], T0);
    expect(join(r, 'a', 'guest').conn.slot).toBe(255);
    expect(join(r, 'b', 'guest').conn.slot).toBe(2);
  });

  it('routes guest frames to the host with the slot in front, and host frames to the slot named', () => {
    const r = room();
    join(r, 'h', 'host');
    join(r, 'a', 'guest');
    join(r, 'b', 'guest');
    expect(sends(r.receive('a', Uint8Array.of(9, 8, 7), T0))).toEqual([{ to: 'h', data: [1, 9, 8, 7] }]);
    expect(sends(r.receive('b', Uint8Array.of(5), T0))).toEqual([{ to: 'h', data: [2, 5] }]);
    expect(sends(r.receive('h', Uint8Array.of(2, 4, 4), T0))).toEqual([{ to: 'b', data: [4, 4] }]);
    // A slot that isn't there (just left, say): dropped.
    expect(r.receive('h', Uint8Array.of(3, 1), T0)).toEqual([]);
    // Guests only ever reach the host; a ping gets its pong.
    expect(texts(r.receive('a', 'ping', T0))).toEqual(['pong']);
    expect(r.receive('a', '{"t":"kick","slot":2}', T0)).toEqual([]);
  });

  it("drops guests' frames while the host is away, and tells guests when it comes and goes", () => {
    const r = room();
    join(r, 'a', 'guest');
    expect(r.receive('a', Uint8Array.of(1, 2), T0)).toEqual([]);
    join(r, 'h', 'host');
    expect(texts(r.disconnect('h', T0 + 5), 'a')).toEqual([{ t: 'host', present: false }]);
    expect(r.hostConnected).toBe(false);
    expect(r.record.hostSeenAt).toBe(T0 + 5);
  });

  it('lets a newer host connection replace the older one, without telling guests the host left', () => {
    const r = room();
    join(r, 'h1', 'host');
    join(r, 'a', 'guest');
    const second = join(r, 'h2', 'host');
    expect(closes(second.actions)).toEqual([{ to: 'h1', code: CloseCode.replaced }]);
    expect(texts(second.actions, 'a')).toEqual([]);
    expect(texts(second.actions, 'h2')).toEqual([expect.objectContaining({ t: 'welcome', slots: [1] })]);
    // The old socket's close arrives later and changes nothing.
    expect(r.disconnect('h1', T0)).toEqual([]);
    expect(sends(r.receive('a', Uint8Array.of(1), T0))).toEqual([{ to: 'h2', data: [1, 1] }]);
  });

  it('lets the host remove a guest, with its own code in 4010–4019', () => {
    const r = room();
    join(r, 'h', 'host');
    join(r, 'a', 'guest');
    join(r, 'b', 'guest');
    const kicked = r.receive('h', JSON.stringify({ t: 'kick', slot: 1, code: CloseCode.refused }), T0);
    expect(closes(kicked)).toEqual([{ to: 'a', code: CloseCode.refused }]);
    expect(texts(kicked, 'h')).toEqual([{ t: 'left', slot: 1 }]);
    expect(closes(r.receive('h', JSON.stringify({ t: 'kick', slot: 2, code: 1000 }), T0))).toEqual([{ to: 'b', code: CloseCode.removed }]);
    expect(r.slots).toEqual([]);
    expect(r.receive('h', JSON.stringify({ t: 'something new' }), T0)).toEqual([]);
    expect(closes(r.receive('h', 'not json', T0))).toEqual([{ to: 'h', code: CloseCode.protocol }]);
  });

  it('closes connections that send frames over the size limit', () => {
    const r = room();
    join(r, 'h', 'host');
    join(r, 'a', 'guest');
    expect(r.receive('h', new Uint8Array(MAX_HOST_FRAME), T0).filter((a) => a.type === 'close')).toEqual([]);
    const tooBig = r.receive('a', new Uint8Array(MAX_GUEST_FRAME + 1), T0);
    expect(closes(tooBig)).toEqual([{ to: 'a', code: CloseCode.tooBig }]);
    expect(texts(tooBig, 'h')).toEqual([{ t: 'left', slot: 1 }]);
    join(r, 'b', 'guest');
    const hostTooBig = r.receive('h', new Uint8Array(MAX_HOST_FRAME + 1), T0);
    expect(closes(hostTooBig)).toEqual([{ to: 'h', code: CloseCode.tooBig }]);
    expect(texts(hostTooBig, 'b')).toEqual([{ t: 'host', present: false }]);
  });

  it('holds frames over the room rate in order, pauses the sender, and lets them go as the rate allows', () => {
    const limits = { bytesPerSecond: 100_000, burstBytes: 0, heldBytes: 200_000 };
    const r = room(limits);
    expect(r.limits.burstBytes).toBe(MAX_HOST_FRAME);
    join(r, 'h', 'host');
    join(r, 'a', 'guest');
    const frame = (n: number) => new Uint8Array(60_000).fill(n);
    expect(sends(r.receive('a', frame(1), T0))).toHaveLength(1);
    expect(r.receive('a', frame(2), T0)).toEqual([{ type: 'pause', conn: 'a' }]);
    expect(r.receive('a', frame(3), T0)).toEqual([]);
    // 60,000 bytes come back after 0.6 s at 100,000 bytes a second (5,536 were left).
    expect(r.heldUntil(T0)).toBe(T0 + 545);
    expect(r.tick(T0 + 100)).toEqual([]);
    const first = r.tick(T0 + 545);
    expect(sends(first).map((s) => s!.data[1])).toEqual([2]);
    expect(first.filter((a) => a.type === 'resume')).toEqual([]);
    const second = r.tick(T0 + 1200);
    expect(sends(second).map((s) => s!.data[1])).toEqual([3]);
    expect(second.filter((a) => a.type === 'resume')).toEqual([{ type: 'resume', conn: 'a' }]);
    expect(r.heldUntil(T0 + 1200)).toBeNull();
  });

  it('closes a sender once the room holds more than it may', () => {
    const r = room({ bytesPerSecond: 1000, burstBytes: 0, heldBytes: 100_000 });
    join(r, 'h', 'host');
    join(r, 'a', 'guest');
    r.receive('a', new Uint8Array(65_000), T0);
    r.receive('a', new Uint8Array(65_000), T0);
    const over = r.receive('a', new Uint8Array(65_000), T0);
    expect(closes(over)).toEqual([{ to: 'a', code: CloseCode.overRate }]);
    // What it had waiting goes with it.
    expect(r.heldUntil(T0)).toBeNull();
  });

  it('closes 24 hours after the host was last connected, and not while it is', () => {
    const day = DEFAULT_LIMITS.roomTtlMs;
    const r = room();
    expect(r.expiresAt()).toBe(T0 + day);
    join(r, 'h', 'host', T0 + 10);
    expect(r.expiresAt()).toBe(Infinity);
    join(r, 'a', 'guest', T0 + 10);
    r.disconnect('h', T0 + 1000);
    expect(r.expiresAt()).toBe(T0 + 1000 + day);
    // The guest keeps pinging; the room stays until the day is over.
    r.touch('a', T0 + 1000 + day - 1);
    expect(r.tick(T0 + 1000 + day - 1)).toEqual([]);
    const expired = r.tick(T0 + 1000 + day);
    expect(closes(expired)).toEqual([{ to: 'a', code: CloseCode.roomClosed }]);
    expect(expired.at(-1)).toEqual({ type: 'closed' });
    expect(r.closed).toBe(true);
    expect(r.join({ id: 'h', role: 'host', tokenHash, ip: 'x' }, T0 + 1000 + day)).toMatchObject({ ok: false, status: 404 });
  });

  it('closes when the host deletes it', () => {
    const r = room();
    join(r, 'h', 'host');
    join(r, 'a', 'guest');
    const removed = r.remove();
    expect(closes(removed)).toEqual([
      { to: 'h', code: CloseCode.roomClosed },
      { to: 'a', code: CloseCode.roomClosed },
    ]);
    expect(r.join({ id: 'b', role: 'guest', ip: 'x' }, T0)).toMatchObject({ ok: false, status: 404 });
  });

  it('closes connections that went quiet, so a vanished guest frees its place', () => {
    const r = room();
    join(r, 'h', 'host');
    join(r, 'a', 'guest');
    expect(r.nextDeadline()).toBe(T0 + DEFAULT_LIMITS.idleMs);
    r.receive('h', 'ping', T0 + 30_000);
    const idle = r.tick(T0 + DEFAULT_LIMITS.idleMs);
    expect(closes(idle)).toEqual([{ to: 'a', code: CloseCode.idle }]);
    expect(texts(idle, 'h')).toEqual([{ t: 'left', slot: 1 }]);
    expect(r.nextDeadline()).toBe(T0 + 30_000 + DEFAULT_LIMITS.idleMs);
  });

  it('comes back from its record and open connections (the Worker after hibernation)', () => {
    const r = room();
    join(r, 'h', 'host');
    join(r, 'a', 'guest');
    const again = Room.restore(r.record, r.connections, T0 + 5);
    expect(again.hostConnected).toBe(true);
    expect(again.slots).toEqual([1]);
    expect(sends(again.receive('a', Uint8Array.of(7), T0 + 5))).toEqual([{ to: 'h', data: [1, 7] }]);
    expect(join(again, 'b', 'guest').conn.slot).toBe(2);
  });
});

describe('relay helpers', () => {
  it('limits events per key in a sliding minute', () => {
    const limiter = new RateLimiter(3);
    for (let i = 0; i < 3; i++) expect(limiter.allow('203.0.113.7', T0 + i)).toBe(true);
    expect(limiter.allow('203.0.113.7', T0 + 10)).toBe(false);
    expect(limiter.allow('198.51.100.1', T0 + 10)).toBe(true);
    expect(limiter.allow('203.0.113.7', T0 + 60_000)).toBe(true);
    const small = new RateLimiter(1, 60_000, 2);
    small.allow('a', T0);
    small.allow('b', T0);
    small.allow('c', T0);
    // The oldest address was forgotten to stay within two.
    expect(small.allow('a', T0)).toBe(true);
    small.prune(T0 + 60_000);
    expect(small.allow('b', T0 + 60_000)).toBe(true);
  });

  it('reads join requests, paths and bearer tokens', () => {
    expect(parseJoin(new URLSearchParams(`role=host&token=${token}`))).toEqual({ role: 'host', token });
    expect(parseJoin(new URLSearchParams('role=host&token=short'))).toEqual({ role: 'host', token: null });
    expect(parseJoin(new URLSearchParams(`role=guest&token=${token}`))).toEqual({ role: 'guest', token: null });
    expect(parseJoin(new URLSearchParams('role=admin'))).toBeNull();
    expect(roomPath('/v1/rooms')).toBe('');
    expect(roomPath('/v1/rooms/abc')).toBe('abc');
    expect(roomPath('/v1/rooms/abc/')).toBe('abc');
    expect(roomPath('/v1/rooms/abc/def')).toBeNull();
    expect(roomPath('/v2/rooms')).toBeNull();
    expect(bearer(`Bearer ${token}`)).toBe(token);
    expect(bearer('Bearer nope')).toBeNull();
    expect(bearer(undefined)).toBeNull();
  });

  it('spells bytes in base64url one way only, and compares tokens', async () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
    expect(toBase64Url(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    expect(fromBase64Url('a')).toBeNull();
    expect(fromBase64Url('ab+c')).toBeNull();
    expect(fromBase64Url('AB')).toBeNull();
    expect(newRoomId()).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await hashToken('x')).toBe('2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881');
    expect(sameText('abc', 'abc')).toBe(true);
    expect(sameText('abc', 'abd')).toBe(false);
    expect(sameText('abc', 'ab')).toBe(false);
  });
});
