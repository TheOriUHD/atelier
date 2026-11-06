/**
 * Co-op's client side, for Atelier backends: the host's room and a guest's channel to it, through the relay
 * (relay-protocol.ts). Every guest runs its own Noise_XXpsk3 handshake with the host (noise.ts) inside the relay's
 * frames; after it, JSON messages travel encrypted, compressed when large, and split into chunks.
 *
 * Inside the relay's data frames (the relay adds or strips the slot byte on the host's side):
 *
 *   [1][attempt: u32 LE][Noise message 1]   guest → host   (empty payload)
 *   [2][attempt: u32 LE][Noise message 2]   host → guest   (empty payload)
 *   [3][attempt: u32 LE][Noise message 3]   guest → host   (payload: the guest's hello, JSON)
 *   [4][nonce: u64 LE][Noise transport message]   both ways
 *   [5]                                     host → guest: "I have no session with you, start a handshake again"
 *
 * The attempt number lets each side drop an answer to a handshake the guest already gave up on (it timed out, or the
 * host asked for a new one), instead of failing the current one on it and starting yet another.
 *
 * A transport message's plaintext is `[0]` (the host's confirmation, sent first: it proves the host knows the
 * invite's key, so a guest is never "in" with an impostor that only completed the handshake) or a chunk:
 * `[1][flags: u8][message id: u32 LE][index: u32 LE][count: u32 LE][bytes]`, flags bit 0 = zlib. Chunks of a
 * message go in order and messages one after another, so a gap means a chunk was lost: that message is dropped.
 *
 * Every transport message carries its nonce, so a frame the relay drops (the host's link went down for a moment)
 * costs only the messages it was part of, not the session; nonces only go up, so nothing can be replayed. This is
 * what lets a host keep its guests through a relay reconnect: their sessions are still valid when it is back.
 *
 * What the app layer does on top: admit a joiner (or not) after showing `hello.name` and the fingerprint, pin the
 * other side's static key, and resubscribe after `relay-state` 'connected' (host) or `reconnected` (guest): messages
 * sent while the link was down are lost, not replayed.
 */
import { EventEmitter } from 'node:events';
import { deflate, inflate } from 'node:zlib';
import WebSocket from 'ws';
import { fingerprint as fingerprintOf } from './invite.ts';
import { generateKeyPair, HandshakeState, keyPairFromPrivate, NoiseError, TAG_LENGTH, type KeyPair, type TransportState } from './noise.ts';
import {
  CloseCode,
  DEFAULT_LIMITS,
  HOST_TOKEN_PATTERN,
  isRoomId,
  MAX_HOST_FRAME,
  PING,
  PONG,
  TokenBucket,
  type RelayToGuest,
  type RelayToHost,
  type WireLimits,
} from './relay-protocol.ts';

export const DEFAULT_COOP_RELAY = 'https://coop.atelierhq.dev';
/** The largest message `send` takes, as JSON (and as what it inflates to on the other side). */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
/** The guest's hello, as JSON. */
export const MAX_HELLO_BYTES = 4096;

const FRAME_HELLO1 = 1;
const FRAME_HELLO2 = 2;
const FRAME_HELLO3 = 3;
const FRAME_DATA = 4;
const FRAME_RESET = 5;
const PLAIN_CONFIRM = 0;
const PLAIN_CHUNK = 1;
const FLAG_ZLIB = 1;
const CHUNK_HEADER = 14;
const NONCE_BYTES = 8;
const ATTEMPT_BYTES = 4;
/** What one chunk holds so the host's frame (slot, type, nonce, header, tag) is at most 64 KiB. */
export const CHUNK_BYTES = MAX_HOST_FRAME - 1 - 1 - NONCE_BYTES - CHUNK_HEADER - TAG_LENGTH;
const MAX_CHUNKS = Math.ceil(MAX_MESSAGE_BYTES / CHUNK_BYTES);
/** Compress JSON from this size on, when it saves something. */
const COMPRESS_FROM = 8 * 1024;
/** Sends waiting for their turn on one channel; more is an app that doesn't wait for `send`. */
const MAX_PENDING_SENDS = 1024;
/** Messages kept for a channel nobody listens to yet (a host still deciding whether to let someone in). */
const MAX_EARLY_MESSAGES = 64;
const MAX_EARLY_BYTES = 8 * 1024 * 1024;
/** Stop writing while the socket has this much unsent, until it is down to the low mark. */
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;

// ---------------------------------------------------------------------------------------------------------------
// Errors, keys, timing

export type CoopErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'full'
  | 'rate_limited'
  | 'refused'
  | 'removed'
  | 'room_closed'
  | 'host_key_changed'
  | 'timeout'
  | 'offline'
  | 'closed'
  | 'too_large'
  | 'busy'
  | 'network'
  | 'protocol'
  | 'aborted';

export class CoopError extends Error {
  readonly code: CoopErrorCode;

  constructor(code: CoopErrorCode, message: string) {
    super(message);
    this.name = 'CoopError';
    this.code = code;
  }
}

const offline = () => new CoopError('offline', 'The co-op link is down; send again after it reconnects.');

/** Why a channel ended. */
export type CoopCloseReason =
  /** This side closed it. */
  | 'closed'
  /** (host) The guest disconnected from the relay. */
  | 'left'
  /** (host) The guest started over with a new handshake (on a slot it already had). */
  | 'rejoined'
  /** (guest) The host removed you (relay code 4010). */
  | 'removed'
  /** (guest) The host refused your handshake: a wrong or old invite (4011). */
  | 'refused'
  /** The host deleted the room, or it expired. */
  | 'room-closed'
  /** (guest) The host's device key isn't the one pinned. */
  | 'host-key-changed'
  /** (host) The relay link ended for good: another connection took the room over, or the token stopped working. */
  | 'relay-closed';

/** A device's long-term co-op key. */
export type StaticKey = KeyPair;

export const generateStaticKey = (): StaticKey => generateKeyPair();

/** The private key as base64 (32 bytes), for the app's secret store. */
export const serializeStaticKey = (key: StaticKey) => Buffer.from(key.privateKey).toString('base64');

export function parseStaticKey(text: string): StaticKey {
  return keyPairFromPrivate(decodeKey(text));
}

/** A public key (what each side pins) as base64. */
export const encodeKey = (publicKey: Uint8Array) => Buffer.from(publicKey).toString('base64');

export function decodeKey(text: string): Uint8Array {
  const bytes = /^[A-Za-z0-9+/]{43}=$/.test(text.trim()) ? Buffer.from(text.trim(), 'base64') : null;
  if (bytes?.length !== 32) throw new TypeError("That isn't a co-op key.");
  return new Uint8Array(bytes);
}

const sameKey = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

