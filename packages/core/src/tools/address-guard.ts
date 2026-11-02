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
  const dotted = toV4(ip);
  if (dotted) return blockedV4(dotted, allowPrivate);
  const bytes = v6Bytes(ip);
  if (!bytes) return null;
  // The same address in IPv6 clothes reaches the same place, however it's written: `[::ffff:7f00:1]` is 127.0.0.1.
  const embedded = embeddedV4(bytes);
  if (embedded) return blockedV4(embedded, allowPrivate);
  if (bytes.every((b, i) => b === (i === 15 ? 1 : 0)) || bytes.every((b) => b === 0)) return 'this machine';
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return 'a link-local address';
  if ((bytes[0]! & 0xfe) === 0xfc) return allowPrivate ? null : 'a private network address';
  if (bytes[0] === 0xff) return 'a multicast address';
  return null;
}

function blockedV4([a, b]: V4, allowPrivate: boolean): string | null {
  if (a === 127 || a === 0) return 'this machine';
  if (a === 169 && b === 254) return 'a link-local address (cloud metadata)';
  if (a >= 224) return 'a multicast or reserved address';
  const isPrivate = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  return isPrivate && !allowPrivate ? 'a private network address' : null;
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

type V4 = [number, number, number, number];

/** IPv4 octets, including the dotted IPv4-mapped form (::ffff:10.0.0.1). */
function toV4(ip: string): V4 | null {
  const m = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(ip);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : null;
}

/** An IPv6 address as its 16 bytes, whichever way it's written; null when it isn't one. */
function v6Bytes(ip: string): number[] | null {
  let text = ip.split('%')[0]!;
  const tail = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail.slice(2).map(Number) as V4;
    text = `${tail[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  if (!isIP(text)) return null;
  const [head, rest] = text.split('::') as [string, string | undefined];
  const left = head ? head.split(':') : [];
  const right = rest ? rest.split(':') : [];
  const zeros = text.includes('::') ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array<string>(zeros).fill('0'), ...right];
  return groups.flatMap((g) => {
    const value = parseInt(g, 16);
    return [value >> 8, value & 0xff];
  });
}

const startsWith = (bytes: number[], prefix: number[]) => prefix.every((b, i) => bytes[i] === b);
const ZEROS_10 = Array<number>(10).fill(0);

/** The IPv4 address inside an IPv6 one: mapped, compatible, NAT64 or 6to4. Each of these can lead back to the v4 network. */
function embeddedV4(bytes: number[]): V4 | null {
  const last = (at: number): V4 => [bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!];
  if (startsWith(bytes, [...ZEROS_10, 0xff, 0xff])) return last(12);
  // `::` and `::1` are themselves, not 0.0.0.0 and 0.0.0.1.
  if (startsWith(bytes, [...ZEROS_10, 0, 0]) && (bytes[12] || bytes[13] || bytes[14]! > 0 || bytes[15]! > 1)) return last(12);
  if (startsWith(bytes, [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0])) return last(12);
  if (startsWith(bytes, [0x20, 0x02])) return last(2);
  return null;
}
