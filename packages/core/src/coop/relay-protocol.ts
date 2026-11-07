/**
 * The co-op relay's room protocol, and a pure state machine for one room. The Cloudflare Worker (deploy/coop, a
 * Durable Object per room) and the Node relay (relay-node.ts) both drive `Room`; this file uses no Node or Workers API
 * beyond Web Crypto, so the Worker bundles it as it is.
 *
 * What the relay is for: a co-op session lives on the host's computer, and the guests' Atelier backends reach it
 * through here because everyone is usually behind NAT. The relay forwards opaque bytes. Each guest runs its own Noise
 * handshake with the host inside those bytes (noise.ts, channel.ts), so the relay can't read or change anything; it
 * can only drop or delay frames, or close connections, which the ends notice.
 *
 * HTTP (all paths under the relay's base, e.g. `https://coop.atelierhq.dev` or `<server>/api/coop`):
 * - `POST /v1/rooms` → 201 `{ roomId, hostToken }`. `roomId` is 16 random bytes and `hostToken` 32, both base64url.
 * - `GET /v1/rooms/<roomId>?role=host` with `Authorization: Bearer <hostToken>`, or `?role=guest`, as a WebSocket
 *   upgrade. The token never goes in the URL (logs keep URLs): a `token` parameter is refused. Refusals come before
 *   the upgrade as HTTP statuses: 400 (bad request), 403 (missing or wrong host token), 404 (no such room, or it
 *   closed), 409 (full: 4 participants including the host), 426 (not an upgrade), 429 (too many attempts from this
 *   address).
 * - `DELETE /v1/rooms/<roomId>` with `Authorization: Bearer <hostToken>` → 204, and every socket closes with 4004.
 *
 * Frames on a room's WebSocket:
 * - Binary, guest ↔ relay: one Noise message, as it is (at most 65,535 bytes).
 * - Binary, host ↔ relay: one byte naming the guest's slot, then that guest's message (at most 65,536 bytes). From a
 *   guest the relay prepends its slot (`{from: slot}`); from the host it reads the slot, strips it and sends the rest
 *   to that guest (`{to: slot}`). Frames for a slot that just left are dropped, as are guests' frames while no host
 *   is connected.
 * - Text, relay → host: `{"t":"welcome","role":"host","room","slots":[…],"limits"}` first (the guests connected
 *   now), then `{"t":"joined","slot"}` and `{"t":"left","slot"}`.
 * - Text, relay → guest: `{"t":"welcome","role":"guest","room","slot","host":bool,"limits"}` first, then
 *   `{"t":"host","present":bool}` whenever the host connects or goes.
 * - Text, host → relay: `{"t":"kick","slot","code"?}` closes that guest with `code` (4010–4019, default 4010).
 * - Text `ping` from anyone gets `pong` (the Worker answers without waking the room). Clients ping every
 *   `limits.pingMs`; a connection silent for `idleMs` is closed (4002), so a vanished guest frees its slot.
 *
 * Slots are 1–255 and are not reused until the counter wraps, so a frame meant for a guest who left can't reach the
 * next one. A newer host connection with the token replaces the older one (4000). Close codes are in `CloseCode`.
 *
 * Limits (`DEFAULT_LIMITS`): 4 participants; per room, a token bucket of 4 MiB/s with 16 MiB of burst over all data
 * frames (frames beyond it wait in order, up to 16 MiB, and the Node relay stops reading the sender meanwhile; past
 * that the sender is closed with 4008); join attempts and room creations per address per minute. A room closes an
 * hour after it was made when its host never connected, 24 hours after the host was last connected once it has, and
 * whenever the host deletes it.
 *
 * Nothing here looks inside data frames, and nothing may log them: drivers log ids, slots, sizes and codes only.
 */

export const COOP_PROTOCOL_VERSION = 1;

/** A room id: 16 random bytes, base64url. */
export const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** A host token: 32 random bytes, base64url. */
export const HOST_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** A guest's frame is one Noise message. */
export const MAX_GUEST_FRAME = 65_535;
/** The host's frames carry the slot in front: 64 KiB. */
export const MAX_HOST_FRAME = 65_536;
/** Control text frames are small. */
export const MAX_TEXT_FRAME = 1024;
export const MAX_SLOT = 255;

