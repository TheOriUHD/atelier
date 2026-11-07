import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker, { Room } from './index.js';

// The Workers runtime's pieces the relay uses, as small fakes: a socket pair, the auto-response pair, and a
// Response that allows 101 (Node's refuses it).
globalThis.WebSocketRequestResponsePair = function (request, response) {
  this.request = request;
  this.response = response;
};
/** The client end records what the room sent it; `client.server` is the end the room holds. */
globalThis.WebSocketPair = function () {
  const client = { received: [], closed: null };
  const server = {
    readyState: 1,
    attachment: null,
    send(data) {
      if (this.readyState !== 1) throw new Error('closed');
      client.received.push(typeof data === 'string' ? (data === 'pong' ? data : JSON.parse(data)) : [...new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength)]);
    },
    close(code, reason) {
      client.closed = { code, reason };
      this.readyState = 3;
    },
    serializeAttachment(value) {
      this.attachment = structuredClone(value);
    },
    deserializeAttachment() {
      return this.attachment && structuredClone(this.attachment);
    },
  };
  client.server = server;
  this[0] = client;
  this[1] = server;
};
const NodeResponse = globalThis.Response;
globalThis.Response = class extends NodeResponse {
  constructor(body, init = {}) {
    super(body, init.status === 101 ? { ...init, status: 200 } : init);
    if (init.status === 101) this.webSocket = init.webSocket;
  }
  get status() {
    return this.webSocket ? 101 : super.status;
  }
};

/** A Durable Object's state: storage, alarm and hibernatable sockets. */
function state() {
  const storage = new Map();
  const sockets = [];
  const pings = new Map();
  const ctx = {
    alarm: null,
    autoResponse: null,
    storage: {
      get: async (key) => structuredClone(storage.get(key)),
      put: async (key, value) => void storage.set(key, structuredClone(value)),
      deleteAll: async () => storage.clear(),
      setAlarm: async (at) => void (ctx.alarm = at),
      deleteAlarm: async () => void (ctx.alarm = null),
    },
    acceptWebSocket: (ws, tags = []) => sockets.push({ ws, tags }),
    getWebSockets: (tag) => sockets.filter((s) => s.ws.readyState !== 3 && (!tag || s.tags.includes(tag))).map((s) => s.ws),
    setWebSocketAutoResponse: (pair) => void (ctx.autoResponse = pair),
    getWebSocketAutoResponseTimestamp: (ws) => pings.get(ws) ?? null,
  };
  return { ctx, storage, pings };
}

/** The ROOMS namespace: one object per name, which a test can evict (hibernation keeps storage and sockets). */
function rooms() {
  const objects = new Map();
  const object = (name) => {
    if (!objects.has(name)) {
      const s = state();
      objects.set(name, { ...s, instance: new Room(s.ctx, {}) });
    }
    return objects.get(name);
  };
  return {
    object,
    idFromName: (name) => name,
    get: (name) => ({ fetch: (input, init) => object(name).instance.fetch(input instanceof Request ? input : new Request(input, init)) }),
    evict: (name) => {
      const o = object(name);
      o.instance = new Room(o.ctx, {});
    },
  };
}

function relay(limits = {}) {
  const ROOMS = rooms();
  const env = { ROOMS, ...limits };
  const call = (path, init = {}) => worker.fetch(new Request(`https://coop.example.com${path}`, { ...init, headers: { 'cf-connecting-ip': '203.0.113.7', ...init.headers } }), env);
  const connect = async (path, headers = {}) => {
    const res = await call(path, { headers: { upgrade: 'websocket', ...headers } });
    return res.status === 101 ? res.webSocket : res.status;
  };
  /** The host joins with its token in the Authorization header. */
  const host = (roomId, token) => connect(`/v1/rooms/${roomId}?role=host`, { authorization: `Bearer ${token}` });
  /** Sends a frame from a client, as the runtime delivers it to the room. */
  const send = (roomId, client, data) => ROOMS.object(roomId).instance.webSocketMessage(client.server, typeof data === 'string' ? data : Uint8Array.from(data).buffer);
  const leave = (roomId, client) => {
    client.server.readyState = 3;
    return ROOMS.object(roomId).instance.webSocketClose(client.server, 1000, '', true);
  };
  return { env, ROOMS, call, connect, host, send, leave };
}

