import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { localSubnets, scanNetwork, type Interfaces } from './discovery.ts';

const v4 = (address: string, internal = false): NetworkInterfaceInfo => ({
  address,
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac: '00:00:00:00:00:00',
  internal,
  cidr: `${address}/24`,
});
const v6 = (address: string): NetworkInterfaceInfo => ({ address, netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '00:00:00:00:00:00', internal: false, cidr: `${address}/64`, scopeid: 0 });

const HOME: Interfaces = { lo0: [v4('127.0.0.1', true)], en0: [v6('fe80::1'), v4('192.168.77.14')] };

/** Hosts that answer, by origin; every other address fails like a host that isn't there. */
function lan(answers: Record<string, () => Response | Promise<Response>>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const answer = answers[new URL(String(input)).origin];
    if (!answer) throw new TypeError('fetch failed');
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return answer();
  });
}

const atelier = (body: object = { ok: true, app: 'atelier', version: '0.1.8' }) => () => Response.json(body);

describe('localSubnets', () => {
  it('takes the /24 of each private IPv4 address on a real interface', () => {
    expect(localSubnets(HOME)).toEqual(['192.168.77']);
    expect(localSubnets({ en0: [v4('10.1.2.3')], en1: [v4('172.20.0.9')] })).toEqual(['10.1.2', '172.20.0']);
  });

  it('skips loopback, link-local, public, Tailscale and VPN, container and virtual machine networks', () => {
    expect(
      localSubnets({
        lo0: [v4('127.0.0.1', true)],
        en0: [v4('169.254.3.4'), v4('8.8.8.8'), v4('100.101.102.103'), v4('172.32.0.1')],
        utun3: [v4('10.8.0.2')],
        tailscale0: [v4('100.64.0.1')],
        docker0: [v4('172.17.0.1')],
        'br-1a2b': [v4('172.18.0.1')],
        'vEthernet (WSL)': [v4('172.28.16.1')],
        vmnet8: [v4('192.168.99.1')],
        'Wi-Fi': [v4('192.168.1.40')],
      }),
    ).toEqual(['192.168.1']);
  });

  it('keeps the scan small on a computer with many networks', () => {
    expect(localSubnets({ a: [v4('10.0.0.2')], b: [v4('10.0.1.2')], c: [v4('10.0.2.2')] })).toHaveLength(2);
  });
});

describe('scanNetwork', () => {
  it('asks every address of the local /24 on port 7340, and this computer first', async () => {
    const fetchFn = lan({});
    expect(await scanNetwork({ interfaces: HOME, fetch: fetchFn as unknown as typeof fetch })).toEqual([]);
    const urls = fetchFn.mock.calls.map(([url]) => String(url));
    expect(urls).toHaveLength(255);
    expect(urls[0]).toBe('http://127.0.0.1:7340/api/health');
    expect(urls).toContain('http://192.168.77.1:7340/api/health');
    expect(urls).toContain('http://192.168.77.254:7340/api/health');
    expect(urls).not.toContain('http://192.168.77.0:7340/api/health');
    expect(urls).not.toContain('http://192.168.77.255:7340/api/health');
  });

  it('reports Atelier servers as they answer, and nothing else', async () => {
    const onFound = vi.fn();
    const fetchFn = lan({
      'http://127.0.0.1:7340': atelier({ ok: true, app: 'atelier', version: '0.1.8', name: 'Studio' }),
      'http://192.168.77.25:7340': atelier(),
      // An older server says only that it's healthy; a router's page or another app's health check isn't Atelier.
      'http://192.168.77.26:7340': atelier({ ok: true }),
      'http://192.168.77.27:7340': atelier({ ok: true, app: 'other' }),
      'http://192.168.77.28:7340': () => new Response('<html>router</html>'),
      'http://192.168.77.29:7340': () => new Response('{}', { status: 500 }),
      'http://192.168.77.30:7340': () => Response.json({ ok: true, app: 'atelier', padding: 'x'.repeat(5000) }),
    });
    const found = await scanNetwork({ interfaces: HOME, fetch: fetchFn as unknown as typeof fetch, onFound });
    expect(found).toEqual([
      { url: 'http://127.0.0.1:7340', host: 'This computer', version: '0.1.8', name: 'Studio' },
      { url: 'http://192.168.77.25:7340', host: '192.168.77.25:7340', version: '0.1.8', name: null },
    ]);
    expect(onFound.mock.calls.map(([s]) => s)).toEqual(found);
  });

  it('asks only a limited number of addresses at once', async () => {
    let open = 0;
    let most = 0;
    const fetchFn = vi.fn(async () => {
      most = Math.max(most, ++open);
      await new Promise((r) => setTimeout(r, 1));
      open--;
      throw new TypeError('fetch failed');
    });
    await scanNetwork({ interfaces: HOME, fetch: fetchFn as unknown as typeof fetch, concurrency: 16 });
    expect(most).toBe(16);
    expect(fetchFn).toHaveBeenCalledTimes(255);
  });

  it('gives up on hosts that don’t answer, and finishes by the deadline', async () => {
    // Every address hangs until its request is aborted.
    const fetchFn = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    );
    const started = Date.now();
    expect(await scanNetwork({ interfaces: HOME, fetch: fetchFn as unknown as typeof fetch, timeoutMs: 50, deadlineMs: 120, concurrency: 64 })).toEqual([]);
    expect(Date.now() - started).toBeLessThan(400);
    // The deadline stopped the scan before every address was asked.
    expect(fetchFn.mock.calls.length).toBeLessThan(255);
  });
});