export interface CoopTiming {
  /** How long a connection to the relay may take. */
  connectMs: number;
  /** Ping the relay this often (the relay's `welcome` can ask for less)… */
  pingMs: number;
  /** …and give a link up after this long without any frame from it. */
  deadMs: number;
  /** One handshake step (the host's answer, its confirmation) may take this long. */
  handshakeMs: number;
  /** Wait before reconnect attempt `failures` (1, 2, …). */
  backoff: (failures: number) => number;
}

export const DEFAULT_TIMING: CoopTiming = {
  connectMs: 15_000,
  pingMs: DEFAULT_LIMITS.pingMs,
  deadMs: 50_000,
  handshakeMs: 20_000,
  backoff: (failures) => Math.min(10_000, 250 * 2 ** (failures - 1)) * (0.75 + Math.random() * 0.5),
};

const baseUrl = (relayUrl: string) => relayUrl.replace(/\/+$/, '');

function socketUrl(relayUrl: string, roomId: string, role: 'host' | 'guest', token?: string): string {
  const url = new URL(`${baseUrl(relayUrl)}/v1/rooms/${roomId}`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol;
  url.searchParams.set('role', role);
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

function statusError(status: number): CoopError {
  if (status === 404) return new CoopError('not_found', 'That co-op room is gone: the host closed it, or it expired.');
  if (status === 403) return new CoopError('forbidden', "The relay didn't accept this room's host token.");
  if (status === 409) return new CoopError('full', 'That co-op room is full.');
  if (status === 429) return new CoopError('rate_limited', 'Too many attempts; try again in a minute.');
  if (status === 400) return new CoopError('protocol', 'The relay refused the request.');
  return new CoopError('network', `The co-op relay answered ${status}.`);
}

/** Makes a room on the relay: the host keeps `hostToken` (it lets it in, and deletes the room). */
export async function createRoom(relayUrl: string, init: { signal?: AbortSignal } = {}): Promise<{ roomId: string; hostToken: string }> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl(relayUrl)}/v1/rooms`, { method: 'POST', signal: init.signal });
  } catch (error) {
    throw new CoopError(init.signal?.aborted ? 'aborted' : 'network', `The co-op relay can't be reached: ${(error as Error).message}`);
  }
  if (res.status !== 201) throw statusError(res.status);
  const body = (await res.json()) as { roomId?: unknown; hostToken?: unknown };
  if (!isRoomId(body.roomId) || typeof body.hostToken !== 'string' || !HOST_TOKEN_PATTERN.test(body.hostToken)) throw new CoopError('protocol', 'The co-op relay sent something unexpected.');
  return { roomId: body.roomId, hostToken: body.hostToken };
}

/** Closes a room for everyone. A room that is already gone counts as deleted. */
export async function deleteRoom(relayUrl: string, roomId: string, hostToken: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl(relayUrl)}/v1/rooms/${roomId}`, { method: 'DELETE', headers: { authorization: `Bearer ${hostToken}` } });
  } catch (error) {
    throw new CoopError('network', `The co-op relay can't be reached: ${(error as Error).message}`);
  }
  if (res.status !== 204 && res.status !== 404) throw statusError(res.status);
}

/** Bound into every handshake: both sides must be in the same room. */
const prologue = (roomId: string) => new TextEncoder().encode(`atelier coop v1\n${roomId}`);

// ---------------------------------------------------------------------------------------------------------------
// The link to the relay

/**
 * Called with the link itself: the relay's first frame can come in the same packet as the upgrade, and Node hands
 * it over before an `await` on `open` would resume, so the owner takes the link in `opened`, synchronously.
 */
interface LinkHandlers {
  opened(link: RelayLink): void;
  text(link: RelayLink, message: Record<string, unknown>): void;
  binary(link: RelayLink, data: Uint8Array): void;
  closed(link: RelayLink, code: number, reason: string): void;
}

const toBytes = (data: WebSocket.RawData) => {
  const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
};

function connectError(error: Error): CoopError {
  const status = /Unexpected server response: (\d+)/.exec(error.message);
  if (status) return statusError(Number(status[1]));
  return new CoopError('network', `The co-op relay can't be reached: ${error.message}`);
}