async function made(r) {
  const res = await r.call('/v1/rooms', { method: 'POST' });
  assert.equal(res.status, 201);
  return res.json();
}

test('makes a room and lets its host in only with the token', async () => {
  const r = relay();
  const { roomId, hostToken } = await made(r);
  assert.match(roomId, /^[A-Za-z0-9_-]{22}$/);
  assert.match(hostToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await r.host(roomId, 'x'.repeat(43)), 403);
  assert.equal(await r.connect(`/v1/rooms/${roomId}?role=host`), 403);
  // The token goes in the Authorization header only: in the URL, even the right one is refused.
  assert.equal(await r.connect(`/v1/rooms/${roomId}?role=host&token=${hostToken}`), 400);
  assert.equal(await r.connect(`/v1/rooms/${roomId}?role=host&token=${hostToken}`, { authorization: `Bearer ${hostToken}` }), 400);
  const host = await r.host(roomId, hostToken);
  assert.equal(host.received[0].t, 'welcome');
  assert.deepEqual(host.received[0].slots, []);
  // Pings are answered by the runtime, without waking the room.
  assert.deepEqual([r.ROOMS.object(roomId).ctx.autoResponse.request, r.ROOMS.object(roomId).ctx.autoResponse.response], ['ping', 'pong']);
});

test('routes frames between guests and the host by slot, and tells each about the other', async () => {
  const r = relay();
  const { roomId, hostToken } = await made(r);
  const guest = await r.connect(`/v1/rooms/${roomId}?role=guest`);
  assert.deepEqual(guest.received[0], { t: 'welcome', role: 'guest', room: roomId, slot: 1, host: false, limits: guest.received[0].limits });
  const host = await r.host(roomId, hostToken);
  assert.deepEqual(host.received[0].slots, [1]);
  assert.deepEqual(guest.received.at(-1), { t: 'host', present: true });
  await r.send(roomId, guest, [5, 6]);
  assert.deepEqual(host.received.at(-1), [1, 5, 6]);
  await r.send(roomId, host, [1, 9]);
  assert.deepEqual(guest.received.at(-1), [9]);
  await r.leave(roomId, guest);
  assert.deepEqual(host.received.at(-1), { t: 'left', slot: 1 });
});

test('picks a room up again after hibernation, from its storage and its sockets', async () => {
  const r = relay();
  const { roomId, hostToken } = await made(r);
  const host = await r.host(roomId, hostToken);
  const guest = await r.connect(`/v1/rooms/${roomId}?role=guest`);
  r.ROOMS.evict(roomId);
  await r.send(roomId, guest, [1]);
  assert.deepEqual(host.received.at(-1), [1, 1]);
  // The slot counter came back too: the next guest gets 2.
  const second = await r.connect(`/v1/rooms/${roomId}?role=guest`);
  assert.equal(second.received[0].slot, 2);
});

test('lets the host remove a guest, and keeps a removed socket out of the room after hibernation', async () => {
  const r = relay();
  const { roomId, hostToken } = await made(r);
  const host = await r.host(roomId, hostToken);
  const guest = await r.connect(`/v1/rooms/${roomId}?role=guest`);
  // Closing, but not closed yet: the runtime would still list it.
  guest.server.close = function (code, reason) {
    guest.closed = { code, reason };
  };
  await r.send(roomId, host, JSON.stringify({ t: 'kick', slot: 1, code: 4011 }));
  assert.equal(guest.closed.code, 4011);
  r.ROOMS.evict(roomId);
  await r.send(roomId, host, [1, 2]);
  assert.equal(guest.received.some((f) => Array.isArray(f) && f[0] === 2), false);
});