const MiB = 1024 * 1024;

export interface RelayLimits {
  /** People in a room, the host included. */
  participants: number;
  /** The room's data rate over all frames, both ways, sustained… */
  bytesPerSecond: number;
  /** …and the burst above it. At least one host frame. */
  burstBytes: number;
  /** Frames waiting for the rate before the sender is closed. */
  heldBytes: number;
  /** Join attempts (host or guest) per address per minute. */
  joinsPerMinute: number;
  /** Rooms made per address per minute. */
  createsPerMinute: number;
  /** A room closes this long after its host was last connected… */
  roomTtlMs: number;
  /** …or this long after it was made, when its host never connected. */
  unclaimedTtlMs: number;
  /** Clients ping this often… */
  pingMs: number;
  /** …and a connection that sent nothing for this long is closed. */
  idleMs: number;
}

export const DEFAULT_LIMITS: RelayLimits = {
  participants: 4,
  bytesPerSecond: 4 * MiB,
  burstBytes: 16 * MiB,
  heldBytes: 16 * MiB,
  joinsPerMinute: 30,
  createsPerMinute: 10,
  roomTtlMs: 24 * 60 * 60 * 1000,
  unclaimedTtlMs: 60 * 60 * 1000,
  pingMs: 20_000,
  idleMs: 60_000,
};

/** What clients are told in `welcome`, so they pace themselves under the room's rate. */
export interface WireLimits {
  maxFrame: number;
  bytesPerSecond: number;
  burstBytes: number;
  pingMs: number;
}

export const CloseCode = {
  normal: 1000,
  goingAway: 1001,
  tooBig: 1009,
  /** A newer host connection took over. */
  replaced: 4000,
  /** A frame the relay can't use. */
  protocol: 4001,
  /** Nothing arrived for `idleMs`. */
  idle: 4002,
  /** The host deleted the room, or it expired. */
  roomClosed: 4004,
  /** More data than the room's rate, for longer than it holds. */
  overRate: 4008,
  /** The host removed this guest (`kick`). */
  removed: 4010,
  /** The host refused this guest's handshake: a wrong or old invite. */
  refused: 4011,
} as const;

/** Codes a host may close a guest with. */
export const isKickCode = (code: number) => Number.isInteger(code) && code >= 4010 && code <= 4019;

export type Role = 'host' | 'guest';

export type RelayToHost = { t: 'welcome'; role: 'host'; room: string; slots: number[]; limits: WireLimits } | { t: 'joined'; slot: number } | { t: 'left'; slot: number };
export type RelayToGuest = { t: 'welcome'; role: 'guest'; room: string; slot: number; host: boolean; limits: WireLimits } | { t: 'host'; present: boolean };
export type HostToRelay = { t: 'kick'; slot: number; code?: number };

export const PING = 'ping';
export const PONG = 'pong';

/** One connection, as a driver keeps it (the Worker in the socket's attachment, so it outlives hibernation). */
export interface ConnInfo {
  id: string;
  role: Role;
  /** 0 for the host. */
  slot: number;
  ip: string;
  openedAt: number;
}

/** What a room keeps between connections (the Worker's storage). */
export interface RoomRecord {
  v: 1;
  room: string;
  tokenHash: string;
  createdAt: number;
  /** When the host was last connected; null until it first is. */
  hostSeenAt: number | null;
  /** The next slot to try. */
  nextSlot: number;
}

/** What the driver does for the room, in order. */
export type RoomAction =
  /** `from` is the sender, so a driver can slow it down when `to` reads slowly. */
  | { type: 'send'; from: string; to: string; data: Uint8Array }
  | { type: 'text'; to: string; text: string }
  | { type: 'close'; to: string; code: number; reason: string }
  /** Stop reading from this connection until `resume` (a driver that can't simply ignores both). */
  | { type: 'pause'; conn: string }
  | { type: 'resume'; conn: string }
  /** The room is over: forget it and its storage. */
  | { type: 'closed' };

export type JoinResult = { ok: true; conn: ConnInfo; actions: RoomAction[] } | { ok: false; status: number; reason: string };