/** One WebSocket to the relay: pings, notices a dead link, paces itself under the room's rate, waits for drains. */
class RelayLink {
  readonly #ws: WebSocket;
  readonly #timing: CoopTiming;
  #bucket = new TokenBucket(DEFAULT_LIMITS.bytesPerSecond, DEFAULT_LIMITS.burstBytes / 2, Date.now());
  #waiters = new Set<() => void>();
  #ping: ReturnType<typeof setInterval> | null = null;
  #dead: ReturnType<typeof setTimeout> | null = null;
  #ended = false;
  #onEnded!: () => void;
  /** Settles when the link is down for good. */
  readonly ended = new Promise<void>((resolve) => (this.#onEnded = resolve));

  private constructor(ws: WebSocket, timing: CoopTiming) {
    this.#ws = ws;
    this.#timing = timing;
  }

  static open(url: string, timing: CoopTiming, handlers: LinkHandlers): Promise<RelayLink> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: MAX_HOST_FRAME, handshakeTimeout: timing.connectMs });
      const link = new RelayLink(ws, timing);
      let opened = false;
      let failure: CoopError | null = null;
      ws.on('open', () => {
        opened = true;
        link.#alive();
        link.#ping = setInterval(() => link.#ws.readyState === WebSocket.OPEN && link.#ws.send(PING), timing.pingMs);
        link.#ping.unref?.();
        handlers.opened(link);
        resolve(link);
      });
      ws.on('error', (error) => {
        if (!opened) failure ??= connectError(error);
      });
      ws.on('close', (code, reason) => {
        link.#end();
        if (opened) handlers.closed(link, code, reason.toString());
        else reject(failure ?? new CoopError('network', "The co-op relay can't be reached."));
      });
      ws.on('message', (data, isBinary) => {
        if (link.#ended) return;
        link.#alive();
        if (isBinary) return handlers.binary(link, toBytes(data));
        const text = toBytes(data);
        if (text.length === PONG.length && Buffer.from(text).toString() === PONG) return;
        let message: unknown;
        try {
          message = JSON.parse(Buffer.from(text).toString('utf8'));
        } catch {
          return;
        }
        if (message && typeof message === 'object') handlers.text(link, message as Record<string, unknown>);
      });
    });
  }

  get open(): boolean {
    return !this.#ended && this.#ws.readyState === WebSocket.OPEN;
  }

  /** The relay's limits from `welcome`: pace under its rate, ping as often as it asks. */
  setLimits(limits: Partial<WireLimits>): void {
    if (typeof limits.bytesPerSecond === 'number' && typeof limits.burstBytes === 'number' && limits.bytesPerSecond > 0) {
      this.#bucket = new TokenBucket(limits.bytesPerSecond, Math.max(MAX_HOST_FRAME, limits.burstBytes / 2), Date.now());
    }
    if (typeof limits.pingMs === 'number' && limits.pingMs >= 1000 && limits.pingMs < this.#timing.pingMs && this.#ping) {
      clearInterval(this.#ping);
      this.#ping = setInterval(() => this.#ws.readyState === WebSocket.OPEN && this.#ws.send(PING), limits.pingMs);
      this.#ping.unref?.();
    }
  }

  #alive(): void {
    if (this.#dead) clearTimeout(this.#dead);
    this.#dead = setTimeout(() => this.#ws.terminate(), this.#timing.deadMs);
    this.#dead.unref?.();
  }

  #end(): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#ping) clearInterval(this.#ping);
    if (this.#dead) clearTimeout(this.#dead);
    this.#wake();
    this.#onEnded();
  }

  #wake(): void {
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const wake of waiters) wake();
  }

  /** Waits until a frame of `bytes` may go: the socket has room, and the room's rate allows it. */
  async writable(bytes: number): Promise<void> {
    for (;;) {
      if (!this.open) throw offline();
      if (this.#ws.bufferedAmount > HIGH_WATER) {
        await new Promise<void>((resolve) => this.#waiters.add(resolve));
        continue;
      }
      const now = Date.now();
      if (this.#bucket.take(bytes, now)) return;
      const wait = this.#bucket.readyAt(bytes, now) - now;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.#waiters.delete(done);
          resolve();
        }, wait);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        this.#waiters.add(done);
      });
    }
  }

  /** Resolves once the frame is handed to the operating system. */
  send(data: Uint8Array | string): Promise<void> {
    if (!this.open) return Promise.reject(offline());
    return new Promise((resolve, reject) => {
      this.#ws.send(data, (error) => {
        if (this.#ws.bufferedAmount <= LOW_WATER) this.#wake();
        if (error) reject(offline());
        else resolve();
      });
    });
  }

  /** Fire and forget, for control frames and handshake messages. */
  post(data: Uint8Array | string): void {
    if (this.open) this.#ws.send(data);
  }

  close(code: number = CloseCode.normal, reason = ''): void {
    this.#end();
    if (this.#ws.readyState === WebSocket.OPEN || this.#ws.readyState === WebSocket.CONNECTING) this.#ws.close(code, reason);
  }

  /** Drops the connection without a goodbye (tests, a link that went quiet). */
  terminate(): void {
    this.#ws.terminate();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Messages: framing, encryption, chunks

function u64(view: DataView, at: number, n: number): void {
  view.setUint32(at, n % 2 ** 32, true);
  view.setUint32(at + 4, Math.floor(n / 2 ** 32), true);
}

function readU64(bytes: Uint8Array, at: number): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const high = view.getUint32(at + 4, true);
  return high >= 2 ** 21 ? null : high * 2 ** 32 + view.getUint32(at, true);
}

/** One direction's transport cipher and the next nonce it accepts. */
interface Session {
  cipher: TransportState;
  received: number;
}

/** `[prefix][4][nonce][ciphertext]`. */
function sealData(session: Session, prefix: number[], plaintext: Uint8Array): Uint8Array {
  const nonce = session.cipher.send.nonce;
  const sealed = session.cipher.send.encrypt(plaintext);
  const frame = new Uint8Array(prefix.length + 1 + NONCE_BYTES + sealed.length);
  frame.set(prefix);
  frame[prefix.length] = FRAME_DATA;
  u64(new DataView(frame.buffer), prefix.length + 1, nonce);
  frame.set(sealed, prefix.length + 1 + NONCE_BYTES);
  return frame;
}

/** The plaintext of a data frame's body (after the type byte), or null for one that isn't from the other side. */
function openData(session: Session, body: Uint8Array): Uint8Array | null {
  if (body.length < NONCE_BYTES + TAG_LENGTH) return null;
  const nonce = readU64(body, 0);
  // Only forward: a frame from before (a replay) or a nonce out of range is dropped.
  if (nonce === null || nonce < session.received) return null;
  try {
    session.cipher.receive.setNonce(nonce);
    const plaintext = session.cipher.receive.decrypt(body.subarray(NONCE_BYTES));
    session.received = nonce + 1;
    return plaintext;
  } catch (error) {
    if (error instanceof NoiseError) return null;
    throw error;
  }
}

function zlib(fn: typeof deflate | typeof inflate, data: Uint8Array, options: { maxOutputLength?: number } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => fn(data, options, (error, result) => (error ? reject(error) : resolve(result))));
}

async function encode(value: unknown): Promise<{ bytes: Uint8Array; compressed: boolean }> {
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError('Only JSON values can be sent.');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > MAX_MESSAGE_BYTES) throw new CoopError('too_large', `A co-op message can be at most ${MAX_MESSAGE_BYTES / 1024 / 1024} MiB as JSON.`);
  if (bytes.length >= COMPRESS_FROM) {
    const compressed = await zlib(deflate, bytes);
    if (compressed.length < bytes.length * 0.9) return { bytes: compressed, compressed: true };
  }
  return { bytes, compressed: false };
}

async function decode(bytes: Uint8Array, compressed: boolean): Promise<unknown> {
  const raw = compressed ? await zlib(inflate, bytes, { maxOutputLength: MAX_MESSAGE_BYTES }) : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return JSON.parse(raw.toString('utf8'));
}

/** Where a channel's frames go right now: null while the link is down or the session is being renewed. */
interface Route {
  link: RelayLink;
  session: Session;
  prefix: number[];
}

/** A channel's outgoing messages, one after the other, each written only when the link can take it. */
class Outbox {
  #queue: { value: unknown; resolve(): void; reject(error: unknown): void }[] = [];
  #running = false;
  #nextId = 1;
  readonly #route: () => Route | null;

  constructor(route: () => Route | null) {
    this.#route = route;
  }

  send(value: unknown): Promise<void> {
    if (this.#queue.length >= MAX_PENDING_SENDS) return Promise.reject(new CoopError('busy', 'Too many co-op messages are waiting; wait for earlier sends.'));
    return new Promise((resolve, reject) => {
      this.#queue.push({ value, resolve, reject });
      void this.#pump();
    });
  }

  /** Fails everything waiting (the channel closed). */
  fail(error: CoopError): void {
    for (const job of this.#queue.splice(0)) job.reject(error);
  }

  async #pump(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#queue.length) {
        const job = this.#queue[0]!;
        try {
          await this.#write(job.value);
          job.resolve();
        } catch (error) {
          job.reject(error);
        }
        if (this.#queue[0] === job) this.#queue.shift();
      }
    } finally {
      this.#running = false;
    }
  }

