/**
 * The co-op relay on Node, with `ws`: the protocol in relay-protocol.ts, for tests and e2e, and so a self-hosted
 * Atelier server can be its own relay. The hosted one is the Cloudflare Worker in deploy/coop; both drive the same
 * `Room`.
 *
 * - `startCoopRelay({ port })` runs a relay on its own HTTP server (paths from `/`).
 * - `attachCoopRelay(server, { path: '/api/coop' })` adds it to an existing HTTP server (see there for the order).
 * - `createCoopRelay(options)` gives the request and upgrade handlers, for a server that dispatches itself.
 *
 * What only this driver does: it stops reading a sender while the room holds its frames for the rate, or while the
 * guest (or host) it sends to has more than `SLOW_BYTES` waiting in its socket, so a fast sender is slowed down
 * through TCP instead of filling this process's memory.
 *
 * It never logs frame contents or tokens.
 */
import { createServer, STATUS_CODES, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import {
  bearer,
  DEFAULT_LIMITS,
  hashToken,
  MAX_HOST_FRAME,
  newHostToken,
  newRoomId,
  parseJoin,
  RateLimiter,
  Room,
  roomPath,
  CloseCode,
  type RelayLimits,
  type RoomAction,
} from './relay-protocol.ts';

/** A receiver with this much unsent makes the relay stop reading its sender… */
const SLOW_BYTES = 4 * 1024 * 1024;
/** …until it is down to this. */
const DRAINED_BYTES = 1024 * 1024;
const DRAIN_POLL_MS = 25;
const TICK_MS = 5_000;

export interface CoopRelayOptions {
  /** Where the relay's paths start: `''` (the default) for `/v1/rooms`, `'/api/coop'` for `/api/coop/v1/rooms`. */
  path?: string;
  limits?: Partial<RelayLimits>;
  /** The caller's address, for the per-address limits. Behind a proxy, read its header here; the socket's by default. */
  clientIp?: (req: IncomingMessage) => string;
  /** The clock rooms run on. */
  now?: () => number;
  logger?: { info(message: string): void; error(message: string): void };
}

export interface CoopRelay {
  /** Answers the relay's HTTP requests; false for paths outside it. */
  handleRequest(req: IncomingMessage, res: ServerResponse): boolean;
  /** Takes the relay's WebSocket upgrades; false for paths outside it. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** Rooms open now. */
  readonly rooms: number;
  /** Closes every connection (1001) and stops the timers. */
  close(): Promise<void>;
}

export interface StandaloneCoopRelay extends CoopRelay {
  server: Server;
  port: number;
  /** `http://127.0.0.1:<port>` or the host given: what clients use as `relayUrl`. */
  url: string;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};

/** Refuses an upgrade before it happens, with a status the client can read. */
function refuse(socket: Duplex, status: number, message: string): void {
  if (!socket.writable) return void socket.destroy();
  const body = `${message}\n`;
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

export function createCoopRelay(options: CoopRelayOptions = {}): CoopRelay {
  const base = (options.path ?? '').replace(/\/+$/, '');
  const limits: RelayLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const clientIp = options.clientIp ?? ((req: IncomingMessage) => req.socket.remoteAddress ?? 'unknown');
  const log = options.logger ?? { info() {}, error() {} };

  const rooms = new Map<string, Room>();
  const sockets = new Map<string, WebSocket>();
  const pauses = new Map<string, number>();
  const draining = new Set<string>();
  const heldTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const joins = new RateLimiter(limits.joinsPerMinute);
  const creates = new RateLimiter(limits.createsPerMinute);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_HOST_FRAME, perMessageDeflate: false, clientTracking: false });
  let nextConn = 0;
  let closing = false;

  /** Where `pathname` is inside the relay, or null when it isn't the relay's. */
  const inside = (pathname: string) => (base === '' ? pathname : pathname === base || pathname.startsWith(`${base}/`) ? pathname.slice(base.length) || '/' : null);

  function pause(id: string): void {
    const count = (pauses.get(id) ?? 0) + 1;
    pauses.set(id, count);
    if (count === 1) sockets.get(id)?.pause();
  }

  function resume(id: string): void {
    const count = (pauses.get(id) ?? 0) - 1;
    if (count > 0) return void pauses.set(id, count);
    pauses.delete(id);
    sockets.get(id)?.resume();
  }

  /** Stops reading `from` until `to` sent most of what it has waiting. */
  function waitForDrain(from: string, to: WebSocket): void {
    if (draining.has(from)) return;
    draining.add(from);
    pause(from);
    const check = () => {
      if (to.readyState === WebSocket.OPEN && to.bufferedAmount > DRAINED_BYTES && sockets.has(from)) return void setTimeout(check, DRAIN_POLL_MS).unref();
      draining.delete(from);
      resume(from);
    };
    setTimeout(check, DRAIN_POLL_MS).unref();
  }

  function scheduleHeld(room: Room): void {
    const at = room.heldUntil(now());
    if (at === null || heldTimers.has(room.id)) return;
    heldTimers.set(
      room.id,
      setTimeout(
        () => {
          heldTimers.delete(room.id);
          run(room, room.tick(now()));
        },
        Math.max(0, at - now()),
      ),
    );
  }

  function run(room: Room, actions: RoomAction[]): void {
    for (const action of actions) {
      if (action.type === 'send') {
        const to = sockets.get(action.to);
        if (to?.readyState !== WebSocket.OPEN) continue;
        to.send(action.data);
        if (to.bufferedAmount > SLOW_BYTES) waitForDrain(action.from, to);
      } else if (action.type === 'text') {
        const to = sockets.get(action.to);
        if (to?.readyState === WebSocket.OPEN) to.send(action.text);
      } else if (action.type === 'close') {
        const ws = sockets.get(action.to);
        sockets.delete(action.to);
        pauses.delete(action.to);
        ws?.close(action.code, action.reason);
      } else if (action.type === 'pause') pause(action.conn);
      else if (action.type === 'resume') resume(action.conn);
      else if (action.type === 'closed') {
        rooms.delete(room.id);
        clearTimeout(heldTimers.get(room.id));
        heldTimers.delete(room.id);
        log.info(`co-op relay: a room closed (${rooms.size} open)`);
      }
    }
    if (!room.closed) scheduleHeld(room);
  }

  const ticker = setInterval(() => {
    const at = now();
    for (const room of [...rooms.values()]) run(room, room.tick(at));
    joins.prune(at);
    creates.prune(at);
  }, TICK_MS);
  ticker.unref();

  async function create(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!creates.allow(clientIp(req), now())) return json(res, 429, { error: 'Too many rooms from this address; wait a minute.' });
    let roomId = newRoomId();
    while (rooms.has(roomId)) roomId = newRoomId();
    const hostToken = newHostToken();
    rooms.set(roomId, Room.create(roomId, await hashToken(hostToken), now(), limits));
    log.info(`co-op relay: a room opened (${rooms.size} open)`);
    json(res, 201, { roomId, hostToken });
  }

  async function remove(req: IncomingMessage, res: ServerResponse, roomId: string): Promise<void> {
    const token = bearer(req.headers.authorization);
    const room = rooms.get(roomId);
    if (!room) return json(res, 404, { error: 'No such room.' });
    if (!room.checkToken(token && (await hashToken(token)))) return json(res, 403, { error: "That isn't this room's host token." });
    run(room, room.remove());
    res.writeHead(204, { 'cache-control': 'no-store' }).end();
  }

  function handleRequest(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://relay.invalid');
    const sub = inside(url.pathname);
    if (sub === null) return false;
    req.resume();
    const roomId = roomPath(sub);
    const fail = (error: unknown) => {
      log.error(`co-op relay: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) json(res, 500, { error: 'The relay failed.' });
    };
    if (sub === '/' && req.method === 'GET') res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('Atelier co-op relay\n');
    else if (roomId === null) json(res, 404, { error: 'Not found.' });
    else if (roomId === '' && req.method === 'POST') create(req, res).catch(fail);
    else if (roomId !== '' && req.method === 'DELETE') remove(req, res, roomId).catch(fail);
    else if (roomId !== '' && req.method === 'GET') json(res, 426, { error: 'Connect with a WebSocket.' });
    else json(res, 405, { error: 'Method not allowed.' });
    return true;
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? '/', 'http://relay.invalid');
    const sub = inside(url.pathname);
    if (sub === null) return false;
    socket.on('error', () => socket.destroy());
    const roomId = roomPath(sub);
    const request = parseJoin(url.searchParams, req.headers.authorization);
    if (closing) refuse(socket, 503, 'The relay is shutting down.');
    else if (!roomId) refuse(socket, 404, 'Not found.');
    else if (!request) refuse(socket, 400, 'Say ?role=guest, or ?role=host with the host token in an Authorization header.');
    else {
      const ip = clientIp(req);
      if (!joins.allow(ip, now())) refuse(socket, 429, 'Too many attempts from this address; wait a minute.');
      else join(req, socket, head, roomId, request, ip);
    }
    return true;
  }

  function join(req: IncomingMessage, socket: Duplex, head: Buffer, roomId: string, request: NonNullable<ReturnType<typeof parseJoin>>, ip: string): void {
    void (async () => {
      const tokenHash = request.token ? await hashToken(request.token) : null;
      const room = rooms.get(roomId);
      if (!room || room.closed) return refuse(socket, 404, 'No such room, or it closed.');
      const id = `c${++nextConn}`;
      const result = room.join({ id, role: request.role, tokenHash, ip }, now());
      if (!result.ok) return refuse(socket, result.status, result.reason);
      let upgraded = false;
      // Without verifyClient, ws completes the upgrade synchronously (or destroys a socket that already ended).
      wss.handleUpgrade(req, socket, head, (ws) => {
        upgraded = true;
        sockets.set(id, ws);
        ws.on('message', (data: Buffer, isBinary) => {
          const current = rooms.get(roomId);
          if (current) run(current, current.receive(id, isBinary ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data.toString('utf8'), now()));
        });
        ws.on('close', () => {
          if (sockets.get(id) === ws) sockets.delete(id);
          pauses.delete(id);
          const current = rooms.get(roomId);
          if (current) run(current, current.disconnect(id, now()));
        });
        ws.on('error', () => {});
        run(room, result.actions);
      });
      if (!upgraded) run(room, room.disconnect(id, now()));
    })().catch((error: unknown) => {
      log.error(`co-op relay: ${error instanceof Error ? error.message : String(error)}`);
      socket.destroy();
    });
  }

  return {
    handleRequest,
    handleUpgrade,
    get rooms() {
      return rooms.size;
    },
    async close() {
      closing = true;
      clearInterval(ticker);
      for (const timer of heldTimers.values()) clearTimeout(timer);
      heldTimers.clear();
      const open = [...sockets.values()];
      sockets.clear();
      await Promise.all(
        open.map(
          (ws) =>
            new Promise<void>((resolve) => {
              if (ws.readyState === WebSocket.CLOSED) return resolve();
              ws.once('close', () => resolve());
              ws.close(CloseCode.goingAway, 'The relay is shutting down.');
              setTimeout(() => ws.terminate(), 1000).unref();
            }),
        ),
      );
      rooms.clear();
      wss.close();
    },
  };
}

/**
 * Adds the relay to `server` under `path` (default `/api/coop`). It takes over the server's `request` and `upgrade`
 * listeners: its own paths go to the relay, everything else to the listeners that were there before. Call it after the
 * server's other handlers are in place (with Hono, after `injectWebSocket(server)`), because a listener added later
 * would see the relay's requests too.
 */
export function attachCoopRelay(server: Server, options: CoopRelayOptions = {}): CoopRelay {
  const relay = createCoopRelay({ ...options, path: options.path ?? '/api/coop' });
  type Listener = (...args: unknown[]) => void;
  const requests = server.listeners('request') as Listener[];
  const upgrades = server.listeners('upgrade') as Listener[];
  server.removeAllListeners('request');
  server.removeAllListeners('upgrade');
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    if (relay.handleRequest(req, res)) return;
    if (!requests.length) return void res.writeHead(404).end();
    for (const listener of requests) listener.call(server, req, res);
  });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (relay.handleUpgrade(req, socket, head)) return;
    // With no other listener Node would have closed the socket; now that there is one, that is ours to do.
    if (!upgrades.length) return void socket.destroy();
    for (const listener of upgrades) listener.call(server, req, socket, head);
  });
  return relay;
}

/** A relay on its own HTTP server: `port: 0` picks a free one. */
export async function startCoopRelay(options: CoopRelayOptions & { port: number; host?: string }): Promise<StandaloneCoopRelay> {
  const server = createServer();
  const relay = attachCoopRelay(server, { ...options, path: options.path ?? '' });
  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    server,
    port,
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}${options.path ?? ''}`,
    handleRequest: relay.handleRequest,
    handleUpgrade: relay.handleUpgrade,
    get rooms() {
      return relay.rooms;
    },
    async close() {
      await relay.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
