/**
 * DNS rebinding: the address guard checks what a name resolves to, and the request must then connect to those addresses,
 * not to a second answer. A lookup that changes its answer between calls stands in for the attacker's DNS server; the name
 * used here ("rebind.test") doesn't resolve anywhere, so only a pinned connection can reach the local server.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { downloadImage } from '../images/download.ts';
import { plainHttpFetch } from '../providers/plain-http.ts';
import { createExcerptReader } from '../search/excerpt.ts';
import { pinnedLookup, resolvePublicHost, type Pin } from './address-guard.ts';
import { createWebFetchTool } from './web-fetch.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const ARTICLE =
  '<html><head><title>Tides</title></head><body><article><h1>Tides</h1>' +
  '<p>The tide rises and falls twice a day because the moon pulls on the sea, and the sun pulls a little too, which is why spring tides come at full and new moon.</p>' +
  '<p>Where the coast narrows, as in a funnel shaped bay, the water is squeezed and the range grows far beyond what the open ocean sees at the same hour.</p>' +
  '</article></body></html>';

/**
 * This computer's own address on a network, which the guard lets through with private networks allowed (it refuses
 * loopback), so a name can be checked at an address the test's server really listens on. None: those tests are skipped.
 */
const LAN = Object.values(networkInterfaces())
  .flatMap((list) => list ?? [])
  .find((a) => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))?.address;

let server: Server;
let port: number;
const hosts: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    hosts.push(req.headers.host ?? '');
    if (req.url === '/image') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG);
    } else if (req.url === '/redirect') {
      res.writeHead(302, { location: `http://169.254.169.254/latest/meta-data/` });
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(ARTICLE);
    }
  });
  await new Promise<void>((r) => server.listen(0, '0.0.0.0', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

/** What `fetch` would be without the pin: it would resolve the name itself, and this fails the test. */
const unpinned = async (url: string): Promise<Response> => {
  throw new Error(`${url} was fetched without a pin`);
};
const pinnedFetch = plainHttpFetch(unpinned, { pinnedOnly: true });

/** A DNS server that answers the check with `first` and every later question with the metadata address. */
function rebinding(first: string) {
  const asked: string[] = [];
  const lookup = async (host: string) => {
    asked.push(host);
    return asked.length === 1 ? [first] : ['169.254.169.254'];
  };
  return { lookup, asked };
}

describe('the address guard pins what it checked', () => {
  it('returns the checked addresses and refuses a name when any answer is off limits', async () => {
    expect(await resolvePublicHost('example.test', false, async () => ['93.184.216.34', '2606:2800:220:1::1'])).toEqual({
      addresses: [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1::1', family: 6 },
      ],
    });
    await expect(resolvePublicHost('example.test', false, async () => ['93.184.216.34', '10.0.0.5'])).rejects.toThrow('a private network address');
    await expect(resolvePublicHost('example.test', false, async () => [])).rejects.toThrow("Can't resolve");
    // An address written into the URL needs no lookup.
    expect(await resolvePublicHost('[2606:2800:220:1::1]', false, async () => Promise.reject(new Error('no lookup')))).toEqual({ addresses: [{ address: '2606:2800:220:1::1', family: 6 }] });
  });

  it('answers the connection’s own lookup with the pinned addresses, whatever name it asks for', async () => {
    const pin: Pin = { addresses: [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }] };
    const lookup = pinnedLookup(pin);
    const all = await new Promise((resolve) => lookup('anything.test', { all: true }, (_e, a) => resolve(a)));
    expect(all).toEqual(pin.addresses);
    const one = await new Promise((resolve) => lookup('anything.test', {}, (_e, address, family) => resolve({ address, family })));
    expect(one).toEqual({ address: '93.184.216.34', family: 4 });
    const six = await new Promise((resolve) => lookup('anything.test', { family: 6, all: true }, (_e, a) => resolve(a)));
    expect(six).toEqual([pin.addresses[1]]);
  });
});

describe('plainHttpFetch with a pin', () => {
  it('connects to the pinned address with the URL’s own name as Host, and leaves unpinned requests to the fallback', async () => {
    const pin: Pin = { addresses: [{ address: '127.0.0.1', family: 4 }] };
    hosts.length = 0;
    const res = await pinnedFetch(`http://rebind.test:${port}/`, { pin } as RequestInit);
    expect(res.status).toBe(200);
    expect(hosts).toEqual([`rebind.test:${port}`]);
    await expect(pinnedFetch(`http://rebind.test:${port}/`, {})).rejects.toThrow('without a pin');
  });

  it('does not follow a redirect it was pinned for: the next host would not be checked', async () => {
    const pin: Pin = { addresses: [{ address: '127.0.0.1', family: 4 }] };
    const res = await pinnedFetch(`http://rebind.test:${port}/redirect`, { pin } as RequestInit);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://169.254.169.254/latest/meta-data/');
  });
});

describe.skipIf(!LAN)('a name that changes its answer after the check', () => {
  it('WebFetch connects to the checked address and asks DNS once', async () => {
    const dns = rebinding(LAN!);
    const tool = createWebFetchTool({ fetch: pinnedFetch, allowPrivateNetworks: () => true, lookup: dns.lookup, summarize: async () => null });
    hosts.length = 0;
    const out = await tool.run({ url: `http://rebind.test:${port}/` }, { sessionId: 's', signal: AbortSignal.timeout(10_000) } as never);
    expect(JSON.stringify(out)).toContain('tide rises and falls');
    expect(dns.asked).toEqual(['rebind.test']);
    expect(hosts).toEqual([`rebind.test:${port}`]);
  });

  it('the search excerpt reader does too', async () => {
    const dns = rebinding(LAN!);
    const read = createExcerptReader({ fetch: pinnedFetch, allowPrivateNetworks: () => true, lookup: dns.lookup });
    const text = await read(`http://rebind.test:${port}/`, 'tides moon', AbortSignal.timeout(10_000));
    expect(text).toContain('tide rises and falls');
    expect(dns.asked).toEqual(['rebind.test']);
  });

  it('so does the download of a hosted service’s image', async () => {
    const dns = rebinding(LAN!);
    const image = await downloadImage({ fetch: pinnedFetch, allowPrivate: true, lookup: dns.lookup }, `http://rebind.test:${port}/image`, AbortSignal.timeout(10_000));
    expect(image.mime).toBe('image/png');
    expect(dns.asked).toEqual(['rebind.test']);
  });

  it('hands every fetch the pin it was checked at, and the pin of each hop of a redirect', async () => {
    const seen: (Pin | undefined)[] = [];
        const fetch = vi.fn(async (url: string, init: { pin?: Pin }) => {
      seen.push(init.pin);
      return url.endsWith('/next') ? new Response(ARTICLE, { headers: { 'content-type': 'text/html' } }) : new Response(null, { status: 302, headers: { location: 'https://a.test/next' } });
    });
    const tool = createWebFetchTool({ fetch, allowPrivateNetworks: () => false, lookup: async () => ['93.184.216.34'], summarize: async () => null });
    await tool.run({ url: 'https://a.test/' }, { sessionId: 's', signal: AbortSignal.timeout(10_000) } as never);
    expect(seen).toEqual([{ addresses: [{ address: '93.184.216.34', family: 4 }] }, { addresses: [{ address: '93.184.216.34', family: 4 }] }]);
  });
});