  async #write(value: unknown): Promise<void> {
    const route = this.#route();
    if (!route) throw offline();
    const { bytes, compressed } = await encode(value);
    const id = this.#nextId;
    this.#nextId = (this.#nextId % 0xffff_ffff) + 1;
    const count = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
    let last: Promise<void> = Promise.resolve();
    for (let index = 0; index < count; index++) {
      const chunk = bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
      const size = route.prefix.length + 1 + NONCE_BYTES + CHUNK_HEADER + chunk.length + TAG_LENGTH;
      await route.link.writable(size);
      // The link went down or the session was renewed meanwhile: the rest of this message can't arrive.
      const now = this.#route();
      if (now?.link !== route.link || now.session !== route.session) throw offline();
      const plain = new Uint8Array(CHUNK_HEADER + chunk.length);
      const view = new DataView(plain.buffer);
      plain[0] = PLAIN_CHUNK;
      plain[1] = compressed ? FLAG_ZLIB : 0;
      view.setUint32(2, id, true);
      view.setUint32(6, index, true);
      view.setUint32(10, count, true);
      plain.set(chunk, CHUNK_HEADER);
      last = route.link.send(sealData(route.session, route.prefix, plain));
      // Errors surface at the end; a failed earlier chunk fails the next writable() anyway.
      last.catch(() => {});
    }
    await last;
  }
}

/** A channel's incoming chunks, put back together and handed out in order. */
class Inbox {
  #partial: { id: number; count: number; next: number; compressed: boolean; parts: Uint8Array[]; bytes: number } | null = null;
  #delivery: Promise<void> = Promise.resolve();
  #listeners = new Set<(message: unknown) => void>();
  #early: { message: unknown; bytes: number }[] = [];
  #earlyBytes = 0;
  #closed = false;

  chunk(plain: Uint8Array): void {
    if (plain.length < CHUNK_HEADER || this.#closed) return;
    const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
    const compressed = (plain[1]! & FLAG_ZLIB) !== 0;
    const id = view.getUint32(2, true);
    const index = view.getUint32(6, true);
    const count = view.getUint32(10, true);
    if (count === 0 || count > MAX_CHUNKS || index >= count) return void (this.#partial = null);
    const data = plain.subarray(CHUNK_HEADER);
    if (index === 0) this.#partial = { id, count, next: 0, compressed, parts: [], bytes: 0 };
    const partial = this.#partial;
    // A chunk went missing: this message can't be completed.
    if (!partial || partial.id !== id || partial.count !== count || partial.next !== index) return void (this.#partial = null);
    partial.parts.push(data);
    partial.bytes += data.length;
    partial.next++;
    if (partial.bytes > MAX_MESSAGE_BYTES) return void (this.#partial = null);
    if (partial.next < count) return;
    this.#partial = null;
    const bytes = Buffer.concat(partial.parts);
    this.#delivery = this.#delivery.then(async () => {
      let message: unknown;
      try {
        message = await decode(bytes, partial.compressed);
      } catch {
        return;
      }
      this.#deliver(message, bytes.length);
    });
  }

  #deliver(message: unknown, bytes: number): void {
    if (this.#closed) return;
    if (!this.#listeners.size) {
      // Kept for the first listener, within limits: past them a message is dropped.
      if (this.#early.length < MAX_EARLY_MESSAGES && this.#earlyBytes + bytes <= MAX_EARLY_BYTES) {
        this.#early.push({ message, bytes });
        this.#earlyBytes += bytes;
      }
      return;
    }
    for (const listener of [...this.#listeners]) {
      try {
        listener(message);
      } catch {
        // One listener's failure doesn't keep the message from the others, or break the channel.
      }
    }
  }

  listen(listener: (message: unknown) => void): () => void {
    this.#listeners.add(listener);
    if (this.#early.length) {
      const early = this.#early.splice(0);
      this.#earlyBytes = 0;
      queueMicrotask(() => {
        for (const { message } of early) {
          try {
            listener(message);
          } catch {
            // As above.
          }
        }
      });
    }
    return () => this.#listeners.delete(listener);
  }

  /** A gap in the stream: the message being put together is gone. */
  reset(): void {
    this.#partial = null;
  }

  close(): void {
    this.#closed = true;
    this.#partial = null;
    this.#early = [];
    this.#listeners.clear();
  }
}


/** `[prefix][type][attempt][Noise handshake message]`. */
function handshakeFrame(prefix: number[], type: number, attempt: number, message: Uint8Array): Uint8Array {
  const frame = new Uint8Array(prefix.length + 1 + ATTEMPT_BYTES + message.length);
  frame.set(prefix);
  frame[prefix.length] = type;
  new DataView(frame.buffer).setUint32(prefix.length + 1, attempt, true);
  frame.set(message, prefix.length + 1 + ATTEMPT_BYTES);
  return frame;
}

/** A handshake frame's body (after the type byte): its attempt and message. */
function readHandshake(body: Uint8Array): { attempt: number; message: Uint8Array } | null {
  if (body.length < ATTEMPT_BYTES) return null;
  return { attempt: new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0, true), message: body.subarray(ATTEMPT_BYTES) };
}

// ---------------------------------------------------------------------------------------------------------------
// The host

/** What a guest says about itself in the handshake (encrypted, after the pre-shared key is proven). */
export interface CoopHello {
  name: string;
  version: string;
  [key: string]: unknown;
}

function readHello(payload: Uint8Array): CoopHello | null {
  if (payload.length > MAX_HELLO_BYTES) return null;
  try {
    const hello = JSON.parse(Buffer.from(payload).toString('utf8')) as Partial<CoopHello> | null;
    if (!hello || typeof hello !== 'object' || Array.isArray(hello)) return null;
    if (typeof hello.name !== 'string' || !hello.name.trim() || hello.name.length > 100) return null;
    if (typeof hello.version !== 'string' || hello.version.length > 50) return null;
    return hello as CoopHello;
  } catch {
    return null;
  }
}

/** One guest, from the host's side. */
export interface PeerChannel {
  /** The relay's number for this guest's connection. */
  readonly slot: number;
  /** The guest's device key: what the host pins. */
  readonly remoteStatic: Uint8Array;
  /** `remoteStatic` as base64. */
  readonly remoteKey: string;
  /** The three emoji to compare with the guest. */
  readonly fingerprint: [string, string, string];
  readonly handshakeHash: Uint8Array;
  readonly hello: CoopHello;
  /** Whether `remoteStatic` is one of `knownPeers`. */
  readonly known: boolean;
  /** False once the channel ended; sends also fail while the host's relay link is down. */
  readonly open: boolean;
  /** Resolves when the whole message was handed to the socket; rejects while the link is down. */
  send(message: unknown): Promise<void>;
  /** Messages that arrived before the first listener are given to it. Returns an unsubscribe. */
  onMessage(listener: (message: unknown) => void): () => void;
  onClose(listener: (reason: CoopCloseReason) => void): () => void;
  /** Removes the guest from the room (relay code 4010). */
  close(): void;
}

export type RelayState = 'connected' | 'reconnecting' | 'closed';

export interface HostRoomOptions {
  relayUrl: string;
  roomId: string;
  hostToken: string;
  /** From the invite's secret (`pskFromSecret`). */
  psk: Uint8Array;
  staticKey: StaticKey;
  /** Guests already pinned (keys or base64), or a check: `peer.known` says whether a guest is one of them. */
  knownPeers?: readonly (Uint8Array | string)[] | ((remoteStatic: Uint8Array) => boolean);
  timing?: Partial<CoopTiming>;
}

type HostRoomEvents = {
  peer: [peer: PeerChannel];
  'peer-left': [peer: PeerChannel, reason: CoopCloseReason];
  'relay-state': [state: RelayState];
};

class Peer implements PeerChannel {
  readonly slot: number;
  readonly remoteStatic: Uint8Array;
  readonly remoteKey: string;
  readonly fingerprint: [string, string, string];
  readonly handshakeHash: Uint8Array;
  readonly hello: CoopHello;
  readonly known: boolean;
  readonly #session: Session;
  readonly #inbox = new Inbox();
  readonly #outbox: Outbox;
  readonly #kick: (slot: number) => void;
  #closeListeners = new Set<(reason: CoopCloseReason) => void>();
  #ended = false;

  constructor(link: () => RelayLink | null, kick: (slot: number) => void, slot: number, handshake: HandshakeState, hello: CoopHello, known: boolean) {
    this.#kick = kick;
    this.slot = slot;
    this.remoteStatic = handshake.remoteStatic!;
    this.remoteKey = encodeKey(this.remoteStatic);
    this.handshakeHash = handshake.handshakeHash;
    this.fingerprint = fingerprintOf(this.handshakeHash);
    this.hello = hello;
    this.known = known;
    this.#session = { cipher: handshake.split(), received: 0 };
    this.#outbox = new Outbox(() => {
      const current = link();
      return current?.open && !this.#ended ? { link: current, session: this.#session, prefix: [this.slot] } : null;
    });
  }

