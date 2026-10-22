/**
 * Behind a reverse proxy (ARCHITECTURE §14): `X-Forwarded-*` headers are believed only when the request comes
 * from an address in ATELIER_TRUSTED_PROXIES (IPs or CIDRs). ATELIER_BASE_URL, when set, is the address
 * people use; origin checks and Secure cookies follow it.
 */
import { BlockList, isIP } from 'node:net';

export interface ProxyConfig {
  trusted: BlockList;
  /** The public origin, e.g. `https://atelier.example.ts.net`, or null to take it from the request. */
  baseOrigin: string | null;
}

export function proxyConfig(trustedProxies = '', baseUrl = ''): ProxyConfig {
  const trusted = new BlockList();
  for (const entry of trustedProxies.split(',').map((e) => e.trim()).filter(Boolean)) {
    const [address, prefix] = entry.split('/') as [string, string | undefined];
    const type = isIP(address) === 6 ? 'ipv6' : isIP(address) === 4 ? 'ipv4' : null;
    if (!type) throw new Error(`ATELIER_TRUSTED_PROXIES: "${entry}" is not an IP address or CIDR range.`);
    if (prefix === undefined) trusted.addAddress(address, type);
    else trusted.addSubnet(address, Number(prefix), type);
  }
  return { trusted, baseOrigin: baseUrl ? new URL(baseUrl).origin : null };
}

const isTrusted = (config: ProxyConfig, address: string) => {
  const ip = address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  const type = isIP(ip) === 6 ? 'ipv6' : 'ipv4';
  return isIP(ip) !== 0 && config.trusted.check(ip, type);
};

/** The client's address: the socket's, or, through trusted proxies, the nearest untrusted hop in X-Forwarded-For. */
export function clientIp(config: ProxyConfig, remote: string, forwardedFor: string | undefined): string {
  if (!isTrusted(config, remote) || !forwardedFor) return remote;
  const hops = forwardedFor.split(',').map((h) => h.trim()).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) if (!isTrusted(config, hops[i]!)) return hops[i]!;
  return hops[0] ?? remote;
}

/** The origin the browser used: the base URL, the trusted proxy's X-Forwarded-Proto/Host, or the request's own. */
export function publicOrigin(config: ProxyConfig, request: { url: string; remote: string; header(name: string): string | undefined }): string {
  if (config.baseOrigin) return config.baseOrigin;
  const url = new URL(request.url);
  const host = request.header('host') ?? url.host;
  if (isTrusted(config, request.remote)) {
    const proto = request.header('x-forwarded-proto')?.split(',')[0]?.trim();
    const forwardedHost = request.header('x-forwarded-host')?.split(',')[0]?.trim();
    return `${proto === 'https' || proto === 'http' ? proto : url.protocol.slice(0, -1)}://${forwardedHost || host}`;
  }
  return `${url.protocol}//${host}`;
}

/**
 * What the log says when a browser's Origin is not the address this server believes it has. The usual cause is a
 * reverse proxy it does not trust (ATELIER_TRUSTED_PROXIES), and without a line in the log the page just spins. Said once
 * per origin and sender every ten minutes, so a browser that keeps retrying doesn't fill the log. Null: already said.
 */
export function originRefusal(
  config: ProxyConfig,
  said: Map<string, number>,
  refused: { what: string; origin: string; expected: string; remote: string; now: number },
): string | null {
  const key = `${refused.origin}|${refused.remote}`;
  const before = said.get(key);
  if (before !== undefined && refused.now - before < 600_000) return null;
  said.set(key, refused.now);
  const sender = isTrusted(config, refused.remote) ? 'a trusted proxy' : 'not a trusted proxy';
  const fix = config.baseOrigin
    ? `ATELIER_BASE_URL is ${config.baseOrigin}: set it to ${refused.origin}, or unset it and put the proxy's address in ATELIER_TRUSTED_PROXIES`
    : `if this server is behind a reverse proxy, put ${refused.remote} in ATELIER_TRUSTED_PROXIES, or set ATELIER_BASE_URL to ${refused.origin}`;
  return `Refused ${refused.what}: the browser's address is ${refused.origin}, but this server sees itself at ${refused.expected} (the request came from ${refused.remote}, ${sender}); ${fix}.`;
}
