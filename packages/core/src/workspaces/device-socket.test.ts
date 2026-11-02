import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeviceStart, ServerToDevice } from '@atelier/protocol';
import { DeviceLinks } from './device-links.ts';
import { deviceSocket } from './device-socket.ts';

let links: DeviceLinks;
afterEach(() => {
  vi.useRealTimers();
  links?.closeAll();
});

const URL_THERE = 'ws://127.0.0.1:8188/ws?clientId=abc';
const hello = (services: string[]) => ({ t: 'hello', hello: { protocol: 2, app: '0.3.0', services, lending: { scratch: false, ssh: [] }, home: '/Users/ada', sep: '/', os: 'darwin', arch: 'arm64' } });

/** A desktop that answers a `ws` start with `respond`; `say` writes a line of the channel. */
function device(respond: (service: Extract<DeviceStart, { kind: 'ws' }>, say: (message: object | string) => void, close: () => void) => void, services = ['runner', 'http', 'ws']) {
  links = new DeviceLinks(() => {});
  const killed: string[] = [];
  const sent: string[] = [];
  const link = links.attach('ada', 'laptop', {
    send(frame: ServerToDevice) {
      if (frame.t === 'start' && frame.service.kind === 'ws') {
        const channel = frame.channel;
        link.receive(JSON.stringify({ t: 'opened', channel }));
        respond(
          frame.service,
          (message) => link.receive(JSON.stringify({ t: 'line', channel, line: typeof message === 'string' ? message : JSON.stringify(message) })),
          () => link.receive(JSON.stringify({ t: 'closed', channel, reason: 'done' })),
        );
      } else if (frame.t === 'close') killed.push(frame.channel);
      else if (frame.t === 'line') sent.push(frame.line);
    },
    close: () => link.closed(),
  });
  link.receive(JSON.stringify(hello(services)));
  return { killed, sent };
}

const open = (signal = new AbortController().signal, headers?: Record<string, string>) => deviceSocket(links, 'ada', 'laptop', 'comfy', headers)(URL_THERE, signal);

async function readAll(socket: AsyncIterable<string | Uint8Array>) {
  const seen: (string | Uint8Array)[] = [];
  for await (const message of socket) seen.push(message);
  return seen;
}

describe('a WebSocket through a desktop device', () => {
  it('opens there, and carries messages each way', async () => {
    let asked: Extract<DeviceStart, { kind: 'ws' }> | undefined;
    const { sent } = device((service, say, close) => {
      asked = service;
      say({ open: true });
      say({ text: '{"type":"progress"}' });
      say({ binary: Buffer.from([1, 2, 3]).toString('base64') });
      setTimeout(() => {
        say({ close: true });
        close();
      }, 5);
    });
    const socket = await open(undefined, { authorization: 'Bearer own' });
    expect(asked).toEqual({ kind: 'ws', target: 'comfy', url: URL_THERE, headers: { authorization: 'Bearer own' } });
    socket.send('{"hello":1}');
    expect(sent).toEqual(['{"text":"{\\"hello\\":1}"}']);
    const seen = await readAll(socket);
    expect(seen[0]).toBe('{"type":"progress"}');
    expect([...(seen[1] as Uint8Array)]).toEqual([1, 2, 3]);
    expect(seen).toHaveLength(2);
  });

  it('fails cleanly on a desktop too old for it, without asking it anything', async () => {
    let started = false;
    device(() => (started = true), ['runner', 'http']);
    await expect(open()).rejects.toMatchObject({ code: 'unsupported' });
    expect(started).toBe(false);
  });

  it('fails when the device is away', async () => {
    links = new DeviceLinks(() => {});
    await expect(open()).rejects.toMatchObject({ code: 'offline' });
  });

  it('fails with what the device said when it won’t or can’t connect', async () => {
    device((_service, say, close) => {
      say({ error: 'The connection to 127.0.0.1:8188 failed.', code: 'ECONNREFUSED' });
      close();
    });
    await expect(open()).rejects.toMatchObject({ message: 'The connection to 127.0.0.1:8188 failed.', code: 'ECONNREFUSED' });
  });

  it('fails when the channel ends without the socket having opened', async () => {
    device((_service, _say, close) => close());
    await expect(open()).rejects.toThrow('ended before it opened');
  });

  it('doesn’t wait forever for a device that says nothing', async () => {
    const { killed } = device(() => {});
    vi.useFakeTimers();
    const failed = open().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await failed).toMatchObject({ message: expect.stringContaining('in time') });
    expect(killed).toHaveLength(1);
  });

  it('takes nothing for a socket until the device says it opened, and drops what it can’t read', async () => {
    device((_service, say, close) => {
      say({ text: 'too early' });
      say('not json');
      say({ text: 1 });
      say({ open: true, extra: true });
      say({ open: true });
      say('{"also":"wrong"}');
      say({ text: 'in order' });
      close();
    });
    expect(await readAll(await open())).toEqual(['in order']);
  });

  it('throws what went wrong once the messages before it are read', async () => {
    device((_service, say, close) => {
      say({ open: true });
      say({ text: 'kept' });
      say({ error: 'That message is too large for the link.', code: 'too_large' });
      close();
    });
    const seen: unknown[] = [];
    await expect(
      (async () => {
        for await (const message of await open()) seen.push(message);
      })(),
    ).rejects.toMatchObject({ code: 'too_large' });
    expect(seen).toEqual(['kept']);
  });

  it('closes on the device when the signal aborts, before or after it opened', async () => {
    const aborted = new AbortController();
    aborted.abort(new Error('stopped'));
    const first = device(() => {});
    await expect(open(aborted.signal)).rejects.toThrow('stopped');
    expect(first.killed).toEqual([]);

    const during = new AbortController();
    let started = false;
    const second = device(() => (started = true));
    const opening = open(during.signal).catch((e: unknown) => e);
    await vi.waitFor(() => expect(started).toBe(true));
    during.abort(new Error('stopped'));
    expect(await opening).toMatchObject({ message: 'stopped' });
    expect(second.killed).toHaveLength(1);

    const whileStarting = new AbortController();
    const starting = device(() => whileStarting.abort(new Error('stopped')));
    await expect(open(whileStarting.signal)).rejects.toThrow('stopped');
    expect(starting.killed).toHaveLength(1);

    const after = new AbortController();
    const third = device((_service, say) => say({ open: true }));
    const socket = await open(after.signal);
    const reading = readAll(socket);
    after.abort();
    expect(await reading).toEqual([]);
    expect(third.killed).toHaveLength(1);
  });

  it('closes on the device when the adapter closes it, and sends nothing after', async () => {
    const { killed, sent } = device((_service, say) => say({ open: true }));
    const socket = await open();
    socket.close();
    socket.send('late');
    expect(killed).toHaveLength(1);
    expect(sent).toEqual([]);
    expect(await readAll(socket)).toEqual([]);
  });

  it('ends a socket whose reader can’t keep up, rather than filling the server’s memory', async () => {
    const big = 'x'.repeat(30 * 1024 * 1024);
    const { killed } = device((_service, say) => {
      say({ open: true });
      for (let i = 0; i < 9; i++) say({ text: big });
    });
    const socket = await open();
    await expect(readAll(socket)).rejects.toThrow('Too much');
    expect(killed).toHaveLength(1);
  });
});
