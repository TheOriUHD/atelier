/**
 * Where WebFetch may connect (SSRF guard). Model-chosen URLs never reach this machine, the cloud metadata
 * endpoint or (unless allowed) private networks: a prompt-injected page must not be able to make the
 * model read LAN services or Atelier's own API. Checked on every resolved address before fetching.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type Lookup = (host: string) => Promise<string[]>;

export const systemLookup: Lookup = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** Why the address is off limits, or null. */
export function blockedAddress(ip: string, allowPrivate: boolean): string | null {
  const v4 = toV4(ip);
  if (v4) {
    const [a, b] = v4;
    if (a === 127 || a === 0) return 'this machine';
    if (a === 169 && b === 254) return 'a link-local address (cloud metadata)';
    if (a >= 224) return 'a multicast or reserved address';
    const isPrivate = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
    return isPrivate && !allowPrivate ? 'a private network address' : null;
  }
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return 'this machine';
  if (/^fe[89ab]/.test(lower)) return 'a link-local address';
  if (/^f[cd]/.test(lower)) return allowPrivate ? null : 'a private network address';
  if (/^ff/.test(lower)) return 'a multicast address';
  return null;
}

/** Throws a readable error when any address the host resolves to is off limits. */
export async function assertPublicHost(host: string, allowPrivate: boolean, resolve: Lookup = systemLookup): Promise<void> {
  const bare = host.replace(/^\[|\]$/g, '');
  const addresses = isIP(bare) ? [bare] : await resolve(bare).catch(() => {
    throw new Error(`Can't resolve ${host}.`);
  });
  for (const ip of addresses) {
    const reason = blockedAddress(ip, allowPrivate);
    if (reason) throw new Error(`${host} resolves to ${reason}, which WebFetch may not access.`);
  }
}

/** IPv4 octets, including IPv4-mapped IPv6 (::ffff:10.0.0.1). */
function toV4(ip: string): [number, number, number, number] | null {
  const m = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(ip);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : null;
}