  get open(): boolean {
    return !this.#ended;
  }

  /** The first transport message: the host knows the psk. */
  confirm(link: RelayLink): void {
    link.post(sealData(this.#session, [this.slot], Uint8Array.of(PLAIN_CONFIRM)));
  }

  receive(body: Uint8Array): void {
    const plain = openData(this.#session, body);
    if (plain?.[0] === PLAIN_CHUNK) this.#inbox.chunk(plain);
  }

  send(message: unknown): Promise<void> {
    if (this.#ended) return Promise.reject(new CoopError('closed', 'This guest has left.'));
    return this.#outbox.send(message);
  }

  onMessage(listener: (message: unknown) => void): () => void {
    return this.#inbox.listen(listener);
  }

  onClose(listener: (reason: CoopCloseReason) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  close(): void {
    this.#kick(this.slot);
  }

  /** The room's side: the channel is over. */
  end(reason: CoopCloseReason): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#inbox.close();
    this.#outbox.fail(new CoopError('closed', 'This guest has left.'));
    for (const listener of [...this.#closeListeners]) listener(reason);
    this.#closeListeners.clear();
  }

  /** The link went down: the message being received won't complete. */
  interrupted(): void {
    this.#inbox.reset();
  }
}

interface SlotState {
  handshake: HandshakeState | null;
  attempt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * The host's end of a room: lets guests' handshakes complete, gives each a `PeerChannel`, and keeps its link to the
 * relay up (with backoff) once it was let in. Peers survive a relay reconnect when their slot is still there.
 */
export class HostRoom extends EventEmitter<HostRoomEvents> {
  readonly roomId: string;
  readonly #options: HostRoomOptions;
  readonly #timing: CoopTiming;
  readonly #known: (key: Uint8Array) => boolean;
  #link: RelayLink | null = null;
  #state: RelayState = 'reconnecting';
  #slots = new Map<number, SlotState>();
  #peers = new Map<number, Peer>();
  /** Kicks the relay hasn't seen yet (the link was down): sent again once it is back. */
  #kicks = new Map<number, number>();
  #failures = 0;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #started = false;
  #closed = false;
  #welcomed: (() => void) | null = null;

  constructor(options: HostRoomOptions) {
    super();
    if (!isRoomId(options.roomId)) throw new TypeError("That isn't a co-op room id.");
    this.roomId = options.roomId;
    this.#options = options;
    this.#timing = { ...DEFAULT_TIMING, ...options.timing };
    const known = options.knownPeers;
    if (typeof known === 'function') this.#known = known;
    else {
      const keys = new Set((known ?? []).map((key) => encodeKey(typeof key === 'string' ? decodeKey(key) : key)));
      this.#known = (key) => keys.has(encodeKey(key));
    }
  }

  get state(): RelayState {
    return this.#state;
  }

  /** The guests with a completed handshake. */
  get peers(): PeerChannel[] {
    return [...this.#peers.values()];
  }

  /** Connects for the first time (rejects when that fails); the room reconnects by itself after that. */
  async start(): Promise<void> {
    try {
      await this.#connect();
    } catch (error) {
      this.#shutDown('relay-closed');
      throw error;
    }
    this.#started = true;
  }

  #setState(state: RelayState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.emit('relay-state', state);
  }

  async #connect(): Promise<void> {
    const welcomed = new Promise<boolean>((resolve) => (this.#welcomed = () => resolve(true)));
    const link = await RelayLink.open(socketUrl(this.#options.relayUrl, this.roomId, 'host', this.#options.hostToken), this.#timing, {
      opened: (opened) => {
        if (!this.#closed) this.#link = opened;
      },
      text: (from, message) => this.#text(from, message),
      binary: (from, data) => this.#binary(from, data),
      closed: (from, code) => this.#closedLink(from, code),
    });
    if (this.#closed) return link.close();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ok = await Promise.race([welcomed, link.ended.then(() => false), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), this.#timing.handshakeMs)))]);
    clearTimeout(timer);
    if (!ok) {
      if (this.#link === link) link.terminate();
      throw new CoopError('network', "The co-op relay didn't let the host in.");
    }
  }

  #text(link: RelayLink, message: Record<string, unknown>): void {
    if (link !== this.#link) return;
    const relay = message as RelayToHost;
    if (relay.t === 'welcome') {
      link.setLimits(relay.limits ?? {});
      const slots = new Set(Array.isArray(relay.slots) ? relay.slots.filter((s): s is number => typeof s === 'number') : []);
      for (const peer of [...this.#peers.values()]) if (!slots.has(peer.slot)) this.#endPeer(peer, 'left');
      for (const slot of [...this.#slots.keys()]) if (!slots.has(slot)) this.#dropSlot(slot);
      for (const [slot, code] of [...this.#kicks]) {
        this.#kicks.delete(slot);
        if (slots.has(slot)) {
          link.post(JSON.stringify({ t: 'kick', slot, code }));
          slots.delete(slot);
        }
      }
      for (const slot of slots) {
        if (!this.#slots.has(slot)) this.#slots.set(slot, { handshake: null, attempt: 0, timer: null });
        // Each guest learns whether its session is still here (a confirmation through it), or that it should start
        // over (this host restarted, or its handshake was cut off).
        const peer = this.#peers.get(slot);
        if (peer) peer.confirm(link);
        else link.post(Uint8Array.of(slot, FRAME_RESET));
      }
      this.#failures = 0;
      this.#setState('connected');
      this.#welcomed?.();
      this.#welcomed = null;
    } else if (relay.t === 'joined' && typeof relay.slot === 'number') {
      const old = this.#peers.get(relay.slot);
      if (old) this.#endPeer(old, 'left');
      this.#dropSlot(relay.slot);
      this.#slots.set(relay.slot, { handshake: null, attempt: 0, timer: null });
    } else if (relay.t === 'left' && typeof relay.slot === 'number') {
      const peer = this.#peers.get(relay.slot);
      if (peer) this.#endPeer(peer, 'left');
      this.#dropSlot(relay.slot);
      this.#kicks.delete(relay.slot);
    }
  }

  #dropSlot(slot: number): void {
    const state = this.#slots.get(slot);
    if (state?.timer) clearTimeout(state.timer);
    this.#slots.delete(slot);
  }

  #endPeer(peer: Peer, reason: CoopCloseReason): void {
    if (this.#peers.get(peer.slot) !== peer) return;
    this.#peers.delete(peer.slot);
    peer.end(reason);
    this.emit('peer-left', peer, reason);
  }

  #binary(link: RelayLink, data: Uint8Array): void {
    if (link !== this.#link || data.length < 2) return;
    const slot = data[0]!;
    const type = data[1]!;
    const body = data.subarray(2);
    const state = this.#slots.get(slot);
    if (!state) return;
    if (type === FRAME_DATA) {
      const peer = this.#peers.get(slot);
      if (peer) peer.receive(body);
      else link.post(Uint8Array.of(slot, FRAME_RESET));
      return;
    }
    const handshake = readHandshake(body);
    if (!handshake) return;
    if (type === FRAME_HELLO1) this.#hello1(link, slot, state, handshake.attempt, handshake.message);
    else if (type === FRAME_HELLO3) this.#hello3(link, slot, state, handshake.attempt, handshake.message);
  }

  #hello1(link: RelayLink, slot: number, state: SlotState, attempt: number, message: Uint8Array): void {
    const old = this.#peers.get(slot);
    if (old) this.#endPeer(old, 'rejoined');
    if (state.timer) clearTimeout(state.timer);
    state.handshake = null;
    const handshake = new HandshakeState({ initiator: false, staticKey: this.#options.staticKey, psk: this.#options.psk, prologue: prologue(this.roomId) });
    try {
      handshake.readMessage(message);
      link.post(handshakeFrame([slot], FRAME_HELLO2, attempt, handshake.writeMessage()));
    } catch {
      return this.kick(slot, CloseCode.refused);
    }
    state.handshake = handshake;
    state.attempt = attempt;
    // A handshake left halfway is forgotten; the guest starts over when it notices.
    state.timer = setTimeout(() => {
      state.handshake = null;
      state.timer = null;
    }, this.#timing.handshakeMs);
    state.timer.unref?.();
  }

  #hello3(link: RelayLink, slot: number, state: SlotState, attempt: number, message: Uint8Array): void {
    const handshake = state.handshake;
    // An answer to a handshake the guest replaced already: the newer one is on its way.
    if (handshake && attempt !== state.attempt) return;
    if (state.timer) clearTimeout(state.timer);
    state.handshake = null;
    state.timer = null;
    if (!handshake) return link.post(Uint8Array.of(slot, FRAME_RESET));
    let hello: CoopHello | null;
    try {
      hello = readHello(handshake.readMessage(message));
    } catch {
      // The guest doesn't have this room's invite (or has an old one): tell it, so it stops trying.
      return this.kick(slot, CloseCode.refused);
    }
    if (!hello) return this.kick(slot, CloseCode.refused);
    const peer = new Peer(
      () => this.#link,
      (s) => this.kick(s, CloseCode.removed),
      slot,
      handshake,
      hello,
      this.#known(handshake.remoteStatic!),
    );
    this.#peers.set(slot, peer);
    peer.confirm(link);
    this.emit('peer', peer);
  }

  /** Closes a guest's connection at the relay (4010 removed, 4011 refused, or another 4010–4019). */
  kick(slot: number, code: number = CloseCode.removed): void {
    const peer = this.#peers.get(slot);
    if (peer) this.#endPeer(peer, 'closed');
    this.#dropSlot(slot);
    if (this.#link?.open) this.#link.post(JSON.stringify({ t: 'kick', slot, code }));
    else this.#kicks.set(slot, code);
  }

  #closedLink(link: RelayLink, code: number): void {
    if (link !== this.#link) return;
    this.#link = null;
    for (const state of this.#slots.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.handshake = null;
      state.timer = null;
    }
    for (const peer of this.#peers.values()) peer.interrupted();
    if (this.#closed || !this.#started) return;
    // The room is gone, or another connection with the token took it over: reconnecting would only fight it.
    if (code === CloseCode.roomClosed || code === CloseCode.replaced) return this.#shutDown(code === CloseCode.roomClosed ? 'room-closed' : 'relay-closed');
    this.#setState('reconnecting');
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#retry) return;
    this.#failures++;
    this.#retry = setTimeout(() => {
      this.#retry = null;
      this.#connect().catch((error: unknown) => {
        if (error instanceof CoopError && (error.code === 'not_found' || error.code === 'forbidden')) return this.#shutDown(error.code === 'not_found' ? 'room-closed' : 'relay-closed');
        this.#scheduleReconnect();
      });
    }, this.#timing.backoff(this.#failures));
  }

  #shutDown(reason: CoopCloseReason): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#retry) clearTimeout(this.#retry);
    const link = this.#link;
    this.#link = null;
    link?.close(CloseCode.normal);
    for (const peer of [...this.#peers.values()]) this.#endPeer(peer, reason);
    for (const slot of [...this.#slots.keys()]) this.#dropSlot(slot);
    this.#setState('closed');
  }

  /** Leaves the relay and ends every peer. The room stays at the relay (`deleteRoom` closes it for everyone). */
  close(): void {
    this.#shutDown('closed');
  }

  /** For tests: drops the link to the relay as a network failure would. */
  dropLinkForTest(): void {
    this.#link?.terminate();
  }
}

/** Opens the host's end of a room; resolves once the relay let it in, rejects if it doesn't the first time. */
export async function openHostRoom(options: HostRoomOptions): Promise<HostRoom> {
  const room = new HostRoom(options);
  await room.start();
  return room;
}

// ---------------------------------------------------------------------------------------------------------------
// A guest

export interface JoinRoomOptions {
  relayUrl: string;
  roomId: string;
  /** From the invite's secret (`pskFromSecret`). */
  psk: Uint8Array;
  staticKey: StaticKey;
  /** Who this is, for the host to decide (sent encrypted, in the handshake). */
  hello: CoopHello;
  /** The host's device key when it is pinned already; otherwise the first handshake pins it for this channel. */
  hostKey?: Uint8Array | string;
  /** The first join gives up after this long (waiting for the host included). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Where the first join is: for "Waiting for the host…". */
  onStatus?: (status: 'connecting' | 'waiting-for-host' | 'handshaking') => void;
  timing?: Partial<CoopTiming>;
}

type GuestEvents = {
  /** The link to the host works again after a gap; messages sent in it are lost: resubscribe. */
  reconnected: [];
  /** The relay says whether the host is connected. */
  host: [present: boolean];
};

const GUEST_CLOSE: Partial<Record<number, CoopCloseReason>> = {
  [CloseCode.roomClosed]: 'room-closed',
  [CloseCode.removed]: 'removed',
  [CloseCode.refused]: 'refused',
};

const firstJoinError = (reason: CoopCloseReason | undefined): CoopError =>
  reason === 'room-closed'
    ? new CoopError('room_closed', 'That co-op room is closed.')
    : reason === 'removed'
      ? new CoopError('removed', 'The host removed you from the room.')
      : reason === 'refused'
        ? new CoopError('refused', "The host didn't accept this invite: it may be old, or for another room.")
        : new CoopError('network', 'The connection to the co-op relay dropped.');

/** A guest's channel to the host: one session at a time, a fresh handshake whenever the old one can't go on. */
export class GuestChannel extends EventEmitter<GuestEvents> {
  readonly roomId: string;
  readonly #options: JoinRoomOptions;
  readonly #timing: CoopTiming;
  readonly #hello: Uint8Array;
  #hostKey: Uint8Array | null;
  #link: RelayLink | null = null;
  #handshake: HandshakeState | null = null;
  #attempt = 0;
  #pending: { session: Session; hash: Uint8Array; remote: Uint8Array } | null = null;
  #session: Session | null = null;
  #hash: Uint8Array | null = null;
  #hostPresent = false;
  #ready = false;
  #ever = false;
  #closed = false;
  #failures = 0;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #stepTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #outbox: Outbox;
  readonly #inbox = new Inbox();
  #closeListeners = new Set<(reason: CoopCloseReason) => void>();
  #first: { resolve(): void; reject(error: CoopError): void } | null = null;

  constructor(options: JoinRoomOptions) {
    super();
    if (!isRoomId(options.roomId)) throw new TypeError("That isn't a co-op room id.");
    const hello = Buffer.from(JSON.stringify(options.hello), 'utf8');
    if (!readHello(hello)) throw new TypeError(`The hello needs a name and a version, in at most ${MAX_HELLO_BYTES} bytes of JSON.`);
    this.roomId = options.roomId;
    this.#options = options;
    this.#timing = { ...DEFAULT_TIMING, ...options.timing };
    this.#hello = hello;
    this.#hostKey = options.hostKey === undefined ? null : typeof options.hostKey === 'string' ? decodeKey(options.hostKey) : new Uint8Array(options.hostKey);
    this.#outbox = new Outbox(() => (this.#ready && this.#link?.open && this.#session ? { link: this.#link, session: this.#session, prefix: [] } : null));
  }

  /** The host's device key (pin it). */
  get remoteStatic(): Uint8Array {
    return new Uint8Array(this.#hostKey ?? []);
  }

  get remoteKey(): string {
    return encodeKey(this.remoteStatic);
  }

  /** This session's handshake hash; a re-join makes a new one. */
  get handshakeHash(): Uint8Array {
    return new Uint8Array(this.#hash ?? []);
  }

  /** This session's emoji (they change with each new handshake). */
  get fingerprint(): [string, string, string] {
    return fingerprintOf(this.handshakeHash);
  }

  /** Whether messages can go to the host right now. */
  get ready(): boolean {
    return this.#ready && !this.#closed;
  }

  /** Whether the host is connected to the relay, as far as this guest knows. */
  get hostPresent(): boolean {
    return this.#hostPresent;
  }

  get open(): boolean {
    return !this.#closed;
  }

  /** Resolves once the host confirmed the first session; rejects on the first failure (nothing is retried). */
  start(): Promise<void> {
    const { signal } = this.#options;
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => this.#fail(new CoopError('timeout', "The host didn't answer in time.")), this.#options.timeoutMs ?? 120_000);
      const onAbort = () => this.#fail(new CoopError('aborted', 'Joining was cancelled.'));
      const settle = () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
      };
      this.#first = {
        resolve() {
          settle();
          resolve();
        },
        reject(error) {
          settle();
          reject(error);
        },
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#options.onStatus?.('connecting');
      this.#connect().catch((error: unknown) => this.#fail(error instanceof CoopError ? error : new CoopError('network', String(error))));
    });
  }

  #fail(error: CoopError): void {
    const first = this.#first;
    if (!first) return;
    this.#first = null;
    this.#shutDown('closed');
    first.reject(error);
  }

  async #connect(): Promise<void> {
    const link = await RelayLink.open(socketUrl(this.#options.relayUrl, this.roomId, 'guest'), this.#timing, {
      opened: (opened) => {
        if (!this.#closed) this.#link = opened;
      },
      text: (from, message) => this.#text(from, message),
      binary: (from, data) => this.#binary(from, data),
      closed: (from, code) => this.#closedLink(from, code),
    });
    if (this.#closed) link.close();
  }

  #text(link: RelayLink, message: Record<string, unknown>): void {
    if (link !== this.#link) return;
    const relay = message as RelayToGuest;
    if (relay.t === 'welcome') {
      link.setLimits(relay.limits ?? {});
      this.#failures = 0;
      this.#hostSeen(relay.host === true, true);
    } else if (relay.t === 'host') this.#hostSeen(relay.present === true, false);
  }

  #hostSeen(present: boolean, welcome: boolean): void {
    const was = this.#hostPresent;
    this.#hostPresent = present;
    if (present !== was && !(welcome && present === false)) this.emit('host', present);
    if (!present) {
      // Sessions outlive the host's absence; a handshake halfway doesn't.
      this.#handshake = null;
      this.#pending = null;
      this.#clearStep();
      if (this.#ready) {
        this.#ready = false;
        this.#inbox.reset();
      }
      if (this.#first) this.#options.onStatus?.('waiting-for-host');
      return;
    }
    // The host is back. With our session still there (its link dropped, not its app) it confirms through it; if it
    // lost it, it asks for a new handshake. Until one of them arrives, nothing is sent.
    if (this.#session && !this.#ready) this.#step();
    else if (!this.#session && !this.#handshake && !this.#pending) this.#startHandshake();
  }

  #clearStep(): void {
    if (this.#stepTimer) clearTimeout(this.#stepTimer);
    this.#stepTimer = null;
  }

  /** The host has this long for the next step (an answer, a confirmation), or the handshake starts over. */
  #step(): void {
    this.#clearStep();
    this.#stepTimer = setTimeout(() => {
      this.#stepTimer = null;
      this.#handshake = null;
      this.#pending = null;
      if (this.#hostPresent && !this.#ready) this.#startHandshake();
    }, this.#timing.handshakeMs);
    this.#stepTimer.unref?.();
  }

  #startHandshake(): void {
    const link = this.#link;
    if (!link?.open || this.#closed) return;
    this.#session = null;
    this.#ready = false;
    this.#pending = null;
    this.#attempt = (this.#attempt % 0xffff_ffff) + 1;
    this.#handshake = new HandshakeState({ initiator: true, staticKey: this.#options.staticKey, psk: this.#options.psk, prologue: prologue(this.roomId) });
    link.post(handshakeFrame([], FRAME_HELLO1, this.#attempt, this.#handshake.writeMessage()));
    if (this.#first) this.#options.onStatus?.('handshaking');
    this.#step();
  }

  #binary(link: RelayLink, data: Uint8Array): void {
    if (link !== this.#link || !data.length) return;
    const type = data[0]!;
    const body = data.subarray(1);
    if (type === FRAME_HELLO2) {
      const handshake = readHandshake(body);
      if (handshake?.attempt === this.#attempt) this.#hello2(link, handshake.message);
    } else if (type === FRAME_DATA) this.#data(body);
    else if (type === FRAME_RESET && (this.#session || this.#pending)) {
      // The host has no session with us (it restarted, or never got our last message): handshake again. During a
      // handshake a reset is old news, and the handshake goes on.
      if (this.#ready) this.#inbox.reset();
      this.#session = null;
      this.#ready = false;
      this.#pending = null;
      if (this.#hostPresent) this.#startHandshake();
    }
  }

  #hello2(link: RelayLink, message: Uint8Array): void {
    const handshake = this.#handshake;
    if (!handshake || handshake.isMyTurn) return;
    this.#handshake = null;
    let reply: Uint8Array;
    try {
      handshake.readMessage(message);
      const remote = handshake.remoteStatic!;
      if (this.#hostKey && !sameKey(this.#hostKey, remote)) return this.#hostKeyChanged();
      reply = handshake.writeMessage(this.#hello);
      this.#pending = { session: { cipher: handshake.split(), received: 0 }, hash: handshake.handshakeHash, remote };
    } catch {
      // Not from our host, or changed on the way: the step timer starts a new handshake.
      return;
    }
    link.post(handshakeFrame([], FRAME_HELLO3, this.#attempt, reply));
    this.#step();
  }

  #hostKeyChanged(): void {
    const error = new CoopError('host_key_changed', "The host's device key isn't the one this room was joined with.");
    if (this.#first) return this.#fail(error);
    this.#shutDown('host-key-changed');
  }

  #data(body: Uint8Array): void {
    if (this.#pending) {
      const plain = openData(this.#pending.session, body);
      if (plain?.length !== 1 || plain[0] !== PLAIN_CONFIRM) return;
      // The host proved it has the invite's key: this session is the one.
      const { session, hash, remote } = this.#pending;
      this.#pending = null;
      this.#clearStep();
      this.#session = session;
      this.#hash = hash;
      this.#hostKey ??= remote;
      this.#ready = true;
      const first = this.#first;
      if (first) {
        this.#first = null;
        this.#ever = true;
        first.resolve();
      } else this.emit('reconnected');
      return;
    }
    if (!this.#session) return;
    const plain = openData(this.#session, body);
    if (!plain) return;
    if (plain.length === 1 && plain[0] === PLAIN_CONFIRM) {
      // The host came back with this session.
      if (this.#ready) return;
      this.#clearStep();
      this.#ready = true;
      this.emit('reconnected');
    } else if (plain[0] === PLAIN_CHUNK) this.#inbox.chunk(plain);
  }

  #closedLink(link: RelayLink, code: number): void {
    if (link !== this.#link) return;
    this.#link = null;
    this.#handshake = null;
    this.#pending = null;
    // A new connection is a new slot, and the host forgets this one's session: the next one handshakes afresh.
    this.#session = null;
    this.#ready = false;
    this.#clearStep();
    this.#inbox.reset();
    if (this.#closed) return;
    if (this.#hostPresent) {
      this.#hostPresent = false;
      if (!this.#first) this.emit('host', false);
    }
    const reason = GUEST_CLOSE[code];
    if (this.#first) return this.#fail(firstJoinError(reason));
    if (reason) return this.#shutDown(reason);
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#retry) return;
    this.#failures++;
    this.#retry = setTimeout(() => {
      this.#retry = null;
      this.#connect().catch((error: unknown) => {
        if (error instanceof CoopError && error.code === 'not_found') return this.#shutDown('room-closed');
        // Full means our old connection still holds its place until the relay notices it is gone: try again.
        this.#scheduleReconnect();
      });
    }, this.#timing.backoff(this.#failures));
  }

  #shutDown(reason: CoopCloseReason): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#ready = false;
    if (this.#retry) clearTimeout(this.#retry);
    this.#clearStep();
    const link = this.#link;
    this.#link = null;
    link?.close(CloseCode.normal);
    this.#inbox.close();
    this.#outbox.fail(new CoopError('closed', 'The co-op channel is closed.'));
    if (this.#ever) for (const listener of [...this.#closeListeners]) listener(reason);
    this.#closeListeners.clear();
  }

  /** Resolves when the whole message was handed to the socket; rejects while the link is down (`offline`). */
  send(message: unknown): Promise<void> {
    if (this.#closed) return Promise.reject(new CoopError('closed', 'The co-op channel is closed.'));
    return this.#outbox.send(message);
  }

  /** Messages that arrived before the first listener are given to it. Returns an unsubscribe. */
  onMessage(listener: (message: unknown) => void): () => void {
    return this.#inbox.listen(listener);
  }

  onClose(listener: (reason: CoopCloseReason) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  /** Leaves the room. */
  close(): void {
    this.#shutDown('closed');
  }

  /** For tests: drops the link to the relay as a network failure would. */
  dropLinkForTest(): void {
    this.#link?.terminate();
  }
}

/** Joins a room as a guest; resolves once the host confirmed the session. */
export async function joinRoom(options: JoinRoomOptions): Promise<GuestChannel> {
  const channel = new GuestChannel(options);
  await channel.start();
  return channel;
}
