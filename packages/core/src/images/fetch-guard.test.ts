import { describe, expect, it, vi } from 'vitest';
import { guardedImageFetch } from './fetch-guard.ts';

const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });
const init = { method: 'POST', headers: { authorization: 'Bearer secret' }, body: '{}' };

describe('guardedImageFetch', () => {
  it('asks not to be redirected by the fetch underneath, which would take the key along', async () => {
    const inner = vi.fn(async (_url: string, _init: RequestInit) => new Response('ok'));
    await guardedImageFetch(inner)('https://api.example.com/a', init);
    expect(inner.mock.calls[0]?.[1].redirect).toBe('manual');
  });

  it('refuses a redirect to another host, and never calls it', async () => {
    const inner = vi.fn(async () => redirect('http://169.254.169.254/latest/meta-data/'));
    await expect(guardedImageFetch(inner)('https://api.example.com/a', init)).rejects.toThrow('another host');
    expect(inner).toHaveBeenCalledOnce();
  });

  it('follows one on the same host, as a GET after a POST', async () => {
    const inner = vi.fn(async (url: string, _init: RequestInit) => (url.endsWith('/a') ? redirect('/b') : new Response('there')));
    const res = await guardedImageFetch(inner)('https://api.example.com/a', init);
    expect(await res.text()).toBe('there');
    expect(inner.mock.calls[1]?.[0]).toBe('https://api.example.com/b');
    expect(inner.mock.calls[1]?.[1]).toMatchObject({ method: 'GET', body: null });
  });

  it('stops following a chain', async () => {
    await expect(guardedImageFetch(async () => redirect('/again'))('https://api.example.com/a', init)).rejects.toThrow('Too many');
  });

  it('treats a port as another host', async () => {
    await expect(guardedImageFetch(async () => redirect('http://127.0.0.1:9000/x'))('http://127.0.0.1:8188/a', init)).rejects.toThrow('another host');
  });

  it('cuts off an answer that keeps coming', async () => {
    const endless = new ReadableStream<Uint8Array>({ pull: (c) => c.enqueue(new Uint8Array(4096)) });
    const res = await guardedImageFetch(async () => new Response(endless), 100_000)('https://api.example.com/a', init);
    await expect(res.arrayBuffer()).rejects.toThrow('too large');
  });

  it('leaves an answer within the limit as it is', async () => {
    const res = await guardedImageFetch(async () => new Response('fine', { status: 418 }))('https://api.example.com/a', init);
    expect(res.status).toBe(418);
    expect(await res.text()).toBe('fine');
  });

  it('copes with an answer that has no body', async () => {
    const res = await guardedImageFetch(async () => new Response(null, { status: 204 }))('https://api.example.com/a', init);
    expect(res.status).toBe(204);
  });
});
