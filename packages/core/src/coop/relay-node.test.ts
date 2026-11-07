import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { attachCoopRelay, startCoopRelay, type StandaloneCoopRelay } from './relay-node.ts';
import { CloseCode } from './relay-protocol.ts';

const open: { close(): Promise<void> | void }[] = [];
afterEach(async () => {
  for (const thing of open.splice(0).reverse()) await thing.close();
});

async function relay(options: Parameters<typeof startCoopRelay>[0] = { port: 0 }) {
  const started = await startCoopRelay(options);
  open.push(started);
  return started;
}

const post = (base: string) => fetch(`${base}/v1/rooms`, { method: 'POST' });

/** The HTTP status of a refused upgrade, or 101 and the first text frame. */
function connect(url: string, headers: Record<string, string> = {}): Promise<{ status: number; first?: unknown; ws?: WebSocket }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.once('message', (data) => resolve({ status: 101, first: JSON.parse(data.toString()), ws }));
    ws.once('error', (error) => resolve({ status: Number(/(\d{3})/.exec(error.message)?.[1] ?? 0) }));
  });
}

async function room(r: StandaloneCoopRelay) {
  return (await (await post(r.url)).json()) as { roomId: string; hostToken: string };
}

const wsUrl = (r: StandaloneCoopRelay, path: string) => `${r.url.replace('http', 'ws')}${path}`;

