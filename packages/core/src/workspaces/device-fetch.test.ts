import { afterEach, describe, expect, it } from 'vitest';
import type { DeviceStart, ServerToDevice } from '@atelier/protocol';
import { deviceFetch } from './device-fetch.ts';
import { DeviceLinks } from './device-links.ts';

let links: DeviceLinks;
afterEach(() => links?.closeAll());

/** A device that answers an `http` start with `respond(service, say)`; `say` writes a line of the channel. */
function device(respond: (service: Extract<DeviceStart, { kind: 'http' }>, say: (message: object) => void, close: () => void) => void) {
  links = new DeviceLinks(() => {});
  const killed: string[] = [];
  const link = links.attach('ada', 'laptop', {
    send(frame: ServerToDevice) {
      if (frame.t === 'start' && frame.service.kind === 'http') {
        const channel = frame.channel;
        link.receive(JSON.stringify({ t: 'opened', channel }));
        respond(
          frame.service,
          (message) => link.receive(JSON.stringify({ t: 'line', channel, line: JSON.stringify(message) })),
          () => link.receive(JSON.stringify({ t: 'closed', channel, reason: 'done' })),
        );
      } else if (frame.t === 'close') killed.push(frame.channel);
    },
    close: () => link.closed(),
  });
  link.receive(JSON.stringify({ t: 'hello', hello: { protocol: 2, app: '0.2.8', services: ['runner', 'http'], lending: { scratch: false, ssh: [] }, home: '/Users/ada', sep: '/', os: 'darwin', arch: 'arm64' } }));
  return { killed };
}

describe('fetch through a desktop device', () => {
  it('sends the request there and streams the answer back', async () => {
    let asked: Extract<DeviceStart, { kind: 'http' }> | undefined;
    device((service, say, close) => {
      asked = service;
      say({ head: { status: 200, headers: { 'content-type': 'application/x-ndjson' } } });
      say({ chunk: Buffer.from('{"a":1}\n').toString('base64') });
      setTimeout(() => {
        say({ chunk: Buffer.from('{"b":2}\n').toString('base64') });
        close();
      }, 5);
    });
    const fetchThere = deviceFetch(links, 'ada', 'laptop', 'ollama');
    const response = await fetchThere('http://localhost:11434/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"m"}' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/x-ndjson');
    expect(await response.text()).toBe('{"a":1}\n{"b":2}\n');
    expect(asked).toMatchObject({ kind: 'http', target: 'ollama', method: 'POST', url: 'http://localhost:11434/api/chat', headers: { 'content-type': 'application/json' } });
    expect(Buffer.from(asked!.body!, 'base64').toString()).toBe('{"model":"m"}');
  });

  it('fails like an unreachable server when the request fails there or the device refuses', async () => {
    device((_service, say, close) => {
      say({ error: 'connect ECONNREFUSED 127.0.0.1:11434' });
      close();
    });
    const error = await deviceFetch(links, 'ada', 'laptop', 'ollama')('http://localhost:11434/api/tags').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error & { cause: Error }).cause.message).toContain('ECONNREFUSED');
    await expect(deviceFetch(links, 'ada', 'pc', 'ollama')('http://localhost:11434/api/tags')).rejects.toThrow('fetch failed');
  });

  it('cancels it on the device when the request is aborted', async () => {
    const { killed } = device((_service, say) => say({ head: { status: 200, headers: {} } }));
    const abort = new AbortController();
    const response = await deviceFetch(links, 'ada', 'laptop', 'ollama')('http://localhost:11434/api/chat', { signal: abort.signal });
    const reading = response.text().catch((e: unknown) => e);
    abort.abort();
    expect(await reading).toBeInstanceOf(Error);
    expect(killed).toHaveLength(1);
  });

  it('has no body for HEAD and no-content answers', async () => {
    device((_service, say, close) => {
      say({ head: { status: 204, headers: {} } });
      close();
    });
    const response = await deviceFetch(links, 'ada', 'laptop', 'ollama')('http://localhost:11434/x', { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });
});
