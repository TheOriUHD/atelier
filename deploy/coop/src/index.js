/**
 * Atelier's co-op relay (README.md): forwards end-to-end encrypted bytes between a co-op host and its guests, who
 * are usually all behind NAT. The protocol and the room logic are packages/core/src/coop/relay-protocol.ts, bundled
 * from there (wrangler handles TypeScript; `node --test` strips the types), the same code the Node relay runs.
 *
 * One Durable Object per room, named by the room id, using the WebSocket Hibernation API: between frames the object
 * may leave memory while its sockets stay open. What it needs after waking is in storage (the room's record) and in
 * each socket's attachment (its connection); `ping` is answered by the runtime without waking it.
 *
 * Nothing here looks inside data frames or logs them, nor host tokens (a host sends its token in `Authorization`).
 */
/* global WebSocketPair, WebSocketRequestResponsePair -- the Workers runtime's */
import { bearer, CloseCode, hashToken, isRoomId, newHostToken, newRoomId, parseJoin, PING, PONG, Room as RoomState, roomPath } from '../../../packages/core/src/coop/relay-protocol.ts';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (status, error) => json({ error }, status);
const BAD_JOIN = 'Say ?role=guest, or ?role=host with the host token in an Authorization header.';

/** A rate limiting binding (wrangler.toml), per address; without one (a test, a copy without it) nothing is limited. */
async function allowed(limiter, key) {
  if (!limiter) return true;
  const { success } = await limiter.limit({ key });
  return success;
}

const roomStub = (env, roomId) => env.ROOMS.get(env.ROOMS.idFromName(roomId));

async function createRoom(env) {
  // A clash of 128 random bits won't happen; the loop is for the impossible.
  for (let i = 0; i < 3; i++) {
    const roomId = newRoomId();
    const hostToken = newHostToken();
    const res = await roomStub(env, roomId).fetch('https://room.invalid/init', { method: 'POST', body: JSON.stringify({ roomId, tokenHash: await hashToken(hostToken) }) });
    if (res.status === 201) return json({ roomId, hostToken }, 201);
    if (res.status !== 409) break;
  }
  return fail(500, 'The relay failed to make a room.');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    if (url.pathname === '/' && request.method === 'GET') return new Response('Atelier co-op relay\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    const roomId = roomPath(url.pathname);
    if (roomId === null) return fail(404, 'Not found.');
    if (roomId === '') {
      if (request.method !== 'POST') return fail(405, 'Method not allowed.');
      if (!(await allowed(env.CREATE_LIMITER, ip))) return fail(429, 'Too many rooms from this address; wait a minute.');
      return createRoom(env);
    }
    if (!isRoomId(roomId)) return fail(404, 'No such room, or it closed.');
    if (request.method === 'GET') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return fail(426, 'Connect with a WebSocket.');
      if (!parseJoin(url.searchParams, request.headers.get('authorization'))) return fail(400, BAD_JOIN);
      if (!(await allowed(env.JOIN_LIMITER, ip))) return fail(429, 'Too many attempts from this address; wait a minute.');
    } else if (request.method !== 'DELETE') return fail(405, 'Method not allowed.');
    // The room's object gets the caller's address in a header only this Worker sets.
    const headers = new Headers(request.headers);
    headers.set('x-coop-ip', ip);
    return roomStub(env, roomId).fetch(new Request(request, { headers }));
  },
};

