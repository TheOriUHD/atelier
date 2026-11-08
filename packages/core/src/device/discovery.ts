/** "Found on your network": no mDNS without a dependency, so each private /24 here is asked for `/api/health` on port 7340. */
import type { NetworkInterfaceInfo } from 'node:os';
import { z } from 'zod';

export const DEFAULT_PORT = 7340;

export interface FoundServer {
  /** What "Connect" uses, e.g. `http://192.168.1.20:7340`. */
  url: string;
  /** `192.168.1.20:7340`, or "This computer" for the loopback address. */
  host: string;
  version: string | null;
  name: string | null;
}

export type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

// Tunnels, VPNs, containers and virtual machines: their peers aren't "your network", and probing them is slow or noisy.
const VIRTUAL = /^(lo|utun|tun|tap|wg|ppp|ipsec|gif|stf|awdl|llw|anpi|bridge|docker|br-|veth|virbr|vboxnet|vmnet|zt)|tailscale|zerotier|vethernet|virtualbox|vmware|hyper-v|vpn|wsl/i;

const isPrivate = ([a, b]: number[]) => a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);

/** The first three octets of each private /24 this computer has an address on, at most `limit` of them. */
export function localSubnets(interfaces: Interfaces, limit = 2): string[] {
  const subnets = new Set<string>();
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (VIRTUAL.test(name)) continue;
    for (const address of addresses ?? []) {
      // Node 18.0–18.3 reported the family as a number.
      if (address.internal || (address.family !== 'IPv4' && (address.family as unknown) !== 4)) continue;
      const octets = address.address.split('.').map(Number);
      if (octets.length === 4 && isPrivate(octets)) subnets.add(octets.slice(0, 3).join('.'));
    }
  }
  return [...subnets].slice(0, limit);
}

const Health = z.object({
  ok: z.literal(true),
  app: z.literal('atelier'),
  version: z.string().max(40).optional(),
  name: z.string().max(80).optional(),
});

/** Answers are tiny; anything bigger isn't Atelier's health check. */
const MAX_ANSWER = 2048;

async function probe(fetchFn: typeof fetch, url: string, signal: AbortSignal): Promise<z.infer<typeof Health> | null> {
  try {
    const response = await fetchFn(`${url}/api/health`, { signal, redirect: 'error' });
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > MAX_ANSWER) return null;
    const health = Health.safeParse(JSON.parse(text));
    return health.success ? health.data : null;
  } catch {
    return null;
  }
}

export interface ScanOptions {
  interfaces: Interfaces;
  fetch: typeof fetch;
  onFound?(server: FoundServer): void;
  port?: number;
  /** Per address: a host that exists refuses a closed port at once, and one that doesn't never answers. */
  timeoutMs?: number;
  /** The whole scan. */
  deadlineMs?: number;
  concurrency?: number;
}

/** Finds Atelier servers on the local networks; reports each as it answers and resolves with all of them by the deadline. */
export async function scanNetwork({ interfaces, fetch: fetchFn, onFound, port = DEFAULT_PORT, timeoutMs = 600, deadlineMs = 3000, concurrency = 128 }: ScanOptions): Promise<FoundServer[]> {
  // This computer first: a server started here binds to the loopback address by default.
  const targets = ['127.0.0.1', ...localSubnets(interfaces).flatMap((prefix) => Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`))];
  const deadline = AbortSignal.timeout(deadlineMs);
  const found: FoundServer[] = [];
  let next = 0;
  const worker = async () => {
    while (next < targets.length && !deadline.aborted) {
      const ip = targets[next++]!;
      const url = `http://${ip}:${port}`;
      const health = await probe(fetchFn, url, AbortSignal.any([deadline, AbortSignal.timeout(timeoutMs)]));
      if (!health || deadline.aborted) continue;
      const server = { url, host: ip === '127.0.0.1' ? 'This computer' : `${ip}:${port}`, version: health.version ?? null, name: health.name ?? null };
      found.push(server);
      onFound?.(server);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  return found;
}
