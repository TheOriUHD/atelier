import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { providerInstance } from './__fixtures__/harness.ts';
import { exceptionError } from './http.ts';
import { plainHttpFetch } from './plain-http.ts';

let server: Server;
let base: string;
const unused: (url: string) => Promise<Response> = async () => {
  throw new Error('the fallback should not be used for http');
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      if (req.url === '/api/chat') {
        // Headers only after a pause, then lines with pauses in between, as a model server streams.
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/x-ndjson', 'x-seen': req.headers['x-test'] ?? '' });
          res.write(`${JSON.stringify({ echo: JSON.parse(body) })}\n`);
          setTimeout(() => res.end(`${JSON.stringify({ done: true })}\n`), 30);
        }, 30);
      } else if (req.url === '/gzip') {
        res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'application/json' });
        res.end(gzipSync('{"ok":true}'));
      } else if (req.url === '/hang') {
        res.writeHead(200);
        res.write('first\n');
      } else if (req.url === '/drip') {
        // A line every 60 ms, 5 lines: longer in all than a 150 ms idle limit, never silent that long.
        res.writeHead(200);
        let n = 0;
        const timer = setInterval(() => {
          res.write(`${++n}\n`);
          if (n === 5) {
            clearInterval(timer);
            res.end();
          }
        }, 60);
      } else if (req.url === '/silent') {
        // Never answers.
      } else if (req.url === '/drop') {
        res.writeHead(200);
        res.write('first\n');
        setTimeout(() => res.socket?.destroy(), 20);
      } else if (req.url?.startsWith('/redirect/')) {
        const [, , status, ...to] = req.url.split('/');
        res.writeHead(Number(status), { location: decodeURIComponent(to.join('/')) });
        res.end();
      } else if (req.url === '/loop') {
        res.writeHead(302, { location: '/loop' });
        res.end();
      } else if (req.url === '/echo') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, body }));
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe('plainHttpFetch', () => {
  it('posts a body and streams the response as it comes', async () => {
    const res = await plainHttpFetch(unused)(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test': 'yes' },
      body: '{"model":"m"}',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-seen')).toBe('yes');
    expect(
      (await res.text())
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l)),
    ).toEqual([{ echo: { model: 'm' } }, { done: true }]);
  });

  it('reports statuses and decodes compressed bodies', async () => {
    const fetch = plainHttpFetch(unused);
    const missing = await fetch(`${base}/nope`, {});
    expect([missing.ok, missing.status, await missing.text()]).toEqual([false, 404, 'not found']);
    expect(await (await fetch(`${base}/gzip`, {})).json()).toEqual({ ok: true });
  });

  it('stops on abort, mid-stream too', async () => {
    const controller = new AbortController();
    const res = await plainHttpFetch(unused)(`${base}/hang`, { signal: controller.signal });
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first\n');
    controller.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
    await expect(plainHttpFetch(unused)(`${base}/hang`, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it("ends a body cut off by the server as fetch's retryable TypeError, not as an abort", async () => {
    const res = await plainHttpFetch(unused)(`${base}/drop`, {});
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first\n');
    const error = await reader.read().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe('terminated');
    expect(exceptionError(error, providerInstance('ollama', 'http://localhost:11434'))).toMatchObject({
      code: 'provider_offline',
      retryable: true,
    });
  });

  it('follows redirects as fetch does, handing HTTPS targets to the fallback', async () => {
    const fetch = plainHttpFetch(unused);
    const post = (url: string) => fetch(url, { method: 'POST', body: 'payload' }).then((r) => r.json());
    expect(await post(`${base}/redirect/307/${encodeURIComponent('/echo')}`)).toEqual({
      method: 'POST',
      body: 'payload',
    });
    expect(await post(`${base}/redirect/308/${encodeURIComponent('/echo')}`)).toEqual({
      method: 'POST',
      body: 'payload',
    });
    expect(await post(`${base}/redirect/303/${encodeURIComponent('/echo')}`)).toEqual({ method: 'GET', body: '' });
    expect(await post(`${base}/redirect/302/${encodeURIComponent('/echo')}`)).toEqual({ method: 'GET', body: '' });
    expect(await (await fetch(`${base}/redirect/301/${encodeURIComponent('/echo')}`, {})).json()).toEqual({
      method: 'GET',
      body: '',
    });
    await expect(fetch(`${base}/loop`, {})).rejects.toBeInstanceOf(TypeError);
    expect((await fetch(`${base}/redirect/302/${encodeURIComponent('/echo')}`, { redirect: 'manual' })).status).toBe(
      302,
    );
    const seen: string[] = [];
    const secure = plainHttpFetch(async (url) => (seen.push(url), new Response('secure')));
    expect(
      await (
        await secure(`${base}/redirect/301/${encodeURIComponent('https://models.example.com/api/tags')}`, {})
      ).text(),
    ).toBe('secure');
    expect(seen).toEqual(['https://models.example.com/api/tags']);
  });

  it('ends a request that receives nothing for its idle limit with a retryable no-response error', async () => {
    const fetch = plainHttpFetch(unused, { idleMs: 150 });
    // No headers at all.
    const silent = await fetch(`${base}/silent`, {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(silent).toMatchObject({ name: 'NoResponseError' });
    expect(exceptionError(silent, providerInstance('ollama', 'http://localhost:11434'))).toMatchObject({
      code: 'provider_timeout',
      retryable: true,
    });
    // Headers and a first line, then silence.
    const reader = (await fetch(`${base}/hang`, {})).body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first\n');
    await expect(reader.read()).rejects.toMatchObject({ name: 'NoResponseError' });
    // A stream that keeps sending stays open past the limit.
    expect((await (await fetch(`${base}/drip`, {})).text()).trim().split('\n')).toEqual(['1', '2', '3', '4', '5']);
  });

  it('turns a refused connection into the TypeError fetch throws, and leaves HTTPS to the fallback', async () => {
    await expect(plainHttpFetch(unused)('http://127.0.0.1:1/api/version', {})).rejects.toBeInstanceOf(TypeError);
    const seen: string[] = [];
    const fallback = async (url: string) => (seen.push(url), new Response('ok'));
    expect(await (await plainHttpFetch(fallback)('https://api.example.com/v1/models', {})).text()).toBe('ok');
    expect(seen).toEqual(['https://api.example.com/v1/models']);
  });
});