describe('the Node co-op relay', () => {
  it('makes rooms and answers the other HTTP requests', async () => {
    const r = await relay({ port: 0, limits: { createsPerMinute: 2 } });
    expect(await (await fetch(r.url)).text()).toBe('Atelier co-op relay\n');
    const res = await post(r.url);
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const made = (await res.json()) as { roomId: string; hostToken: string };
    expect(made.roomId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(made.hostToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.rooms).toBe(1);
    expect((await post(r.url)).status).toBe(201);
    expect((await post(r.url)).status).toBe(429);
    expect((await fetch(`${r.url}/v1/rooms/${made.roomId}`)).status).toBe(426);
    expect((await fetch(`${r.url}/v1/rooms/${made.roomId}`, { method: 'PUT' })).status).toBe(405);
    expect((await fetch(`${r.url}/v2/rooms`)).status).toBe(404);
  });

  it('deletes a room only with its host token', async () => {
    const r = await relay();
    const { roomId, hostToken } = await room(r);
    const del = (token?: string, id = roomId) => fetch(`${r.url}/v1/rooms/${id}`, { method: 'DELETE', headers: token ? { authorization: `Bearer ${token}` } : {} });
    expect((await del()).status).toBe(403);
    expect((await del('x'.repeat(43))).status).toBe(403);
    expect((await del(hostToken, 'A'.repeat(22))).status).toBe(404);
    const guest = await connect(wsUrl(r, `/v1/rooms/${roomId}?role=guest`));
    const closed = new Promise<number>((resolve) => guest.ws!.once('close', (code) => resolve(code)));
    expect((await del(hostToken)).status).toBe(204);
    expect(await closed).toBe(CloseCode.roomClosed);
    expect(r.rooms).toBe(0);
    expect((await del(hostToken)).status).toBe(404);
  });

  it('refuses upgrades before they happen, with a status', async () => {
    const r = await relay({ port: 0, limits: { joinsPerMinute: 5 } });
    const { roomId, hostToken } = await room(r);
    const hostUrl = wsUrl(r, `/v1/rooms/${roomId}?role=host`);
    expect((await connect(wsUrl(r, '/v1/rooms/AAAAAAAAAAAAAAAAAAAAAA?role=guest'))).status).toBe(404);
    expect((await connect(wsUrl(r, `/v1/rooms/${roomId}?role=admin`))).status).toBe(400);
    // The host token goes in the Authorization header only: in the URL, even the right one is refused.
    expect((await connect(wsUrl(r, `/v1/rooms/${roomId}?role=host&token=${hostToken}`))).status).toBe(400);
    expect((await connect(wsUrl(r, `/v1/rooms/${roomId}?role=host&token=${hostToken}`), { authorization: `Bearer ${hostToken}` })).status).toBe(400);
    expect((await connect(hostUrl, { authorization: `Bearer ${'x'.repeat(43)}` })).status).toBe(403);
    expect((await connect(hostUrl)).status).toBe(403);
    const host = await connect(hostUrl, { authorization: `Bearer ${hostToken}` });
    expect(host.status).toBe(101);
    expect(host.first).toMatchObject({ t: 'welcome', role: 'host', room: roomId, slots: [] });
    host.ws!.close();
    // Five attempts from this address in the minute (the 404, the two 403s, the host and a guest; a bad request
    // isn't one): the sixth waits.
    expect((await connect(wsUrl(r, `/v1/rooms/${roomId}?role=guest`))).status).toBe(101);
    expect((await connect(wsUrl(r, `/v1/rooms/${roomId}?role=guest`))).status).toBe(429);
  });

  it('counts the address that `clientIp` names', async () => {
    const r = await relay({ port: 0, limits: { joinsPerMinute: 1 }, clientIp: (req) => String(req.headers['x-forwarded-for'] ?? 'none') });
    const { roomId } = await room(r);
    const url = wsUrl(r, `/v1/rooms/${roomId}?role=guest`);
    expect((await connect(url, { 'x-forwarded-for': '203.0.113.1' })).status).toBe(101);
    expect((await connect(url, { 'x-forwarded-for': '203.0.113.1' })).status).toBe(429);
    expect((await connect(url, { 'x-forwarded-for': '203.0.113.2' })).status).toBe(101);
  });

  it("answers pings, and routes frames between a guest and the host", async () => {
    const r = await relay();
    const { roomId, hostToken } = await room(r);
    const host = await connect(wsUrl(r, `/v1/rooms/${roomId}?role=host`), { authorization: `Bearer ${hostToken}` });
    const guest = await connect(wsUrl(r, `/v1/rooms/${roomId}?role=guest`));
    expect(guest.first).toMatchObject({ t: 'welcome', role: 'guest', slot: 1, host: true });
    const frames: unknown[] = [];
    host.ws!.on('message', (data, binary) => binary && frames.push([...(data as Buffer)]));
    const atGuest = new Promise<number[]>((resolve) => guest.ws!.on('message', (data, binary) => binary && resolve([...(data as Buffer)])));
    const pong = new Promise<string>((resolve) => guest.ws!.on('message', (data, binary) => !binary && resolve(data.toString())));
    guest.ws!.send('ping');
    expect(await pong).toBe('pong');
    guest.ws!.send(Uint8Array.of(7, 7));
    host.ws!.send(Uint8Array.of(1, 9));
    expect(await atGuest).toEqual([9]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(frames).toEqual([[1, 7, 7]]);
    host.ws!.close();
    guest.ws!.close();
  });
});

describe('attachCoopRelay', () => {
  it("takes its own paths and leaves the server's other requests and upgrades to the listeners it had", async () => {
    const server: Server = createServer((_req, res) => res.end('the app'));
    const others = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => others.handleUpgrade(req, socket, head, (ws) => ws.send('the app socket')));
    const relayHandle = attachCoopRelay(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    open.push({
      async close() {
        await relayHandle.close();
        for (const client of others.clients) client.terminate();
        others.close();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      },
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    expect(await (await fetch(`${base}/somewhere`)).text()).toBe('the app');
    expect(await (await fetch(`${base}/api/coopx`)).text()).toBe('the app');
    const made = await fetch(`${base}/api/coop/v1/rooms`, { method: 'POST' });
    expect(made.status).toBe(201);
    const { roomId } = (await made.json()) as { roomId: string };
    const guest = await connect(`${base.replace('http', 'ws')}/api/coop/v1/rooms/${roomId}?role=guest`);
    expect(guest.first).toMatchObject({ t: 'welcome', role: 'guest' });
    guest.ws!.close();
    const app = await new Promise<string>((resolve) => new WebSocket(`${base.replace('http', 'ws')}/other`).once('message', (data) => resolve(data.toString())));
    expect(app).toBe('the app socket');
  });
});