/** One room. */
export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    /** The room, rebuilt on the first event after a wake. */
    this.room = null;
    this.heldTimer = null;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  /** The room from storage and the sockets still open, or null when there is none (never made, or closed). */
  async load() {
    if (this.room) return this.room;
    const record = await this.ctx.storage.get('room');
    if (!record) return null;
    if (this.room) return this.room;
    const conns = [];
    for (const ws of this.ctx.getWebSockets()) {
      const conn = ws.deserializeAttachment();
      // A socket the room closed itself may linger in CLOSING; it is no longer in the room.
      if (conn && !conn.closed) conns.push(conn);
    }
    this.room = RoomState.restore(record, conns, Date.now());
    this.refresh();
    return this.room;
  }

  /** The runtime answers pings without the room: tell it when each connection last pinged. */
  refresh() {
    for (const ws of this.ctx.getWebSockets()) {
      const conn = ws.deserializeAttachment();
      const at = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      if (conn && at) this.room.touch(conn.id, at.getTime());
    }
  }

  socket(id) {
    return this.ctx.getWebSockets(id)[0] ?? null;
  }

  /** Does what the room says. A Durable Object can't stop reading a socket: frames over the rate wait in the room. */
  run(actions) {
    for (const action of actions) {
      if (action.type === 'send' || action.type === 'text') {
        try {
          this.socket(action.to)?.send(action.type === 'send' ? action.data : action.text);
        } catch {
          // Closing already; its close event follows.
        }
      } else if (action.type === 'close') {
        const ws = this.socket(action.to);
        if (!ws) continue;
        try {
          ws.serializeAttachment({ ...ws.deserializeAttachment(), closed: true });
          ws.close(action.code, action.reason);
        } catch {
          // Already gone.
        }
      }
    }
    this.scheduleHeld();
  }

  scheduleHeld() {
    const at = this.room && !this.room.closed ? this.room.heldUntil(Date.now()) : null;
    if (at === null || this.heldTimer) return;
    this.heldTimer = setTimeout(() => {
      this.heldTimer = null;
      if (!this.room) return;
      this.refresh();
      void this.finish(this.room.tick(Date.now()));
    }, Math.max(0, at - Date.now()));
  }

  /** Runs the actions, then saves the room and its next alarm, or forgets it when it closed. */
  async finish(actions) {
    this.run(actions);
    const room = this.room;
    if (!room) return;
    if (room.closed) {
      this.room = null;
      clearTimeout(this.heldTimer);
      this.heldTimer = null;
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.ctx.storage.put('room', room.record);
    const at = room.nextDeadline();
    if (Number.isFinite(at)) await this.ctx.storage.setAlarm(Math.max(at, Date.now() + 1000));
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/init' && request.method === 'POST') {
      if (this.room || (await this.ctx.storage.get('room'))) return new Response(null, { status: 409 });
      const { roomId, tokenHash } = await request.json();
      this.room = RoomState.create(roomId, tokenHash, Date.now());
      await this.finish([]);
      return new Response(null, { status: 201 });
    }
    const room = await this.load();
    if (!room || room.closed) return fail(404, 'No such room, or it closed.');
    if (request.method === 'DELETE') {
      const token = bearer(request.headers.get('authorization'));
      if (!room.checkToken(token && (await hashToken(token)))) return fail(403, "That isn't this room's host token.");
      await this.finish(room.remove());
      return new Response(null, { status: 204 });
    }
    const join = parseJoin(url.searchParams, request.headers.get('authorization'));
    if (!join) return fail(400, BAD_JOIN);
    const tokenHash = join.token ? await hashToken(join.token) : null;
    const id = crypto.randomUUID();
    const result = room.join({ id, role: join.role, tokenHash, ip: request.headers.get('x-coop-ip') ?? 'unknown' }, Date.now());
    if (!result.ok) return fail(result.status, result.reason);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [id]);
    server.serializeAttachment(result.conn);
    await this.finish(result.actions);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const room = await this.load();
    const conn = ws.deserializeAttachment();
    if (!room || !conn) return ws.close(CloseCode.roomClosed, 'This room is closed.');
    const actions = room.receive(conn.id, typeof message === 'string' ? message : new Uint8Array(message), Date.now());
    // Data frames change nothing worth saving; control frames and closes may.
    if (typeof message === 'string' || actions.some((a) => a.type === 'close' || a.type === 'closed')) await this.finish(actions);
    else this.run(actions);
  }

  async webSocketClose(ws) {
    const room = await this.load();
    const conn = ws.deserializeAttachment();
    if (room && conn) await this.finish(room.disconnect(conn.id, Date.now()));
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  /** Idle connections and the room's expiry. */
  async alarm() {
    const room = await this.load();
    if (!room) return;
    this.refresh();
    await this.finish(room.tick(Date.now()));
  }
}
