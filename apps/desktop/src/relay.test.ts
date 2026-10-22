import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backoff, createRelay, DESKTOP_USER_AGENT } from './relay.ts';

class FakePort extends EventEmitter {
  posted: unknown[] = [];
  closed = false;
  postMessage(message: unknown) {
    this.posted.push(message);
  }
  start() {}
  close() {
    this.closed = true;
  }
  /** A message from the renderer. */
  send(data: unknown) {
    this.emit('message', { data });
  }
}

class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}
  send(text: string) {
    this.sent.push(text);
  }
  close() {
    this.closed = true;
    this.onclose?.();
  }
}

let sockets: FakeSocket[];
const relay = () =>
  createRelay('https://atelier.example.com/base', (url, headers) => {
    const s = new FakeSocket(url, headers);
    sockets.push(s);
    return s as unknown as WebSocket;
  });
const link = (r: ReturnType<typeof relay>, token?: string) => {
  const port = new FakePort();
  r.link(port as unknown as Electron.MessagePortMain, token);
  return port;
};

beforeEach(() => {
  sockets = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('relay', () => {
  it('opens the socket under the server URL with the bearer token', async () => {
    link(relay(), 'tok-123');
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0]!.url).toBe('wss://atelier.example.com/base/api/ws');
    expect(sockets[0]!.headers).toEqual({ 'User-Agent': DESKTOP_USER_AGENT, Authorization: 'Bearer tok-123' });
  });

  it('connects without a token, for the sign-in screen', async () => {
    link(relay());
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0]!.headers).toEqual({ 'User-Agent': DESKTOP_USER_AGENT });
  });

  it('holds renderer messages until the socket opens, then frames them as JSON both ways', async () => {
    const port = link(relay());
    port.send({ jsonrpc: '2.0', id: 1, method: 'auth.status', params: {} });
    await vi.advanceTimersByTimeAsync(0);
    const ws = sockets[0]!;
    expect(ws.sent).toEqual([]);
    ws.onopen!();
    expect(ws.sent).toEqual(['{"jsonrpc":"2.0","id":1,"method":"auth.status","params":{}}']);
    port.send({ jsonrpc: '2.0', id: 2, method: 'app.info' });
    expect(ws.sent).toHaveLength(2);

    ws.onmessage!({ data: '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}' });
    ws.onmessage!({ data: 'not json' });
    ws.onmessage!({ data: new ArrayBuffer(4) });
    expect(port.posted).toEqual([{ jsonrpc: '2.0', id: 1, result: { ok: true } }]);
  });

  it('retries a socket that never opened with growing backoff, keeping the port', async () => {
    const port = link(relay());
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.onclose!();
    await vi.advanceTimersByTimeAsync(249);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    sockets[1]!.onclose!();
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(3);
    expect(port.closed).toBe(false);
  });

  it('closes the port when an open socket drops, and waits before the next link connects', async () => {
    const r = relay();
    const port = link(r);
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.onopen!();
    sockets[0]!.onclose!();
    expect(port.closed).toBe(true);

    // The renderer asks again right away; the relay backs off before reconnecting.
    link(r);
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(sockets).toHaveLength(2);

    // A successful open resets the backoff.
    sockets[1]!.onopen!();
    link(r);
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(3);
  });

  it('closes the socket and stops retrying when the renderer goes away', async () => {
    const port = link(relay());
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.onclose!();
    port.emit('close');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sockets).toHaveLength(1);

    const port2 = link(relay());
    await vi.advanceTimersByTimeAsync(0);
    sockets[1]!.onopen!();
    port2.emit('close');
    expect(sockets[1]!.closed).toBe(true);
    expect(port2.closed).toBe(false);
  });
});

describe('relay status', () => {
  it('reports the failures of a socket that never opened, and that it opened at last', async () => {
    const seen: string[] = [];
    const r = createRelay(
      'https://atelier.example.com',
      (url, headers) => {
        const s = new FakeSocket(url, headers);
        sockets.push(s);
        return s as unknown as WebSocket;
      },
      { up: () => seen.push('up'), failed: (n) => seen.push(`failed ${n}`) },
    );
    link(r);
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.onclose!();
    await vi.advanceTimersByTimeAsync(250);
    sockets[1]!.onclose!();
    await vi.advanceTimersByTimeAsync(500);
    sockets[2]!.onopen!();
    expect(seen).toEqual(['failed 1', 'failed 2', 'up']);
  });
});

describe('backoff', () => {
  it('starts immediately, then doubles from 250 ms up to 10 s', () => {
    expect([0, 1, 2, 3, 6, 7, 20].map(backoff)).toEqual([0, 250, 500, 1000, 8000, 10_000, 10_000]);
  });
});