test('refuses requests it cannot serve, before any upgrade', async () => {
  const limited = { limit: async ({ key }) => ({ success: key !== '203.0.113.7' }) };
  const r = relay();
  const { roomId } = await made(r);
  assert.equal(await r.connect('/v1/rooms/AAAAAAAAAAAAAAAAAAAAAA?role=guest'), 404);
  assert.equal(await r.connect('/v1/rooms/not-a-room?role=guest'), 404);
  assert.equal(await r.connect(`/v1/rooms/${roomId}?role=admin`), 400);
  assert.equal((await r.call(`/v1/rooms/${roomId}`)).status, 426);
  assert.equal((await r.call(`/v1/rooms/${roomId}`, { method: 'PUT' })).status, 405);
  assert.equal((await r.call('/v1/other')).status, 404);
  assert.equal((await r.call('/v1/rooms')).status, 405);
  assert.equal(await (await r.call('/')).text(), 'Atelier co-op relay\n');
  const throttled = relay({ JOIN_LIMITER: limited, CREATE_LIMITER: limited });
  assert.equal((await throttled.call('/v1/rooms', { method: 'POST' })).status, 429);
  assert.equal(await throttled.connect(`/v1/rooms/${roomId}?role=guest`), 429);
  // A full room: the host plus three guests.
  for (let i = 0; i < 3; i++) assert.notEqual(typeof (await r.connect(`/v1/rooms/${roomId}?role=guest`)), 'number');
  assert.equal(await r.connect(`/v1/rooms/${roomId}?role=guest`), 409);
});

test('deletes a room with its token, closing every socket', async () => {
  const r = relay();
  const { roomId, hostToken } = await made(r);
  const guest = await r.connect(`/v1/rooms/${roomId}?role=guest`);
  const del = (token) => r.call(`/v1/rooms/${roomId}`, { method: 'DELETE', headers: token ? { authorization: `Bearer ${token}` } : {} });
  assert.equal((await del()).status, 403);
  assert.equal((await del(hostToken)).status, 204);
  assert.equal(guest.closed.code, 4004);
  assert.equal(r.ROOMS.object(roomId).storage.size, 0);
  assert.equal(r.ROOMS.object(roomId).ctx.alarm, null);
  assert.equal((await del(hostToken)).status, 404);
});

test('closes a room whose host never connected an hour after it was made, and not one whose host did', async () => {
  const hour = 60 * 60 * 1000;
  const r = relay();
  const before = Date.now();
  const unclaimed = await made(r);
  const claimed = await made(r);
  const after = Date.now();
  const o = r.ROOMS.object(unclaimed.roomId);
  // The new room's alarm is its hour.
  assert.ok(o.ctx.alarm >= before + hour && o.ctx.alarm <= after + hour);
  const waiting = await r.connect(`/v1/rooms/${unclaimed.roomId}?role=guest`);
  const realNow = Date.now;
  try {
    Date.now = () => after + 50 * 60 * 1000;
    const host = await r.host(claimed.roomId, claimed.hostToken);
    await r.leave(claimed.roomId, host);
    Date.now = () => after + hour + 10;
    o.pings.set(waiting.server, new Date(Date.now()));
    await o.instance.alarm();
    assert.equal(waiting.closed.code, 4004);
    assert.equal(o.storage.size, 0);
    // The other room's host came at 50 minutes: it lasts a day from when the host left.
    const other = r.ROOMS.object(claimed.roomId);
    await other.instance.alarm();
    assert.equal(other.storage.size, 1);
    assert.ok(other.ctx.alarm >= after + 50 * 60 * 1000 + 24 * hour);
    assert.notEqual(typeof (await r.connect(`/v1/rooms/${claimed.roomId}?role=guest`)), 'number');
  } finally {
    Date.now = realNow;
  }
});

test('closes a room 24 hours after its host left, on the alarm', async () => {
  const r = relay();
  const { roomId, hostToken } = await made(r);
  const o = r.ROOMS.object(roomId);
  const host = await r.host(roomId, hostToken);
  const guest = await r.connect(`/v1/rooms/${roomId}?role=guest`);
  const left = Date.now();
  await r.leave(roomId, host);
  const realNow = Date.now;
  try {
    // The guest keeps pinging (answered by the runtime), so only the expiry closes it.
    Date.now = () => left + 24 * 60 * 60 * 1000 - 1000;
    o.pings.set(guest.server, new Date(Date.now()));
    await o.instance.alarm();
    assert.equal(guest.closed, null);
    assert.ok(o.ctx.alarm <= left + 24 * 60 * 60 * 1000 + 1000);
    Date.now = () => left + 24 * 60 * 60 * 1000 + 10;
    o.pings.set(guest.server, new Date(Date.now()));
    await o.instance.alarm();
    assert.equal(guest.closed.code, 4004);
    assert.equal(o.storage.size, 0);
  } finally {
    Date.now = realNow;
  }
});
