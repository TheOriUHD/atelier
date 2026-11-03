import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { plainHttpFetch } from './plain-http.ts';

const https = vi.hoisted(() => ({ calls: [] as { url: URL; options: { lookup?: unknown; servername?: string } }[] }));
vi.mock('node:https', () => ({
  request: (url: URL, options: { lookup?: unknown; servername?: string }) => {
    https.calls.push({ url, options });
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void };
    req.end = () => req.emit('error', new Error('stop here'));
    req.destroy = () => {};
    return req;
  },
}));

describe('a pinned HTTPS request', () => {
  it('keeps the URL’s own name, so the certificate is checked for it and SNI and Host are unchanged, and only the lookup is replaced', async () => {
    const fallback = vi.fn(async () => new Response('unpinned'));
    const fetch = plainHttpFetch(fallback, { pinnedOnly: true });
    await expect(fetch('https://docs.example.com/page', { pin: { addresses: [{ address: '93.184.216.34', family: 4 }] } } as RequestInit)).rejects.toBeInstanceOf(TypeError);
    expect(https.calls).toHaveLength(1);
    expect(https.calls[0]!.url.hostname).toBe('docs.example.com');
    // No servername override and no rewritten URL: Node derives SNI and the certificate check from the hostname.
    expect(https.calls[0]!.options.servername).toBeUndefined();
    const lookup = https.calls[0]!.options.lookup as (host: string, options: object, cb: (e: null, a: string, f: number) => void) => void;
    expect(await new Promise((resolve) => lookup('docs.example.com', {}, (_e, address) => resolve(address)))).toBe('93.184.216.34');

    // Without a pin it is the platform's fetch, as before.
    expect(await (await fetch('https://docs.example.com/page', {})).text()).toBe('unpinned');
    expect(https.calls).toHaveLength(1);
  });
});
