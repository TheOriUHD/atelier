/**
 * A socket from the server's end to a real WebSocket server, through everything between: `deviceSocket`, `DeviceLinks`,
 * the link's frames (as JSON, through both ends' schemas), `createDeviceLink` and `deviceServices`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NO_LENDING, type DeviceLending } from '@atelier/protocol';
import { DeviceLinks } from '../workspaces/device-links.ts';
import { deviceSocket } from '../workspaces/device-socket.ts';
import { createDeviceLink } from './link.ts';
import { deviceServices } from './services.ts';
import { readLending } from './lending.ts';
import { wsServer, type WsServer } from './__fixtures__/ws-server.ts';

const SERVER = 'https://atelier.example.com';
const device = { id: '6f1c2c8e-8a39-4a8e-9d55-0f0b6f5f6d7a', name: 'Laptop', platform: 'macOS' };

let dir: string;
let file: string;
let target: WsServer;
let links: DeviceLinks;
let stop: () => void;

const write = (lending: Partial<DeviceLending>) => writeFileSync(file, JSON.stringify({ [SERVER]: { ...NO_LENDING, ...lending } }));

/** A desktop signed in to `links`, lending by what `lending.json` says, as `remote.ts` wires it. */
function connect() {
  const services = deviceServices({ deviceName: 'Laptop', lending: () => readLending(file, SERVER), scratchDir: join(dir, 'scratch'), runnerDir: null, ssh: 'ssh', sshDir: join(dir, 'ssh'), home: dir });
  const desktop = createDeviceLink({
    serverUrl: SERVER,
    device,
    runnerBinary: null,
    trustedFolders: async () => [],
    services,
    openSocket: () => {
      const socket = {
        readyState: WebSocket.OPEN as number,
        onopen: null as (() => void) | null,
        onmessage: null as ((event: { data: string }) => void) | null,
        onclose: null as ((event: { code: number }) => void) | null,
        send: (text: string) => void queueMicrotask(() => link.receive(text)),
        close: () => {
          socket.readyState = WebSocket.CLOSED;
          socket.onclose?.({ code: 1000 });
        },
      };
      const link = links.attach('ada', device.id, {
        send: (frame) => queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify(frame) })),
        close: () => {
          link.closed();
          socket.close();
        },
      });
      queueMicrotask(() => socket.onopen?.());
      return socket as unknown as WebSocket;
    },
  });
  desktop.setToken('tok');
  stop = () => desktop.close();
  return desktop;
}

const open = (signal = new AbortController().signal, url = `${target.ws}/ws?clientId=1`, id = 'comfy') => deviceSocket(links, 'ada', device.id, id)(url, signal);
/** Until the desktop said what it lends. */
const ready = () => expect.poll(() => links.info('ada', device.id)?.services).toContain('ws');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'atelier-device-socket-'));
  file = join(dir, 'lending.json');
  target = await wsServer();
  links = new DeviceLinks(() => {});
  stop = () => {};
});
afterEach(async () => {
  stop();
  links.closeAll();
  await target.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('a socket from the server to an address a desktop lent', () => {
  it('carries messages both ways through the real link', async () => {
    write({ http: [{ id: 'comfy', baseUrl: target.http }] });
    connect();
    await ready();
    const socket = await open();
    await expect.poll(() => target.clients.length).toBe(1);
    const client = target.clients[0]!;
    expect(client.url).toBe('/ws?clientId=1');
    client.text('{"type":"progress","data":{"value":3,"max":8}}');
    client.binary(Buffer.from([0, 0, 0, 1, 0xff, 0xd8]));
    socket.send('{"hello":true}');
    await expect.poll(() => client.received).toEqual(['{"hello":true}']);
    client.close();
    const seen: (string | Uint8Array)[] = [];
    for await (const message of socket) seen.push(message);
    expect(seen[0]).toBe('{"type":"progress","data":{"value":3,"max":8}}');
    expect([...(seen[1] as Uint8Array)]).toEqual([0, 0, 0, 1, 0xff, 0xd8]);
  });

  it('never reaches an address that wasn’t lent, and the call fails cleanly', async () => {
    write({ http: [{ id: 'comfy', baseUrl: `http://127.0.0.1:${target.port + 1}` }] });
    connect();
    await ready();
    await expect(open()).rejects.toMatchObject({ code: 'refused', message: "Laptop doesn't lend that address." });
    await expect(open(undefined, undefined, 'unknown')).rejects.toMatchObject({ code: 'refused' });
    expect(target.requests).toEqual([]);
  });

  it('ends on the server’s side when the person takes the address back', async () => {
    write({ http: [{ id: 'comfy', baseUrl: target.http }] });
    const desktop = connect();
    await ready();
    const socket = await open();
    await expect.poll(() => target.clients.length).toBe(1);
    write({ http: [] });
    desktop.lendingChanged();
    await expect((async () => {
      for await (const _ of socket) void _;
    })()).rejects.toMatchObject({ code: 'refused' });
    await target.clients[0]!.closed;
  });

  it('closes there when the server stops', async () => {
    write({ http: [{ id: 'comfy', baseUrl: target.http }] });
    connect();
    await ready();
    const abort = new AbortController();
    await open(abort.signal);
    await expect.poll(() => target.clients.length).toBe(1);
    abort.abort();
    await target.clients[0]!.closed;
  });

  it('closes there when the link drops', async () => {
    write({ http: [{ id: 'comfy', baseUrl: target.http }] });
    connect();
    await ready();
    await open();
    await expect.poll(() => target.clients.length).toBe(1);
    links.closeAll();
    await target.clients[0]!.closed;
  });
});
