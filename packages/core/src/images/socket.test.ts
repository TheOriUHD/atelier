import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { openSocket } from './socket.ts';

/** Accepts connections and never answers the WebSocket handshake. */
async function silentServer(): Promise<{ url: string; server: Server; sockets: Socket[] }> {
  const sockets: Socket[] = [];
  const server = createServer((socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`, server, sockets };
}

describe('openSocket', () => {
  let open: Awaited<ReturnType<typeof silentServer>> | undefined;

  afterEach(async () => {
    for (const socket of open?.sockets ?? []) socket.destroy();
    await new Promise((resolve) => (open ? open.server.close(resolve) : resolve(undefined)));
    open = undefined;
  });

  it('gives up when stopped while it is still connecting', async () => {
    open = await silentServer();
    const stop = new AbortController();
    const opening = openSocket(open.url, stop.signal);
    await expect.poll(() => open?.sockets.length).toBe(1);
    stop.abort(new Error('took too long'));
    await expect(opening).rejects.toThrow();
  });

  it('refuses at once when already stopped', async () => {
    const stop = new AbortController();
    stop.abort(new Error('stopped'));
    await expect(openSocket('ws://127.0.0.1:9/ws', stop.signal)).rejects.toThrow();
  });
});
