import { describe, expect, it, vi } from 'vitest';
import { GUESS_TIMEOUT_MS, healthCheck, resolveConnection, resolveServer } from './server-url.ts';

/** A fetch where only the given origins run an Atelier server; everything else fails like a refused connection. */
function network(...servers: string[]) {
  return vi.fn(async (url: string | URL | Request) => {
    const target = new URL(String(url));
    if (!servers.includes(target.origin)) throw new TypeError('fetch failed');
    return Response.json({ ok: true, app: 'atelier', version: '0.1.8' });
  });
}

const resolve = (typed: string, fetchFn: ReturnType<typeof network>) => resolveServer(typed, healthCheck(fetchFn as unknown as typeof fetch));

describe('resolveServer', () => {
  it('tries https first for an address without a scheme', async () => {
    const fetchFn = network('https://atelier.example.com');
    expect(await resolve(' atelier.example.com/ ', fetchFn)).toEqual({ mode: 'server', serverUrl: 'https://atelier.example.com' });
    expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual(['https://atelier.example.com/api/health']);
  });

  it('falls back to http when https doesn’t answer, and keeps the port and path', async () => {
    const fetchFn = network('http://192.168.77.25:7340');
    expect(await resolve('192.168.77.25:7340', fetchFn)).toEqual({ mode: 'server', serverUrl: 'http://192.168.77.25:7340' });
    expect(await resolve('192.168.77.25:7340/atelier/', network('http://192.168.77.25:7340'))).toEqual({ mode: 'server', serverUrl: 'http://192.168.77.25:7340/atelier' });
    expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual(['https://192.168.77.25:7340/api/health', 'http://192.168.77.25:7340/api/health']);
  });

  it('gives each guess a few seconds', async () => {
    const answers = vi.fn(async () => false);
    await expect(resolveServer('nas:7340', answers)).rejects.toThrow('No Atelier server answered at nas:7340, over https:// or http://.');
    expect(answers.mock.calls).toEqual([
      ['https://nas:7340', GUESS_TIMEOUT_MS],
      ['http://nas:7340', GUESS_TIMEOUT_MS],
    ]);
  });

  it('only tries https for a public host, where plain http isn’t allowed', async () => {
    const fetchFn = network('http://atelier.example.com');
    await expect(resolve('atelier.example.com', fetchFn)).rejects.toThrow('No Atelier server answered at https://atelier.example.com.');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('takes a typed scheme as it is', async () => {
    const fetchFn = network('http://localhost:7340');
    expect(await resolve('http://localhost:7340/', fetchFn)).toEqual({ mode: 'server', serverUrl: 'http://localhost:7340' });
    await expect(resolve('https://localhost:7340', fetchFn)).rejects.toThrow('No Atelier server answered at https://localhost:7340.');
    await expect(resolve('http://example.com', fetchFn)).rejects.toThrow(/Use https:\/\//);
    await expect(resolve('ftp://example.com', fetchFn)).rejects.toThrow('must start with https:// or http://');
  });

  it('accepts only an answer that says it is healthy', async () => {
    const notAtelier = vi.fn(async () => new Response('<html></html>', { status: 200 }));
    await expect(resolveServer('router.lan', healthCheck(notAtelier as unknown as typeof fetch))).rejects.toThrow('No Atelier server answered');
  });

  it('rejects an empty or malformed address', async () => {
    await expect(resolve('  ', network())).rejects.toThrow('Enter the server’s address');
    await expect(resolve('exa mple', network())).rejects.toThrow('Enter the server’s address');
  });
});

describe('resolveConnection', () => {
  it('parses this computer without asking the network', async () => {
    const answers = vi.fn();
    expect(await resolveConnection({ mode: 'local' }, answers)).toEqual({ mode: 'local' });
    expect(answers).not.toHaveBeenCalled();
    await expect(resolveConnection({ mode: 'cloud' }, answers)).rejects.toThrow('Choose this computer or enter a server URL.');
  });

  it('resolves a server address', async () => {
    expect(await resolveConnection({ mode: 'server', serverUrl: 'nas' }, healthCheck(network('http://nas') as unknown as typeof fetch))).toEqual({ mode: 'server', serverUrl: 'http://nas' });
  });
});