// ---------------------------------------------------------------------------------------------------------------
// Ids, tokens and limits

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  // One spelling per value: the unused low bits of the last character must be zero.
  return toBase64Url(bytes) === text ? bytes : null;
}

const randomBytes = (length: number) => crypto.getRandomValues(new Uint8Array(length));

export const newRoomId = () => toBase64Url(randomBytes(16));
export const newHostToken = () => toBase64Url(randomBytes(32));
export const isRoomId = (value: unknown): value is string => typeof value === 'string' && ROOM_ID_PATTERN.test(value);

/** SHA-256 of a host token, hex: rooms keep only this. */
export async function hashToken(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compares without stopping at the first difference. */
export function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** At most `limit` events per key in any `windowMs`, for join attempts and room creations per address. */
export class RateLimiter {
  #hits = new Map<string, number[]>();
  #limit: number;
  #windowMs: number;
  #maxKeys: number;

  constructor(limit: number, windowMs = 60_000, maxKeys = 50_000) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#maxKeys = maxKeys;
  }

  /** Counts one event and says whether it is allowed. */
  allow(key: string, now: number): boolean {
    const recent = (this.#hits.get(key) ?? []).filter((at) => at > now - this.#windowMs);
    if (recent.length >= this.#limit) {
      this.#hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.#hits.delete(key);
    this.#hits.set(key, recent);
    // The oldest keys go first when too many addresses are tracked.
    while (this.#hits.size > this.#maxKeys) this.#hits.delete(this.#hits.keys().next().value!);
    return true;
  }

  /** Forgets keys with nothing in the window. */
  prune(now: number): void {
    for (const [key, hits] of this.#hits) if (!hits.some((at) => at > now - this.#windowMs)) this.#hits.delete(key);
  }
}

/** `rate` bytes per second, up to `capacity` saved up. */
export class TokenBucket {
  #tokens: number;
  #at: number;
  readonly rate: number;
  readonly capacity: number;

  constructor(rate: number, capacity: number, now: number) {
    this.rate = rate;
    this.capacity = capacity;
    this.#tokens = capacity;
    this.#at = now;
  }

  #refill(now: number): void {
    if (now > this.#at) this.#tokens = Math.min(this.capacity, this.#tokens + ((now - this.#at) * this.rate) / 1000);
    this.#at = Math.max(this.#at, now);
  }

  take(bytes: number, now: number): boolean {
    this.#refill(now);
    if (this.#tokens < bytes) return false;
    this.#tokens -= bytes;
    return true;
  }

  /** When `bytes` will be available. */
  readyAt(bytes: number, now: number): number {
    this.#refill(now);
    return this.#tokens >= bytes ? now : now + Math.ceil(((bytes - this.#tokens) * 1000) / this.rate);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// One room

interface Conn extends ConnInfo {
  seenAt: number;
}

interface Held {
  from: string;
  data: Uint8Array;
}

export interface JoinRequest {
  id: string;
  role: Role;
  /** `hashToken` of the token the host gave; ignored for guests. */
  tokenHash?: string | null;
  ip: string;
}

/**
 * A room's connections and what happens between them. Methods take the time and return actions; nothing here
 * touches a socket or a clock, so the Worker can rebuild a room after hibernation (`restore`) and tests can run a
 * day in a moment.
 */
export class Room {
  #record: RoomRecord;
  #limits: RelayLimits;
  #conns = new Map<string, Conn>();
  #host: Conn | null = null;
  #bucket: TokenBucket;
  #held: Held[] = [];
  #heldBytes = 0;
  #paused = new Set<string>();
  #closed = false;

  private constructor(record: RoomRecord, limits: Partial<RelayLimits> | undefined, now: number) {
    this.#record = { ...record };
    this.#limits = { ...DEFAULT_LIMITS, ...limits };
    this.#limits.burstBytes = Math.max(this.#limits.burstBytes, MAX_HOST_FRAME);
    this.#bucket = new TokenBucket(this.#limits.bytesPerSecond, this.#limits.burstBytes, now);
  }

  static create(room: string, tokenHash: string, now: number, limits?: Partial<RelayLimits>): Room {
    return new Room({ v: 1, room, tokenHash, createdAt: now, hostSeenAt: null, nextSlot: 1 }, limits, now);
  }

  /** The room as it was, with the connections still open (the Worker after hibernation). */
  static restore(record: RoomRecord, conns: ConnInfo[], now: number, limits?: Partial<RelayLimits>): Room {
    const room = new Room(record, limits, now);
    for (const info of [...conns].sort((a, b) => a.openedAt - b.openedAt)) {
      // Pings the Worker answers itself don't count here: it reports them with `touch`.
      const conn: Conn = { ...info, seenAt: info.openedAt };
      room.#conns.set(conn.id, conn);
      if (conn.role === 'host') room.#host = conn;
    }
    return room;
  }

  get record(): RoomRecord {
    return { ...this.#record };
  }

  get id(): string {
    return this.#record.room;
  }

  get limits(): RelayLimits {
    return { ...this.#limits };
  }

  get hostConnected(): boolean {
    return this.#host !== null;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** The guests' slots, in order. */
  get slots(): number[] {
    return [...this.#conns.values()].filter((c) => c.role === 'guest').map((c) => c.slot);
  }

  get connections(): ConnInfo[] {
    return [...this.#conns.values()].map(({ seenAt: _seenAt, ...info }) => info);
  }

  /** When the room closes by itself: never while the host is connected; soon when it never was. */
  expiresAt(): number {
    if (this.#host) return Infinity;
    const seen = this.#record.hostSeenAt;
    return seen === null ? this.#record.createdAt + this.#limits.unclaimedTtlMs : seen + this.#limits.roomTtlMs;
  }

  checkToken(tokenHash: string | null | undefined): boolean {
    return typeof tokenHash === 'string' && sameText(tokenHash, this.#record.tokenHash);
  }

  #wireLimits(): WireLimits {
    return { maxFrame: MAX_HOST_FRAME, bytesPerSecond: this.#limits.bytesPerSecond, burstBytes: this.#limits.burstBytes, pingMs: this.#limits.pingMs };
  }

  #text(to: string, message: RelayToHost | RelayToGuest): RoomAction {
    return { type: 'text', to, text: JSON.stringify(message) };
  }

  #guests(): Conn[] {
    return [...this.#conns.values()].filter((c) => c.role === 'guest');
  }

  #nextSlot(): number | null {
    const used = new Set(this.slots);
    for (let i = 0, slot = this.#record.nextSlot; i < MAX_SLOT; i++, slot = (slot % MAX_SLOT) + 1) {
      if (!used.has(slot)) {
        this.#record.nextSlot = (slot % MAX_SLOT) + 1;
        return slot;
      }
    }
    return null;
  }

  /**
   * Lets a connection in, or says why not. On `ok` the driver completes the upgrade at once and then runs the
   * actions (the welcome first); if the upgrade fails after all, it calls `disconnect`.
   */
  join(request: JoinRequest, now: number): JoinResult {
    if (this.#closed || now >= this.expiresAt()) return { ok: false, status: 404, reason: 'This room is closed.' };
    if (request.role === 'host') {
      if (!this.checkToken(request.tokenHash)) return { ok: false, status: 403, reason: "That isn't this room's host token." };
      const actions: RoomAction[] = [];
      const old = this.#host;
      if (old) {
        this.#remove(old.id);
        actions.push({ type: 'close', to: old.id, code: CloseCode.replaced, reason: 'Another host connection took over.' });
      }
      const conn: Conn = { id: request.id, role: 'host', slot: 0, ip: request.ip, openedAt: now, seenAt: now };
      this.#conns.set(conn.id, conn);
      this.#host = conn;
      // The room is claimed: from now on it lasts a day after the host was last here.
      this.#record.hostSeenAt = now;
      actions.push(this.#text(conn.id, { t: 'welcome', role: 'host', room: this.id, slots: this.slots, limits: this.#wireLimits() }));
      if (!old) for (const guest of this.#guests()) actions.push(this.#text(guest.id, { t: 'host', present: true }));
      return { ok: true, conn: this.#info(conn), actions };
    }
    if (this.#guests().length >= this.#limits.participants - 1) return { ok: false, status: 409, reason: 'This room is full.' };
    const slot = this.#nextSlot();
    if (slot === null) return { ok: false, status: 409, reason: 'This room is full.' };
    const conn: Conn = { id: request.id, role: 'guest', slot, ip: request.ip, openedAt: now, seenAt: now };
    this.#conns.set(conn.id, conn);
    const actions: RoomAction[] = [this.#text(conn.id, { t: 'welcome', role: 'guest', room: this.id, slot, host: this.hostConnected, limits: this.#wireLimits() })];
    if (this.#host) actions.push(this.#text(this.#host.id, { t: 'joined', slot }));
    return { ok: true, conn: this.#info(conn), actions };
  }

  #info({ seenAt: _seenAt, ...info }: Conn): ConnInfo {
    return info;
  }

  /** Drops the connection and what it had waiting. */
  #remove(id: string): Conn | null {
    const conn = this.#conns.get(id);
    if (!conn) return null;
    this.#conns.delete(id);
    if (this.#host === conn) this.#host = null;
    this.#paused.delete(id);
    if (this.#held.some((h) => h.from === id)) {
      this.#held = this.#held.filter((h) => h.from !== id);
      this.#heldBytes = this.#held.reduce((sum, h) => sum + h.data.length, 0);
    }
    return conn;
  }

  /** A connection ended (closed by either side, or failed). Unknown ids are ignored: the room may have closed it. */
  disconnect(id: string, now: number): RoomAction[] {
    const conn = this.#remove(id);
    if (!conn) return [];
    if (conn.role === 'host') {
      this.#record.hostSeenAt = now;
      return this.#guests().map((guest) => this.#text(guest.id, { t: 'host', present: false }));
    }
    return this.#host ? [this.#text(this.#host.id, { t: 'left', slot: conn.slot })] : [];
  }

  /** Something arrived from a connection (a text frame as a string). */
  receive(id: string, data: Uint8Array | string, now: number): RoomAction[] {
    const conn = this.#conns.get(id);
    if (!conn) return [];
    conn.seenAt = now;
    if (typeof data === 'string') return this.#control(conn, data, now);
    const max = conn.role === 'host' ? MAX_HOST_FRAME : MAX_GUEST_FRAME;
    if (data.length > max) return this.#kill(conn, CloseCode.tooBig, `Frames can be at most ${max} bytes.`, now);
    if (data.length < (conn.role === 'host' ? 2 : 1)) return this.#kill(conn, CloseCode.protocol, 'An empty frame.', now);
    if (this.#held.length || !this.#bucket.take(data.length, now)) return this.#hold(conn, data, now);
    return this.#route(conn, data);
  }

  #control(conn: Conn, text: string, now: number): RoomAction[] {
    if (text === PING) return [{ type: 'text', to: conn.id, text: PONG }];
    if (text.length > MAX_TEXT_FRAME) return this.#kill(conn, CloseCode.protocol, 'That control frame is too long.', now);
    if (conn.role !== 'host') return [];
    let message: Partial<HostToRelay>;
    try {
      message = JSON.parse(text) as Partial<HostToRelay>;
    } catch {
      return this.#kill(conn, CloseCode.protocol, "That control frame isn't JSON.", now);
    }
    // Messages this relay doesn't know are ignored: a newer client may send them.
    if (message?.t !== 'kick' || typeof message.slot !== 'number') return [];
    const guest = this.#guests().find((g) => g.slot === message.slot);
    if (!guest) return [];
    const code = message.code !== undefined && isKickCode(message.code) ? message.code : CloseCode.removed;
    this.#remove(guest.id);
    return [
      { type: 'close', to: guest.id, code, reason: code === CloseCode.refused ? 'The host refused the handshake.' : 'The host removed you from the room.' },
      this.#text(conn.id, { t: 'left', slot: guest.slot }),
    ];
  }

  /** Closes a connection the room gave up on, and tells the others. */
  #kill(conn: Conn, code: number, reason: string, now: number): RoomAction[] {
    return [{ type: 'close', to: conn.id, code, reason }, ...this.disconnect(conn.id, now)];
  }

  #route(conn: Conn, data: Uint8Array): RoomAction[] {
    if (conn.role === 'guest') {
      if (!this.#host) return [];
      const framed = new Uint8Array(data.length + 1);
      framed[0] = conn.slot;
      framed.set(data, 1);
      return [{ type: 'send', from: conn.id, to: this.#host.id, data: framed }];
    }
    const guest = this.#guests().find((g) => g.slot === data[0]);
    return guest ? [{ type: 'send', from: conn.id, to: guest.id, data: data.subarray(1) }] : [];
  }

  #hold(conn: Conn, data: Uint8Array, now: number): RoomAction[] {
    if (this.#heldBytes + data.length > this.#limits.heldBytes) return this.#kill(conn, CloseCode.overRate, 'More data than the room allows.', now);
    // The driver may hand over a view into a buffer it reuses.
    this.#held.push({ from: conn.id, data: new Uint8Array(data) });
    this.#heldBytes += data.length;
    if (this.#paused.has(conn.id)) return [];
    this.#paused.add(conn.id);
    return [{ type: 'pause', conn: conn.id }];
  }

  /** When held frames can go on: the driver calls `tick` then. */
  heldUntil(now: number): number | null {
    const next = this.#held[0];
    return next ? this.#bucket.readyAt(next.data.length, now) : null;
  }

  /** The Worker's ping answers don't reach the room: it reports when it last saw each connection. */
  touch(id: string, at: number): void {
    const conn = this.#conns.get(id);
    if (conn && at > conn.seenAt) conn.seenAt = at;
  }

  /** The next time something is due without a frame arriving: an idle connection, or the room's expiry. */
  nextDeadline(): number {
    let next = this.expiresAt();
    for (const conn of this.#conns.values()) next = Math.min(next, conn.seenAt + this.#limits.idleMs);
    return next;
  }

  /** Lets held frames through, closes idle connections and closes the room when it expired. */
  tick(now: number): RoomAction[] {
    if (this.#closed) return [];
    if (now >= this.expiresAt()) return this.#close('This room expired.');
    const actions: RoomAction[] = [];
    while (this.#held.length && this.#bucket.take(this.#held[0]!.data.length, now)) {
      const { from, data } = this.#held.shift()!;
      this.#heldBytes -= data.length;
      const conn = this.#conns.get(from);
      if (conn) actions.push(...this.#route(conn, data));
    }
    if (!this.#held.length) {
      for (const id of this.#paused) actions.push({ type: 'resume', conn: id });
      this.#paused.clear();
    }
    for (const conn of [...this.#conns.values()]) {
      if (now - conn.seenAt >= this.#limits.idleMs) actions.push(...this.#kill(conn, CloseCode.idle, 'Nothing arrived for too long.', now));
    }
    return actions;
  }

  /** The host deleted the room. */
  remove(): RoomAction[] {
    return this.#close('The host closed this room.');
  }

  #close(reason: string): RoomAction[] {
    this.#closed = true;
    const actions: RoomAction[] = [...this.#conns.values()].map((conn) => ({ type: 'close', to: conn.id, code: CloseCode.roomClosed, reason }));
    this.#conns.clear();
    this.#host = null;
    this.#held = [];
    this.#heldBytes = 0;
    this.#paused.clear();
    actions.push({ type: 'closed' });
    return actions;
  }
}

/**
 * Reads a join: `?role=guest`, or `?role=host` with the token from `Authorization: Bearer <hostToken>` (null when it is
 * missing or malformed, which the room refuses with 403). Null for anything else, a `token` in the URL included: it
 * would end up in logs.
 */
export function parseJoin(search: URLSearchParams, authorization: string | null | undefined): { role: Role; token: string | null } | null {
  const role = search.get('role');
  if ((role !== 'host' && role !== 'guest') || search.has('token')) return null;
  return { role, token: role === 'host' ? bearer(authorization) : null };
}

/** The room id in `/v1/rooms/<id>` (after the relay's base path), or `''` for `/v1/rooms`; null for other paths. */
export function roomPath(pathname: string): string | null {
  const match = /^\/v1\/rooms(?:\/([^/]*))?\/?$/.exec(pathname);
  if (!match) return null;
  return match[1] ?? '';
}

/** The host token in an `Authorization` header (a host's upgrade, a `DELETE`). */
export function bearer(header: string | null | undefined): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return match && HOST_TOKEN_PATTERN.test(match[1]!) ? match[1]! : null;
}
